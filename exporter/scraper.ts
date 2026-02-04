import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, Checkpoint, ReplExport } from './types';
import { calculateDuration, extractReplId } from './utils';

const SESSION_FILE = './playwright-session.json';

export class ReplitScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async init(): Promise<void> {
    console.log('Launching browser...');
    this.browser = await chromium.launch({
      headless: false,
    });

    if (fs.existsSync(SESSION_FILE)) {
      console.log('Found existing session, attempting to restore...');
      try {
        const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        this.context = await this.browser.newContext({ storageState });
        console.log('Session restored successfully.');
      } catch (err) {
        console.log('Failed to restore session, creating new context.');
        this.context = await this.browser.newContext();
      }
    } else {
      this.context = await this.browser.newContext();
    }
  }

  async waitForLogin(page?: Page): Promise<void> {
    if (!this.context) throw new Error('Browser not initialized');

    const loginPage = page || await this.context.newPage();
    const shouldClosePage = !page;
    
    // Only navigate if we're not already on a login-related page
    const currentUrl = loginPage.url();
    if (!currentUrl.includes('/login') && !currentUrl.includes('/signup') && !currentUrl.includes('/auth') && !currentUrl.includes('github.com')) {
      await loginPage.goto('https://replit.com/login');
    }

    console.log('\n========================================');
    console.log('Please log in to Replit in the browser window.');
    console.log('The script will continue automatically once you are logged in.');
    console.log('(5 minute timeout)');
    console.log('========================================\n');

    const startTime = Date.now();
    const timeout = 300000; // 5 minutes
    let loginSuccess = false;

    // Poll for login completion instead of using waitForURL
    // This is more resilient to OAuth redirect errors
    while (Date.now() - startTime < timeout && !loginSuccess) {
      try {
        await loginPage.waitForTimeout(2000);
        
        // Check if we're back on Replit (even if there was an error during redirect)
        const currentUrl = loginPage.url();
        const isOnReplit = currentUrl.includes('replit.com');
        const isOnAuthPage = currentUrl.includes('/login') || currentUrl.includes('/signup') || currentUrl.includes('/__/auth');
        const isOnGithub = currentUrl.includes('github.com');
        
        // Check for auth cookies - this is the real indicator of successful login
        const cookies = await this.context.cookies('https://replit.com');
        const hasAuthCookies = cookies.some(c => 
          c.name.includes('connect.sid') || 
          c.name.includes('ajs_user_id') ||
          c.name.includes('replit_authed')
        );
        
        if (hasAuthCookies) {
          console.log('Authentication cookies detected!');
          loginSuccess = true;
          break;
        }
        
        // If we're on Replit but not on auth pages, try to detect login via page content
        if (isOnReplit && !isOnAuthPage && !isOnGithub) {
          // Give cookies a moment to be set
          await loginPage.waitForTimeout(2000);
          
          // Recheck cookies
          const recheckedCookies = await this.context.cookies('https://replit.com');
          const hasAuthCookiesNow = recheckedCookies.some(c => 
            c.name.includes('connect.sid') || 
            c.name.includes('ajs_user_id') ||
            c.name.includes('replit_authed')
          );
          
          if (hasAuthCookiesNow) {
            console.log('Authentication cookies detected after navigation!');
            loginSuccess = true;
            break;
          }
          
          // Check if we can see user-specific elements on the page
          const isLoggedInByContent = await loginPage.evaluate(function() {
            // Look for indicators that user is logged in
            var body = document.body.innerText.toLowerCase();
            var hasUserMenu = document.querySelector('[data-cy="user-menu"]') !== null;
            var hasAvatar = document.querySelector('[class*="Avatar"]') !== null;
            var hasHomepage = body.indexOf('your repls') >= 0 || body.indexOf('my repls') >= 0;
            return hasUserMenu || hasAvatar || hasHomepage;
          });
          
          if (isLoggedInByContent) {
            console.log('Login detected via page content!');
            loginSuccess = true;
            break;
          }
        }
        
        // Log progress
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 10 === 0) {
          process.stdout.write(`\rWaiting for login... (${elapsed}s elapsed, on: ${currentUrl.substring(0, 50)}...)`);
        }
        
      } catch (pollErr) {
        // Ignore errors during polling - page might be navigating
        continue;
      }
    }

    if (loginSuccess) {
      console.log('\nLogin detected! Saving session...');
      
      const storageState = await this.context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);
    } else {
      // Manual fallback - ask user if they completed login
      console.log('\n========================================');
      console.log('Automatic login detection did not complete.');
      console.log('If you have successfully logged in via OAuth, we can still try to continue.');
      console.log('========================================\n');
      
      // Try one more cookie check
      const finalCookies = await this.context.cookies('https://replit.com');
      const hasAnyCookies = finalCookies.length > 0;
      
      if (hasAnyCookies) {
        console.log('Some cookies were set. Attempting to continue anyway...');
        const storageState = await this.context.storageState();
        fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
        console.log(`Session saved to ${SESSION_FILE}`);
        console.log('If scraping fails, please run with --clear-session and try again.');
      } else {
        throw new Error('Failed to detect login. Please try again with --clear-session');
      }
    }

    if (shouldClosePage) {
      await loginPage.close();
    }
  }

  async checkLoggedIn(): Promise<boolean> {
    if (!this.context) throw new Error('Browser not initialized');

    // First, check if we have cookies in our session
    const cookies = await this.context.cookies('https://replit.com');
    const hasAuthCookies = cookies.some(c => 
      c.name.includes('connect.sid') || 
      c.name.includes('replit') ||
      c.name.includes('ajs_user_id')
    );
    
    if (!hasAuthCookies) {
      console.log('No auth cookies found in session.');
      return false;
    }

    // Do a quick check without loading full page - just check if we get redirected
    const page = await this.context.newPage();
    try {
      // Navigate to a lightweight endpoint to check auth status
      const response = await page.goto('https://replit.com/~', { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      // Give a moment for any redirects
      await page.waitForTimeout(1000);
      
      const currentUrl = page.url();
      
      // If we're on login page, we're not logged in
      if (this.isLoginPage(currentUrl)) {
        await page.close();
        return false;
      }
      
      // If we made it to home or dashboard, we're logged in
      await page.close();
      return true;
    } catch {
      await page.close();
      return false;
    }
  }

  private isLoginPage(url: string): boolean {
    return url.includes('/login') || url.includes('/signup') || url.includes('/auth');
  }

  private async handleLoginRedirect(page: Page): Promise<void> {
    const currentUrl = page.url();
    
    if (this.isLoginPage(currentUrl)) {
      console.log('\n⚠️  Redirected to login page. Session may have expired.');
      console.log('Please log in again in the browser window...\n');
      
      // Wait for user to complete login on this page
      await this.waitForLogin(page);
      
      console.log('Login successful! Continuing...\n');
    }
  }

  async scrapeRepl(replUrl: string): Promise<ReplExport> {
    if (!this.context) throw new Error('Browser not initialized');

    const replId = extractReplId(replUrl);
    console.log(`\nScraping: ${replId}`);

    const page = await this.context.newPage();
    
    const fullUrl = replUrl.startsWith('http') ? replUrl : `https://replit.com/${replUrl}`;
    console.log(`Navigating to: ${fullUrl}`);
    
    try {
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (err) {
      console.log('Initial navigation timeout, checking if page loaded...');
    }
    
    await page.waitForTimeout(3000);

    // Check if we got redirected to login
    await this.handleLoginRedirect(page);

    // If we were on login, navigate to the repl again
    const currentUrl = page.url();
    if (!currentUrl.includes(replUrl) && !this.isLoginPage(currentUrl)) {
      // We might be on the homepage after login, navigate to repl
      console.log('Navigating to repl after login...');
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      // Check again for login redirect
      await this.handleLoginRedirect(page);
    }

    // Navigate to Agent tab
    console.log('Looking for Agent tab...');
    await this.navigateToAgentTab(page, fullUrl);

    // Check for login redirect after navigating to agent tab
    await this.handleLoginRedirect(page);

    // Wait for chat content to load
    await page.waitForTimeout(2000);

    // Find the chat container
    const chatContainer = await this.findChatContainer(page);
    
    // Auto-scroll to load full chat history
    console.log('Scrolling to load full chat history...');
    await this.scrollToLoadAll(page, chatContainer);

    // Extract messages and checkpoints
    console.log('Extracting chat data...');
    const { messages, checkpoints } = await this.extractChatData(page);

    // Calculate durations for checkpoints
    for (const cp of checkpoints) {
      cp.durationSeconds = calculateDuration(cp.timestamp, messages);
    }

    // Save session after successful scrape
    try {
      const storageState = await this.context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
    } catch (err) {
      console.log('Note: Could not update session file');
    }

    await page.close();

    const result: ReplExport = {
      replId,
      replUrl: fullUrl,
      exportedAt: new Date().toISOString(),
      messages,
      checkpoints,
    };

    console.log(`Found ${messages.length} messages and ${checkpoints.length} checkpoints`);
    return result;
  }

  private async navigateToAgentTab(page: Page, fullUrl: string): Promise<void> {
    // Try clicking Agent tab with various selectors
    const agentTabSelectors = [
      '[data-testid="agent-tab"]',
      '[data-cy="agent-tab"]',
      'button:has-text("Agent")',
      '[role="tab"]:has-text("Agent")',
      'a:has-text("Agent")',
      '[aria-label*="Agent"]',
    ];

    for (const selector of agentTabSelectors) {
      try {
        const tab = await page.$(selector);
        if (tab) {
          await tab.click();
          console.log('Clicked Agent tab');
          await page.waitForTimeout(2000);
          return;
        }
      } catch {
        continue;
      }
    }

    // Try URL navigation
    if (!fullUrl.includes('tab=agent')) {
      const agentUrl = fullUrl.includes('?') 
        ? `${fullUrl}&tab=agent` 
        : `${fullUrl}?tab=agent`;
      console.log('Trying direct agent URL...');
      try {
        await page.goto(agentUrl, { waitUntil: 'networkidle', timeout: 60000 });
      } catch (err) {
        console.log('Agent URL navigation timeout, checking if page loaded...');
      }
      await page.waitForTimeout(3000);
    }
  }

  private async findChatContainer(page: Page): Promise<string | null> {
    // Look for the scrollable chat container
    const containerSelectors = [
      '[data-testid="agent-chat-container"]',
      '[data-testid="chat-container"]',
      '[data-cy="agent-messages"]',
      '[class*="ChatHistory"]',
      '[class*="chat-history"]',
      '[class*="MessageList"]',
      '[class*="message-list"]',
      '[role="log"]',
      '[class*="ScrollArea"]',
    ];

    for (const selector of containerSelectors) {
      const exists = await page.$(selector);
      if (exists) {
        return selector;
      }
    }

    return null;
  }

  private async scrollToLoadAll(page: Page, containerSelector: string | null): Promise<void> {
    let previousCount = 0;
    let sameCountIterations = 0;
    let loadMoreFailedClicks = 0; // Track clicks that don't add messages
    const maxIterations = 100;
    const maxLoadMoreFailures = 3; // Stop after 3 clicks that don't load more
    const startTime = Date.now();
    const maxTime = 60000; // 60 second maximum for scroll/load phase
    
    for (let i = 0; i < maxIterations; i++) {
      // Check time limit
      if (Date.now() - startTime > maxTime) {
        console.log(`\nReached time limit for loading history (60s)`);
        break;
      }
      // Count current message elements
      const currentCount = await page.evaluate(function() {
        var selectors = [
          '[data-testid*="message"]',
          '[data-cy*="message"]',
          '[class*="ChatMessage"]',
          '[class*="chat-message"]',
          '[class*="UserMessage"]',
          '[class*="AgentMessage"]',
          '[class*="AssistantMessage"]'
        ];
        var count = 0;
        for (var k = 0; k < selectors.length; k++) {
          count += document.querySelectorAll(selectors[k]).length;
        }
        return count;
      });

      // Scroll to top of chat container
      await page.evaluate(function(selector) {
        if (selector) {
          var container = document.querySelector(selector);
          if (container) {
            container.scrollTop = 0;
          }
        }
        // Also try common scroll patterns
        var scrollAreas = document.querySelectorAll('[class*="ScrollArea"], [class*="scroll"], [role="log"]');
        for (var j = 0; j < scrollAreas.length; j++) {
          scrollAreas[j].scrollTop = 0;
        }
      }, containerSelector);

      await page.waitForTimeout(500);

      // Try to click "Show previous messages" or similar buttons
      const clickedLoadMore = await this.clickLoadMoreButton(page);
      if (clickedLoadMore) {
        process.stdout.write(`\rClicked load more button, waiting for new messages...`);
        
        // Wait for new messages to appear by polling
        let loadWaitAttempts = 0;
        const maxLoadWaitAttempts = 10;
        let newCount = currentCount;
        
        while (loadWaitAttempts < maxLoadWaitAttempts) {
          await page.waitForTimeout(500);
          newCount = await page.evaluate(function() {
            var selectors = [
              '[data-testid*="message"]',
              '[data-cy*="message"]',
              '[class*="ChatMessage"]',
              '[class*="chat-message"]',
              '[class*="UserMessage"]',
              '[class*="AgentMessage"]',
              '[class*="AssistantMessage"]'
            ];
            var count = 0;
            for (var k = 0; k < selectors.length; k++) {
              count += document.querySelectorAll(selectors[k]).length;
            }
            return count;
          });
          
          if (newCount > currentCount) {
            process.stdout.write(`\rLoaded ${newCount - currentCount} new messages...`);
            loadMoreFailedClicks = 0; // Reset on success
            break;
          }
          loadWaitAttempts++;
        }
        
        // If clicking didn't load new messages, track the failure
        if (newCount <= currentCount) {
          loadMoreFailedClicks++;
          process.stdout.write(`\rLoad more click ${loadMoreFailedClicks}/${maxLoadMoreFailures} didn't add messages...`);
          if (loadMoreFailedClicks >= maxLoadMoreFailures) {
            console.log(`\nReached beginning of chat (button visible but no new messages after ${maxLoadMoreFailures} attempts)`);
            break;
          }
        }
        
        sameCountIterations = 0;
        previousCount = newCount;
        continue;
      }

      await page.waitForTimeout(300);

      // Check if we loaded new content
      if (currentCount === previousCount) {
        sameCountIterations++;
        if (sameCountIterations >= 5) {
          console.log(`\nReached top of chat history (${currentCount} elements found)`);
          break;
        }
      } else {
        sameCountIterations = 0;
        previousCount = currentCount;
      }
      
      process.stdout.write(`\rScroll iteration ${i + 1}/${maxIterations} (${currentCount} elements)...`);
    }
    console.log('');
    
    // Scroll back to bottom to ensure proper DOM order
    await page.evaluate(function(selector) {
      if (selector) {
        var container = document.querySelector(selector);
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      }
      var scrollAreas = document.querySelectorAll('[class*="ScrollArea"], [class*="scroll"], [role="log"]');
      for (var j = 0; j < scrollAreas.length; j++) {
        scrollAreas[j].scrollTop = scrollAreas[j].scrollHeight;
      }
    }, containerSelector);
    
    await page.waitForTimeout(500);
  }

  private async clickLoadMoreButton(page: Page): Promise<boolean> {
    // Try various selectors for "Show previous messages" or "Load more" buttons
    const loadMoreSelectors = [
      'button:has-text("Show previous")',
      'button:has-text("Load more")',
      'button:has-text("Show earlier")',
      'button:has-text("Previous messages")',
      '[data-testid*="load-more"]',
      '[data-testid*="previous"]',
      '[data-cy*="load-more"]',
      '[class*="LoadMore"]',
      '[class*="load-more"]',
      '[class*="showPrevious"]',
      '[class*="ShowPrevious"]',
    ];

    for (const selector of loadMoreSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isVisible();
          if (isVisible) {
            await button.click();
            return true;
          }
        }
      } catch {
        continue;
      }
    }

    // Also try finding buttons by text content using evaluate
    const clicked = await page.evaluate(function() {
      var buttons = document.querySelectorAll('button, [role="button"], a');
      for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        var text = (btn.textContent || '').toLowerCase();
        if (text.indexOf('show previous') >= 0 || 
            text.indexOf('load more') >= 0 || 
            text.indexOf('earlier') >= 0 ||
            text.indexOf('previous message') >= 0) {
          // Check if visible
          var rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            // Use bracket notation to avoid TS error - click exists on HTMLElements
            if (btn['click']) btn['click']();
            return true;
          }
        }
      }
      return false;
    });

    return clicked;
  }

  private async extractChatData(page: Page): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[] }> {
    const data = await page.evaluate(function() {
      var messages = [];
      var checkpoints = [];

      // Message selectors in order of specificity
      var messageSelectors = [
        '[data-testid="user-message"]',
        '[data-testid="agent-message"]',
        '[data-testid="assistant-message"]',
        '[data-cy="user-message"]',
        '[data-cy="agent-message"]',
        '[class*="UserMessage"]',
        '[class*="AgentMessage"]',
        '[class*="AssistantMessage"]',
        '[class*="ChatMessage"]',
        '[class*="chat-message"]'
      ];

      // Checkpoint selectors
      var checkpointSelectors = [
        '[data-testid="checkpoint"]',
        '[data-testid*="checkpoint"]',
        '[data-cy="checkpoint"]',
        '[class*="Checkpoint"]',
        '[class*="checkpoint"]'
      ];

      // Collect all elements in DOM order
      var allSelectors = messageSelectors.concat(checkpointSelectors).join(', ');
      var allElements = document.querySelectorAll(allSelectors);
      
      var processedTexts = {};
      var index = 0;

      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var text = (el.textContent || '').trim();
        
        // Skip empty or very short text
        if (!text || text.length < 3) continue;
        
        // Skip duplicates
        var textKey = text.substring(0, 200);
        if (processedTexts[textKey]) continue;
        processedTexts[textKey] = true;
        
        var classList = (el.className || '').toLowerCase();
        var testId = (el.getAttribute('data-testid') || '').toLowerCase();
        var dataCy = (el.getAttribute('data-cy') || '').toLowerCase();
        
        // Inline timestamp parsing (no nested function to avoid tsx __name helper)
        var timestamp = null;
        var timeEl = el.querySelector('time, [datetime], [data-timestamp]');
        if (timeEl) {
          var dt = timeEl.getAttribute('datetime') || 
                    timeEl.getAttribute('data-timestamp') ||
                    timeEl.getAttribute('title');
          if (dt) timestamp = dt;
        }
        if (!timestamp) {
          var elText = el.textContent || '';
          var isoMatch = elText.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
          if (isoMatch) timestamp = isoMatch[1];
          else {
            var timeMatch = elText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
            if (timeMatch) timestamp = timeMatch[1];
            else {
              var dateMatch = elText.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
              if (dateMatch) timestamp = dateMatch[1];
            }
          }
        }

        // Detect checkpoint
        var isCheckpoint = 
          classList.indexOf('checkpoint') >= 0 ||
          testId.indexOf('checkpoint') >= 0 ||
          dataCy.indexOf('checkpoint') >= 0;

        if (isCheckpoint) {
          // Extract cost from checkpoint
          var costMatch = text.match(/\$[\d.]+/);
          checkpoints.push({
            timestamp: timestamp,
            description: text.substring(0, 1000),
            cost: costMatch ? costMatch[0] : null,
            durationSeconds: null,
            index: index++
          });
          continue;
        }

        // Detect user vs agent message
        var isUser = 
          classList.indexOf('user') >= 0 ||
          testId.indexOf('user') >= 0 ||
          dataCy.indexOf('user') >= 0 ||
          el.closest('[data-testid="user-message"]') !== null ||
          el.closest('[class*="UserMessage"]') !== null;

        var isAgent = 
          classList.indexOf('agent') >= 0 ||
          classList.indexOf('assistant') >= 0 ||
          testId.indexOf('agent') >= 0 ||
          testId.indexOf('assistant') >= 0 ||
          dataCy.indexOf('agent') >= 0 ||
          dataCy.indexOf('assistant') >= 0 ||
          el.closest('[data-testid="agent-message"]') !== null ||
          el.closest('[class*="AgentMessage"]') !== null ||
          el.closest('[class*="AssistantMessage"]') !== null;

        if (isUser || isAgent) {
          messages.push({
            type: isUser ? 'user' : 'agent',
            content: text.substring(0, 10000),
            timestamp: timestamp,
            index: index++
          });
        }
      }

      // Also try to find checkpoints by looking for cost patterns in the page
      var allText = document.body.innerText;
      var costRegex = /checkpoint[^\$]*(\$[\d.]+)/gi;
      var costMatch2;
      while ((costMatch2 = costRegex.exec(allText)) !== null) {
        var alreadyHasCost = false;
        for (var j = 0; j < checkpoints.length; j++) {
          if (checkpoints[j].cost === costMatch2[1]) {
            alreadyHasCost = true;
            break;
          }
        }
        if (!alreadyHasCost) {
          checkpoints.push({
            timestamp: null,
            description: costMatch2[0].substring(0, 200),
            cost: costMatch2[1],
            durationSeconds: null,
            index: index++
          });
        }
      }

      return { messages: messages, checkpoints: checkpoints };
    });

    return data as { messages: ChatMessage[]; checkpoints: Checkpoint[] };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }

  deleteSession(): void {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      console.log('Session file deleted.');
    }
  }
}

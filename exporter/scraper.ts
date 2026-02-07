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

  async scrapeRepl(replUrl: string, outputDir: string = './exports'): Promise<ReplExport> {
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
    const { messages, checkpoints } = await this.extractChatData(page, outputDir);

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

  private async dumpDomStructure(page: Page, outputDir: string): Promise<void> {
    var domInfo = await page.evaluate(function() {
      var info = { containers: [] as any[], sampleElements: [] as any[], bodyClasses: document.body.getAttribute('class') || '', url: window.location.href };

      var allEls = document.querySelectorAll('div, section, main, article');
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var style = window.getComputedStyle(el);
        var isScrollable = style.overflowY === 'scroll' || style.overflowY === 'auto';
        var childCount = el.children.length;
        if (isScrollable && childCount > 3) {
          var childSamples = [] as any[];
          for (var j = 0; j < Math.min(5, childCount); j++) {
            var child = el.children[j];
            childSamples.push({
              tag: child.tagName,
              className: (child.getAttribute('class') || '').substring(0, 200),
              dataTestId: child.getAttribute('data-testid') || '',
              dataCy: child.getAttribute('data-cy') || '',
              dataEventType: child.getAttribute('data-event-type') || '',
              role: child.getAttribute('role') || '',
              childCount: child.children.length,
              textLength: (child.textContent || '').trim().length,
              textPreview: (child.textContent || '').trim().substring(0, 150),
              outerHTMLPreview: child.outerHTML.substring(0, 500)
            });
          }
          info.containers.push({
            tag: el.tagName,
            className: (el.getAttribute('class') || '').substring(0, 200),
            dataTestId: el.getAttribute('data-testid') || '',
            role: el.getAttribute('role') || '',
            childCount: childCount,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            childSamples: childSamples
          });
        }
      }

      var chatPatterns = [
        '[role="log"]', '[role="list"]', '[role="listitem"]',
        '[data-testid*="message"]', '[data-testid*="chat"]', '[data-testid*="turn"]',
        '[data-cy*="message"]', '[data-event-type]',
        '[class*="Message"]', '[class*="message"]', '[class*="Chat"]', '[class*="chat"]',
        '[class*="EventContainer"]', '[class*="eventContainer"]',
        '[class*="Turn"]', '[class*="turn"]', '[class*="Checkpoint"]', '[class*="checkpoint"]',
        '[class*="Thread"]', '[class*="thread"]', '[class*="Conversation"]'
      ];
      for (var k = 0; k < chatPatterns.length; k++) {
        var matches = document.querySelectorAll(chatPatterns[k]);
        if (matches.length > 0) {
          for (var m = 0; m < Math.min(3, matches.length); m++) {
            info.sampleElements.push({
              selector: chatPatterns[k],
              matchCount: matches.length,
              tag: matches[m].tagName,
              className: (matches[m].getAttribute('class') || '').substring(0, 200),
              dataTestId: matches[m].getAttribute('data-testid') || '',
              dataCy: matches[m].getAttribute('data-cy') || '',
              dataEventType: matches[m].getAttribute('data-event-type') || '',
              role: matches[m].getAttribute('role') || '',
              textPreview: (matches[m].textContent || '').trim().substring(0, 150),
              outerHTMLPreview: matches[m].outerHTML.substring(0, 500)
            });
          }
        }
      }

      return info;
    });

    var debugPath = path.join(outputDir, 'dom-debug.json');
    fs.writeFileSync(debugPath, JSON.stringify(domInfo, null, 2), 'utf-8');
    console.log(`  DOM debug info saved to: ${debugPath}`);
  }

  private async extractChatData(page: Page, outputDir: string = './exports'): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[] }> {
    try {
      await this.dumpDomStructure(page, outputDir);
    } catch (err) {
      console.log('  Note: Could not dump DOM structure for debugging');
    }

    var data = await page.evaluate(function() {
      var messages = [] as any[];
      var checkpoints = [] as any[];
      var index = 0;
      var seenKeys = {} as any;

      // ===== HELPER: safe class string (handles SVG elements with SVGAnimatedString) =====
      // IMPORTANT: This is inlined everywhere it's needed since we can't define functions

      // ===== PRIMARY STRATEGY: Use EventContainer elements =====
      // From DOM debug: Replit uses EventContainer-module__*__eventContainer classes
      // and data-event-type / data-cy attributes for chat messages
      var eventContainers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');

      for (var ei = 0; ei < eventContainers.length; ei++) {
        var evEl = eventContainers[ei];
        var rawText = (evEl.textContent || '').trim();
        if (rawText.length < 5) continue;

        var cleanedText = rawText.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
        cleanedText = cleanedText.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();
        if (cleanedText.length < 5) continue;

        var dedupKey = cleanedText.substring(0, 200);
        if (seenKeys[dedupKey]) continue;
        seenKeys[dedupKey] = true;

        var relTimeMatch = rawText.match(/(\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago)/i);
        var relTimestamp = relTimeMatch ? relTimeMatch[1] : null;
        var isoMatch = rawText.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        var timestamp = isoMatch ? isoMatch[1] : relTimestamp;

        var evClass = (evEl.getAttribute('class') || '').toLowerCase();
        var evEventType = (evEl.getAttribute('data-event-type') || '').toLowerCase();
        var evCy = (evEl.getAttribute('data-cy') || '').toLowerCase();

        // Also check descendant attributes for classification
        var innerUserMarker = evEl.querySelector('[data-cy="user-message"], [data-event-type="user-message"], [class*="userMessage"], [class*="UserMessage"]');
        var innerCheckpointMarker = evEl.querySelector('[class*="checkpoint"], [class*="Checkpoint"], [data-event-type*="checkpoint"]');

        var isCheckpoint = evClass.indexOf('checkpoint') >= 0 ||
          evEventType.indexOf('checkpoint') >= 0 ||
          innerCheckpointMarker !== null ||
          (cleanedText.indexOf('Checkpoint') >= 0 && cleanedText.length < 500);

        if (isCheckpoint) {
          var costMatch = cleanedText.match(/\$[\d.]+/);
          checkpoints.push({
            timestamp: timestamp,
            description: cleanedText.substring(0, 1000),
            cost: costMatch ? costMatch[0] : null,
            durationSeconds: null,
            index: index++
          });
          continue;
        }

        var isUser = evClass.indexOf('usermessage') >= 0 ||
          evClass.indexOf('user-message') >= 0 ||
          evEventType === 'user-message' ||
          evCy === 'user-message' ||
          innerUserMarker !== null;

        var msgType = isUser ? 'user' : 'agent';

        messages.push({
          type: msgType,
          content: cleanedText.substring(0, 10000),
          timestamp: timestamp,
          index: index++
        });
      }

      // ===== FALLBACK STRATEGY: Use broader Message selectors =====
      if (messages.length < 3) {
        var broadSelectors = [
          '[data-cy*="message"]',
          '[data-event-type*="message"]',
          '[class*="Message"][class*="module"]',
          '[data-testid*="message"]',
          '[data-testid*="chat"]',
          '[role="listitem"]',
          '[role="article"]'
        ];

        var selectorStr = broadSelectors.join(', ');
        var selectorEls = document.querySelectorAll(selectorStr);

        for (var bi = 0; bi < selectorEls.length; bi++) {
          var bEl = selectorEls[bi];
          var bRaw = (bEl.textContent || '').trim();

          var bClean = bRaw.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
          bClean = bClean.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();
          if (bClean.length < 5) continue;

          var bKey = bClean.substring(0, 200);
          if (seenKeys[bKey]) continue;
          seenKeys[bKey] = true;

          var bRelTime = bRaw.match(/(\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago)/i);
          var bTimestamp = bRelTime ? bRelTime[1] : null;
          var bIso = bRaw.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
          if (bIso) bTimestamp = bIso[1];

          var bClass = (bEl.getAttribute('class') || '').toLowerCase();
          var bCy = (bEl.getAttribute('data-cy') || '').toLowerCase();
          var bEvType = (bEl.getAttribute('data-event-type') || '').toLowerCase();

          var bUserMarker = bEl.querySelector('[data-cy="user-message"], [data-event-type="user-message"], [class*="userMessage"], [class*="UserMessage"]');

          var bIsUser = bClass.indexOf('usermessage') >= 0 ||
            bClass.indexOf('user-message') >= 0 ||
            bCy.indexOf('user') >= 0 ||
            bEvType === 'user-message' ||
            bUserMarker !== null;

          var bType = bIsUser ? 'user' : 'agent';

          messages.push({
            type: bType,
            content: bClean.substring(0, 10000),
            timestamp: bTimestamp,
            index: index++
          });
        }
      }

      // ===== DEDUPLICATION PASS =====
      var deduped = [] as any[];
      for (var d1 = 0; d1 < messages.length; d1++) {
        var isDuplicate = false;
        var m1 = messages[d1].content;
        for (var d2 = 0; d2 < messages.length; d2++) {
          if (d1 === d2) continue;
          var m2 = messages[d2].content;
          if (m2.length > m1.length && m2.indexOf(m1) >= 0) {
            isDuplicate = true;
            break;
          }
          if (m1 === m2 && d1 > d2) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          deduped.push(messages[d1]);
        }
      }

      for (var ri = 0; ri < deduped.length; ri++) {
        deduped[ri].index = ri;
      }

      // ===== CHECKPOINT DETECTION FROM FULL PAGE =====
      var bodyText = document.body.innerText || '';
      var cpRegex = /(?:checkpoint|saved|deployed|created)[^$\n]{0,100}\$(\d+\.?\d*)/gi;
      var cpMatch;
      while ((cpMatch = cpRegex.exec(bodyText)) !== null) {
        var cpCost = '$' + cpMatch[1];
        var cpAlready = false;
        for (var cpj = 0; cpj < checkpoints.length; cpj++) {
          if (checkpoints[cpj].cost === cpCost) {
            cpAlready = true;
            break;
          }
        }
        if (!cpAlready) {
          checkpoints.push({
            timestamp: null,
            description: cpMatch[0].substring(0, 200),
            cost: cpCost,
            durationSeconds: null,
            index: deduped.length + checkpoints.length
          });
        }
      }

      return { messages: deduped, checkpoints: checkpoints };
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

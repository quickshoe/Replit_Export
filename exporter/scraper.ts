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
    if (!currentUrl.includes('/login') && !currentUrl.includes('/signup')) {
      await loginPage.goto('https://replit.com/login');
    }

    console.log('\n========================================');
    console.log('Please log in to Replit in the browser window.');
    console.log('The script will continue automatically once you are logged in.');
    console.log('(5 minute timeout)');
    console.log('========================================\n');

    try {
      await loginPage.waitForURL((url) => {
        const urlPath = url.pathname;
        return !urlPath.includes('/login') && !urlPath.includes('/signup');
      }, { timeout: 300000 });

      await loginPage.waitForTimeout(2000);

      console.log('Login detected! Saving session...');
      
      const storageState = await this.context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);

    } catch (err) {
      console.error('Login timeout or error:', err);
      throw new Error('Failed to detect login. Please try again.');
    }

    if (shouldClosePage) {
      await loginPage.close();
    }
  }

  async checkLoggedIn(): Promise<boolean> {
    if (!this.context) throw new Error('Browser not initialized');

    const page = await this.context.newPage();
    try {
      await page.goto('https://replit.com/', { waitUntil: 'networkidle' });
      
      const currentUrl = page.url();
      // If redirected to login, we're not logged in
      if (currentUrl.includes('/login') || currentUrl.includes('/signup')) {
        await page.close();
        return false;
      }
      
      const isLoggedIn = await page.evaluate(() => {
        const hasAvatar = !!document.querySelector('[data-cy="user-menu"]') || 
                         !!document.querySelector('[data-testid="user-menu"]') ||
                         !!document.querySelector('button[aria-label*="user"]') ||
                         !!document.querySelector('[class*="Avatar"]');
        const hasCreateButton = !!document.querySelector('button:has-text("Create Repl")') ||
                               !!document.querySelector('[data-cy="create-repl-button"]');
        return hasAvatar || hasCreateButton;
      });

      await page.close();
      return isLoggedIn;
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
    const maxIterations = 100;
    
    for (let i = 0; i < maxIterations; i++) {
      // Count current message elements
      const currentCount = await page.evaluate(() => {
        const selectors = [
          '[data-testid*="message"]',
          '[data-cy*="message"]',
          '[class*="ChatMessage"]',
          '[class*="chat-message"]',
          '[class*="UserMessage"]',
          '[class*="AgentMessage"]',
          '[class*="AssistantMessage"]',
        ];
        let count = 0;
        for (const sel of selectors) {
          count += document.querySelectorAll(sel).length;
        }
        return count;
      });

      // Scroll to top of chat container
      await page.evaluate((selector) => {
        if (selector) {
          const container = document.querySelector(selector);
          if (container) {
            container.scrollTop = 0;
          }
        }
        // Also try common scroll patterns
        const scrollAreas = document.querySelectorAll('[class*="ScrollArea"], [class*="scroll"], [role="log"]');
        scrollAreas.forEach(el => {
          (el as HTMLElement).scrollTop = 0;
        });
      }, containerSelector);

      await page.waitForTimeout(800);

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
    await page.evaluate((selector) => {
      if (selector) {
        const container = document.querySelector(selector);
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      }
      const scrollAreas = document.querySelectorAll('[class*="ScrollArea"], [class*="scroll"], [role="log"]');
      scrollAreas.forEach(el => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
      });
    }, containerSelector);
    
    await page.waitForTimeout(500);
  }

  private async extractChatData(page: Page): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[] }> {
    const data = await page.evaluate(function() {
      var messages: any[] = [];
      var checkpoints: any[] = [];

      // Helper to parse timestamps from various formats
      function parseTimestamp(el: Element): string | null {
        // Look for time elements
        var timeEl = el.querySelector('time, [datetime], [data-timestamp]');
        if (timeEl) {
          var dt = timeEl.getAttribute('datetime') || 
                    timeEl.getAttribute('data-timestamp') ||
                    timeEl.getAttribute('title');
          if (dt) return dt;
        }
        
        // Look for timestamp in text
        var text = el.textContent || '';
        var isoMatch = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (isoMatch) return isoMatch[1];
        var timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
        if (timeMatch) return timeMatch[1];
        var dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        if (dateMatch) return dateMatch[1];
        
        return null;
      }

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
      
      var processedTexts: {[key: string]: boolean} = {};
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
        
        var classList = ((el as HTMLElement).className || '').toLowerCase();
        var testId = (el.getAttribute('data-testid') || '').toLowerCase();
        var dataCy = (el.getAttribute('data-cy') || '').toLowerCase();
        
        var timestamp = parseTimestamp(el);

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

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

  async waitForLogin(): Promise<void> {
    if (!this.context) throw new Error('Browser not initialized');

    const page = await this.context.newPage();
    await page.goto('https://replit.com/login');

    console.log('\n========================================');
    console.log('Please log in to Replit in the browser window.');
    console.log('The script will continue automatically once you are logged in.');
    console.log('========================================\n');

    try {
      await page.waitForURL((url) => {
        const path = url.pathname;
        return !path.includes('/login') && !path.includes('/signup');
      }, { timeout: 300000 });

      await page.waitForTimeout(2000);

      console.log('Login detected! Saving session...');
      
      const storageState = await this.context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);

    } catch (err) {
      console.error('Login timeout or error:', err);
      throw new Error('Failed to detect login. Please try again.');
    }

    await page.close();
  }

  async checkLoggedIn(): Promise<boolean> {
    if (!this.context) throw new Error('Browser not initialized');

    const page = await this.context.newPage();
    try {
      await page.goto('https://replit.com/', { waitUntil: 'networkidle' });
      
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

  async scrapeRepl(replUrl: string): Promise<ReplExport> {
    if (!this.context) throw new Error('Browser not initialized');

    const replId = extractReplId(replUrl);
    console.log(`\nScraping: ${replId}`);

    const page = await this.context.newPage();
    
    const fullUrl = replUrl.startsWith('http') ? replUrl : `https://replit.com/${replUrl}`;
    console.log(`Navigating to: ${fullUrl}`);
    
    await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Navigate to Agent tab
    console.log('Looking for Agent tab...');
    await this.navigateToAgentTab(page, fullUrl);

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
      await page.goto(agentUrl, { waitUntil: 'networkidle', timeout: 60000 });
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
    const data = await page.evaluate(() => {
      const messages: any[] = [];
      const checkpoints: any[] = [];

      // Helper to parse timestamps from various formats
      const parseTimestamp = (el: Element): string | null => {
        // Look for time elements
        const timeEl = el.querySelector('time, [datetime], [data-timestamp]');
        if (timeEl) {
          const dt = timeEl.getAttribute('datetime') || 
                    timeEl.getAttribute('data-timestamp') ||
                    timeEl.getAttribute('title');
          if (dt) return dt;
        }
        
        // Look for timestamp in text
        const timestampPatterns = [
          /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
          /(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
          /(\d{1,2}\/\d{1,2}\/\d{2,4})/,
        ];
        
        const text = el.textContent || '';
        for (const pattern of timestampPatterns) {
          const match = text.match(pattern);
          if (match) return match[1];
        }
        
        return null;
      };

      // Message selectors in order of specificity
      const messageSelectors = [
        '[data-testid="user-message"]',
        '[data-testid="agent-message"]',
        '[data-testid="assistant-message"]',
        '[data-cy="user-message"]',
        '[data-cy="agent-message"]',
        '[class*="UserMessage"]',
        '[class*="AgentMessage"]',
        '[class*="AssistantMessage"]',
        '[class*="ChatMessage"]',
        '[class*="chat-message"]',
      ];

      // Checkpoint selectors
      const checkpointSelectors = [
        '[data-testid="checkpoint"]',
        '[data-testid*="checkpoint"]',
        '[data-cy="checkpoint"]',
        '[class*="Checkpoint"]',
        '[class*="checkpoint"]',
      ];

      // Collect all elements in DOM order
      const allSelectors = [...messageSelectors, ...checkpointSelectors].join(', ');
      const allElements = document.querySelectorAll(allSelectors);
      
      const processedTexts = new Set<string>();
      let index = 0;

      allElements.forEach((el) => {
        const text = (el.textContent || '').trim();
        
        // Skip empty or very short text
        if (!text || text.length < 3) return;
        
        // Skip duplicates
        const textKey = text.substring(0, 200);
        if (processedTexts.has(textKey)) return;
        processedTexts.add(textKey);
        
        const classList = (el.className || '').toLowerCase();
        const testId = (el.getAttribute('data-testid') || '').toLowerCase();
        const dataCy = (el.getAttribute('data-cy') || '').toLowerCase();
        
        const timestamp = parseTimestamp(el);

        // Detect checkpoint
        const isCheckpoint = 
          classList.includes('checkpoint') ||
          testId.includes('checkpoint') ||
          dataCy.includes('checkpoint');

        if (isCheckpoint) {
          // Extract cost from checkpoint
          const costMatch = text.match(/\$[\d.]+/);
          checkpoints.push({
            timestamp,
            description: text.substring(0, 1000),
            cost: costMatch ? costMatch[0] : null,
            durationSeconds: null,
            index: index++,
          });
          return;
        }

        // Detect user vs agent message
        const isUser = 
          classList.includes('user') ||
          testId.includes('user') ||
          dataCy.includes('user') ||
          el.closest('[data-testid="user-message"]') !== null ||
          el.closest('[class*="UserMessage"]') !== null;

        const isAgent = 
          classList.includes('agent') ||
          classList.includes('assistant') ||
          testId.includes('agent') ||
          testId.includes('assistant') ||
          dataCy.includes('agent') ||
          dataCy.includes('assistant') ||
          el.closest('[data-testid="agent-message"]') !== null ||
          el.closest('[class*="AgentMessage"]') !== null ||
          el.closest('[class*="AssistantMessage"]') !== null;

        if (isUser || isAgent) {
          messages.push({
            type: isUser ? 'user' : 'agent',
            content: text.substring(0, 10000),
            timestamp,
            index: index++,
          });
        }
      });

      // Also try to find checkpoints by looking for cost patterns in the page
      const allText = document.body.innerText;
      const costMatches = allText.matchAll(/checkpoint[^\$]*(\$[\d.]+)/gi);
      for (const match of costMatches) {
        const alreadyHasCost = checkpoints.some(cp => cp.cost === match[1]);
        if (!alreadyHasCost) {
          checkpoints.push({
            timestamp: null,
            description: match[0].substring(0, 200),
            cost: match[1],
            durationSeconds: null,
            index: index++,
          });
        }
      }

      return { messages, checkpoints };
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

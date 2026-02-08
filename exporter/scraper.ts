import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, Checkpoint, WorkEntry, AgentUsageDetail, ReplExport } from './types';
import { calculateDuration, extractReplName } from './utils';

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
    const timeout = 300000;
    let loginSuccess = false;

    while (Date.now() - startTime < timeout && !loginSuccess) {
      try {
        await loginPage.waitForTimeout(2000);
        
        const currentUrl = loginPage.url();
        const isOnReplit = currentUrl.includes('replit.com');
        const isOnAuthPage = currentUrl.includes('/login') || currentUrl.includes('/signup') || currentUrl.includes('/__/auth');
        const isOnGithub = currentUrl.includes('github.com');
        
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
        
        if (isOnReplit && !isOnAuthPage && !isOnGithub) {
          await loginPage.waitForTimeout(2000);
          
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
          
          const isLoggedInByContent = await loginPage.evaluate(function() {
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
        
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 10 === 0) {
          process.stdout.write(`\rWaiting for login... (${elapsed}s elapsed, on: ${currentUrl.substring(0, 50)}...)`);
        }
        
      } catch (pollErr) {
        continue;
      }
    }

    if (loginSuccess) {
      console.log('\nLogin detected! Saving session...');
      
      const storageState = await this.context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);
    } else {
      console.log('\n========================================');
      console.log('Automatic login detection did not complete.');
      console.log('If you have successfully logged in via OAuth, we can still try to continue.');
      console.log('========================================\n');
      
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

    const page = await this.context.newPage();
    try {
      const response = await page.goto('https://replit.com/~', { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      await page.waitForTimeout(1000);
      
      const currentUrl = page.url();
      
      if (this.isLoginPage(currentUrl)) {
        await page.close();
        return false;
      }
      
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
      console.log('\n  Redirected to login page. Session may have expired.');
      console.log('Please log in again in the browser window...\n');
      
      await this.waitForLogin(page);
      
      console.log('Login successful! Continuing...\n');
    }
  }

  async scrapeRepl(replUrl: string, outputDir: string = './exports'): Promise<ReplExport> {
    if (!this.context) throw new Error('Browser not initialized');

    const replName = extractReplName(replUrl);
    console.log(`\nScraping: ${replName}`);

    const page = await this.context.newPage();
    
    const fullUrl = replUrl.startsWith('http') ? replUrl : `https://replit.com/${replUrl}`;
    console.log(`Navigating to: ${fullUrl}`);
    
    try {
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (err) {
      console.log('Initial navigation timeout, checking if page loaded...');
    }
    
    await page.waitForTimeout(3000);

    await this.handleLoginRedirect(page);

    const currentUrl = page.url();
    if (!currentUrl.includes(replUrl) && !this.isLoginPage(currentUrl)) {
      console.log('Navigating to repl after login...');
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      await this.handleLoginRedirect(page);
    }

    await page.waitForTimeout(2000);

    const chatContainer = await this.findChatContainer(page);
    
    console.log('Scrolling to load full chat history...');
    await this.scrollToLoadAll(page, chatContainer);

    console.log('Expanding collapsed sections...');
    await this.expandAllCollapsedSections(page);

    console.log('Extracting chat data...');
    const { messages, checkpoints, workEntries } = await this.extractChatData(page, outputDir);

    for (const cp of checkpoints) {
      cp.durationSeconds = calculateDuration(cp.timestamp, messages);
    }

    try {
      const storageState = await this.context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
    } catch (err) {
      console.log('Note: Could not update session file');
    }

    await page.close();

    const result: ReplExport = {
      replName,
      replUrl: fullUrl,
      exportedAt: new Date().toISOString(),
      messages,
      checkpoints,
      workEntries,
    };

    console.log(`Found ${messages.length} messages, ${checkpoints.length} checkpoints, and ${workEntries.length} work entries`);
    return result;
  }

  private async expandAllCollapsedSections(page: Page): Promise<void> {
    var expandedCount = 0;
    var maxRounds = 5;

    for (var round = 0; round < maxRounds; round++) {
      var buttonsClicked = await page.evaluate(function() {
        var clicked = 0;
        var expandButtons = document.querySelectorAll('[class*="ExpandableFeedContent"], [class*="expandableButton"]');
        for (var i = 0; i < expandButtons.length; i++) {
          var btn = expandButtons[i];
          var ariaExpanded = btn.getAttribute('aria-expanded');
          if (ariaExpanded === 'false' || ariaExpanded === null) {
            var rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              if (btn['click']) btn['click']();
              clicked++;
            }
          }
        }

        var allButtons = document.querySelectorAll('button');
        for (var j = 0; j < allButtons.length; j++) {
          var b = allButtons[j];
          var cls = b.getAttribute('class') || '';
          if (cls.indexOf('expandable') >= 0 || cls.indexOf('Expandable') >= 0) {
            var bExpanded = b.getAttribute('aria-expanded');
            if (bExpanded === 'false' || bExpanded === null) {
              var bRect = b.getBoundingClientRect();
              if (bRect.width > 0 && bRect.height > 0) {
                var alreadyCounted = false;
                for (var k = 0; k < expandButtons.length; k++) {
                  if (expandButtons[k] === b) { alreadyCounted = true; break; }
                }
                if (!alreadyCounted) {
                  if (b['click']) b['click']();
                  clicked++;
                }
              }
            }
          }
        }
        return clicked;
      });

      if (buttonsClicked === 0) break;

      expandedCount += buttonsClicked;
      process.stdout.write(`\r  Expanded ${expandedCount} sections (round ${round + 1})...`);
      await page.waitForTimeout(1500);
    }

    if (expandedCount > 0) {
      console.log(`\n  Expanded ${expandedCount} collapsed sections`);
    }

    await page.waitForTimeout(1000);

    console.log('  Expanding Agent Usage chevrons...');
    var agentUsageExpanded = 0;
    for (var auRound = 0; auRound < 3; auRound++) {
      var auClicked = await page.evaluate(function() {
        var clicked = 0;

        var allEls = document.querySelectorAll('button, [role="button"], div[class*="expandable"], div[class*="Expandable"], summary, details');
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          var text = (el.textContent || '').trim();
          if (text.indexOf('Agent Usage') >= 0 && text.length < 100) {
            var ariaExp = el.getAttribute('aria-expanded');
            if (ariaExp === 'false' || ariaExp === null) {
              var rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                if (el['click']) el['click']();
                clicked++;
              }
            }
          }
        }

        var chevrons = document.querySelectorAll('[class*="EndOfRunSummary"] button, [class*="EndOfRunSummary"] [role="button"], [class*="endOfRun"] button');
        for (var j = 0; j < chevrons.length; j++) {
          var ch = chevrons[j];
          var chText = (ch.textContent || '').trim();
          if (chText.indexOf('$') >= 0 || chText.indexOf('Agent') >= 0 || chText.indexOf('Usage') >= 0) {
            var chExp = ch.getAttribute('aria-expanded');
            if (chExp === 'false' || chExp === null) {
              var chRect = ch.getBoundingClientRect();
              if (chRect.width > 0 && chRect.height > 0) {
                if (ch['click']) ch['click']();
                clicked++;
              }
            }
          }
        }

        return clicked;
      });

      if (auClicked === 0) break;
      agentUsageExpanded += auClicked;
      await page.waitForTimeout(1500);
    }

    if (agentUsageExpanded > 0) {
      console.log(`  Expanded ${agentUsageExpanded} Agent Usage sections`);
    } else {
      console.log('  No Agent Usage chevrons found to expand');
    }

    await page.waitForTimeout(1000);

    console.log('  Expanding checkpoint details...');
    var checkpointExpanded = 0;
    for (var cpRound = 0; cpRound < 3; cpRound++) {
      var cpClicked = await page.evaluate(function() {
        var clicked = 0;
        var allEls = document.querySelectorAll('button, [role="button"], summary, details, [class*="expandable"], [class*="Expandable"]');
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          var text = (el.textContent || '').trim();
          if (text.indexOf('Checkpoint made') >= 0 || text.indexOf('checkpoint made') >= 0) {
            var ariaExp = el.getAttribute('aria-expanded');
            if (ariaExp === 'false' || ariaExp === null) {
              var rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                if (el['click']) el['click']();
                clicked++;
              }
            }
          }
        }
        return clicked;
      });

      if (cpClicked === 0) break;
      checkpointExpanded += cpClicked;
      await page.waitForTimeout(1500);
    }

    if (checkpointExpanded > 0) {
      console.log(`  Expanded ${checkpointExpanded} checkpoint sections`);
    } else {
      console.log('  No checkpoint sections found to expand');
    }

    await page.waitForTimeout(1000);
  }

  private async findChatContainer(page: Page): Promise<string | null> {
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
    let loadMoreFailedClicks = 0;
    const maxIterations = 100;
    const maxLoadMoreFailures = 3;
    const startTime = Date.now();
    const maxTime = 60000;
    
    for (let i = 0; i < maxIterations; i++) {
      if (Date.now() - startTime > maxTime) {
        console.log(`\nReached time limit for loading history (60s)`);
        break;
      }
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

      await page.evaluate(function(selector) {
        if (selector) {
          var container = document.querySelector(selector);
          if (container) {
            container.scrollTop = 0;
          }
        }
        var scrollAreas = document.querySelectorAll('[class*="ScrollArea"], [class*="scroll"], [role="log"]');
        for (var j = 0; j < scrollAreas.length; j++) {
          scrollAreas[j].scrollTop = 0;
        }
      }, containerSelector);

      await page.waitForTimeout(500);

      const clickedLoadMore = await this.clickLoadMoreButton(page);
      if (clickedLoadMore) {
        process.stdout.write(`\rClicked load more button, waiting for new messages...`);
        
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
            loadMoreFailedClicks = 0;
            break;
          }
          loadWaitAttempts++;
        }
        
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

    const clicked = await page.evaluate(function() {
      var buttons = document.querySelectorAll('button, [role="button"], a');
      for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        var text = (btn.textContent || '').toLowerCase();
        if (text.indexOf('show previous') >= 0 || 
            text.indexOf('load more') >= 0 || 
            text.indexOf('earlier') >= 0 ||
            text.indexOf('previous message') >= 0) {
          var rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
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

  private async extractChatData(page: Page, outputDir: string = './exports'): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[]; workEntries: WorkEntry[] }> {
    try {
      await this.dumpDomStructure(page, outputDir);
    } catch (err) {
      console.log('  Note: Could not dump DOM structure for debugging');
    }

    var data = await page.evaluate(function() {
      var messages = [] as any[];
      var checkpoints = [] as any[];
      var workEntries = [] as any[];
      var index = 0;
      var seenKeys = {} as any;

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

        var innerUserMarker = evEl.querySelector('[data-cy="user-message"], [data-event-type="user-message"], [class*="userMessage"], [class*="UserMessage"]');
        var innerCheckpointMarker = evEl.querySelector('[class*="checkpoint"], [class*="Checkpoint"], [data-event-type*="checkpoint"]');

        // ===== WORK ENTRY DETECTION: EndOfRunSummary "Worked for X" =====
        var endOfRunRoot = evEl.querySelector('[class*="EndOfRunSummary"]');
        if (!endOfRunRoot) {
          var ownClass = evEl.getAttribute('class') || '';
          if (ownClass.indexOf('EndOfRunSummary') >= 0) {
            endOfRunRoot = evEl;
          }
        }

        var workedMatch = rawText.match(/Worked\s+for\s+(\d+\s*(?:second|minute|hour|day|week|month|year)s?(?:\s*(?:and\s*)?\d+\s*(?:second|minute|hour|day|week|month|year)s?)*)/i);

        if (endOfRunRoot || workedMatch) {
          var wDuration = workedMatch ? workedMatch[1] : '';
          var wDurationSecs = 0 as any;

          if (wDuration) {
            var durParts = wDuration.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?/gi);
            if (durParts) {
              for (var dp = 0; dp < durParts.length; dp++) {
                var durMatch = durParts[dp].match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
                if (durMatch) {
                  var durVal = parseInt(durMatch[1], 10);
                  var durUnit = durMatch[2].toLowerCase();
                  if (durUnit === 'second') wDurationSecs += durVal;
                  else if (durUnit === 'minute') wDurationSecs += durVal * 60;
                  else if (durUnit === 'hour') wDurationSecs += durVal * 3600;
                  else if (durUnit === 'day') wDurationSecs += durVal * 86400;
                }
              }
            }
          }

          // Parse structured fields from the expanded content
          var actionsMatch = rawText.match(/(\d+)\s*actions?/i);
          var workDoneActions = actionsMatch ? parseInt(actionsMatch[1], 10) : null;

          var itemsMatch = rawText.match(/(\d+)\s*lines/i);
          var itemsReadLines = itemsMatch ? parseInt(itemsMatch[1], 10) : null;

          var codePlusMatch = rawText.match(/\+(\d+)/);
          var codeMinusMatch = rawText.match(/-(\d+)/);
          var codeChangedPlus = codePlusMatch ? parseInt(codePlusMatch[1], 10) : null;
          var codeChangedMinus = codeMinusMatch ? parseInt(codeMinusMatch[1], 10) : null;

          // Extract agent usage total (first dollar amount, or from "Agent Usage" line)
          var totalCharge = null as any;
          var costMatches = rawText.match(/\$[\d.]+/g);
          if (costMatches && costMatches.length > 0) {
            totalCharge = parseFloat(costMatches[0].substring(1));
            if (isNaN(totalCharge)) totalCharge = null;
          }

          // Extract individual charge line items from expanded Agent Usage section
          var chargeDetails = [] as any[];
          var searchRoot = endOfRunRoot || evEl;

          // Look for expanded Agent Usage sub-section
          // After expanding Agent Usage chevron, individual items appear as label + $amount pairs
          var allTextNodes = searchRoot.querySelectorAll('span, div, p, li');
          var prevLabel = '';
          var insideAgentUsage = false;
          for (var tn = 0; tn < allTextNodes.length; tn++) {
            var nodeText = (allTextNodes[tn].textContent || '').trim();

            // Detect when we enter Agent Usage section
            if (nodeText === 'Agent Usage' || (nodeText.indexOf('Agent Usage') >= 0 && nodeText.length < 30)) {
              insideAgentUsage = true;
              prevLabel = '';
              continue;
            }

            if (insideAgentUsage) {
              var chargeMatch = nodeText.match(/^\$([\d.]+)$/);
              if (chargeMatch && prevLabel) {
                var labelClean = prevLabel.replace(/\s+/g, ' ').trim();
                // Skip labels that are just the total or agent usage header
                if (labelClean.toLowerCase() !== 'agent usage' && labelClean.toLowerCase() !== 'total') {
                  var chargeVal = parseFloat(chargeMatch[1]);
                  if (!isNaN(chargeVal)) {
                    chargeDetails.push({
                      label: labelClean,
                      amount: chargeVal
                    });
                  }
                }
              }
              if (nodeText.length > 0 && nodeText.length < 200 && !nodeText.match(/^\$[\d.]+$/)) {
                prevLabel = nodeText;
              }
            }
          }

          // Fallback: if no Agent Usage section found, try generic label+amount scanning
          if (chargeDetails.length === 0) {
            prevLabel = '';
            for (var tn2 = 0; tn2 < allTextNodes.length; tn2++) {
              var nodeText2 = (allTextNodes[tn2].textContent || '').trim();
              var chargeMatch2 = nodeText2.match(/^\$([\d.]+)$/);
              if (chargeMatch2 && prevLabel) {
                var labelClean2 = prevLabel.replace(/\s+/g, ' ').trim();
                if (labelClean2.toLowerCase() !== 'agent usage' &&
                    labelClean2.indexOf('Worked for') < 0 &&
                    labelClean2.indexOf('Time worked') < 0 &&
                    labelClean2.indexOf('Work done') < 0 &&
                    labelClean2.indexOf('Items read') < 0 &&
                    labelClean2.indexOf('Code changed') < 0) {
                  var chargeVal2 = parseFloat(chargeMatch2[1]);
                  if (!isNaN(chargeVal2)) {
                    chargeDetails.push({
                      label: labelClean2,
                      amount: chargeVal2
                    });
                  }
                }
              }
              if (nodeText2.length > 0 && nodeText2.length < 200 && !nodeText2.match(/^\$[\d.]+$/)) {
                prevLabel = nodeText2;
              }
            }
          }

          workEntries.push({
            timestamp: timestamp,
            timeWorked: wDuration || '',
            durationSeconds: wDurationSecs > 0 ? wDurationSecs : null,
            workDoneActions: workDoneActions,
            itemsReadLines: itemsReadLines,
            codeChangedPlus: codeChangedPlus,
            codeChangedMinus: codeChangedMinus,
            agentUsage: totalCharge,
            chargeDetails: chargeDetails,
            index: index++
          });

          continue;
        }

        // ===== CHECKPOINT DETECTION =====
        var isCheckpoint = evClass.indexOf('checkpoint') >= 0 ||
          evEventType.indexOf('checkpoint') >= 0 ||
          innerCheckpointMarker !== null ||
          (cleanedText.indexOf('Checkpoint') >= 0 && cleanedText.length < 500);

        if (isCheckpoint) {
          // Extract real timestamp from expanded checkpoint content
          // Pattern: "3:49 pm, Feb 03, 2026" or "7:03 am, Feb 04, 2026"
          var realTimestampMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
          var cpTimestamp = realTimestampMatch ? realTimestampMatch[1] : timestamp;

          // Extract the description - get the line after "Checkpoint made X ago"
          var cpDescription = '';
          var cpDescMatch = rawText.match(/Checkpoint\s+made[\s\S]*?ago\s*([\s\S]*?)(?:\d{1,2}:\d{2}\s*(?:am|pm)|\s*Rollback|\s*Preview|\s*Changes|$)/i);
          if (cpDescMatch && cpDescMatch[1]) {
            cpDescription = cpDescMatch[1].trim();
          }
          if (!cpDescription) {
            // Try to get just the meaningful part: between "ago" and timestamp/Rollback
            cpDescription = cleanedText
              .replace(/Checkpoint\s+made\s*.*?ago\s*/i, '')
              .replace(/\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4}/i, '')
              .replace(/Rollback\s+here/i, '')
              .replace(/Preview/i, '')
              .replace(/Changes/i, '')
              .trim();
          }

          var costMatch = rawText.match(/\$[\d.]+/);
          checkpoints.push({
            timestamp: cpTimestamp,
            description: cpDescription.substring(0, 1000),
            cost: costMatch ? costMatch[0] : null,
            durationSeconds: null,
            index: index++
          });
          continue;
        }

        // ===== MESSAGE CLASSIFICATION =====
        // Skip noise messages
        if (cleanedText.match(/^Worked\s+for\s+/i)) continue;
        if (cleanedText.match(/^Decided\s+on\s+/i) && cleanedText.length < 100) continue;
        if (cleanedText.match(/^\d+\s+actions?\s*$/i)) continue;
        if (cleanedText.match(/^Created task list\s*$/i)) continue;
        if (cleanedText.match(/^Ready to share\?\s*Publish/i)) continue;

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

      // ===== FALLBACK STRATEGY =====
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

      return { messages: deduped, checkpoints: checkpoints, workEntries: workEntries };
    });

    return data as { messages: ChatMessage[]; checkpoints: Checkpoint[]; workEntries: WorkEntry[] };
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

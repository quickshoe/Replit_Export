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
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('Page DOM loaded successfully.');
    } catch (err) {
      console.log('Navigation timeout on domcontentloaded, continuing anyway...');
    }
    
    console.log('Waiting for page to settle...');
    await page.waitForTimeout(5000);

    await this.handleLoginRedirect(page);

    const currentUrl = page.url();
    if (!currentUrl.includes(replUrl) && !this.isLoginPage(currentUrl)) {
      console.log('Navigating to repl after login...');
      try {
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        console.log('Re-navigation timeout, continuing...');
      }
      await page.waitForTimeout(5000);
      
      await this.handleLoginRedirect(page);
    }

    await page.waitForTimeout(2000);

    const chatContainer = await this.findChatContainer(page);
    console.log(`Chat container found: ${chatContainer || 'none (will use fallback scrolling)'}`);
    
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

    console.log(`\n  Results summary:`);
    console.log(`    Messages: ${messages.length} (${messages.filter(m => m.type === 'user').length} user, ${messages.filter(m => m.type === 'agent').length} agent)`);
    console.log(`    Checkpoints: ${checkpoints.length}`);
    console.log(`    Work entries: ${workEntries.length}`);
    const withTimestamp = [...messages, ...workEntries, ...checkpoints].filter((e: any) => e.timestamp).length;
    const total = messages.length + workEntries.length + checkpoints.length;
    console.log(`    Items with timestamps: ${withTimestamp}/${total}`);
    const detailCount = workEntries.reduce((sum, we) => sum + (we.chargeDetails ? we.chargeDetails.length : 0), 0);
    console.log(`    Agent usage line items: ${detailCount}`);

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
    } else {
      console.log('  No general collapsed sections found');
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

    // Toggle timestamp switches from relative ("4 days ago") to absolute ("3:49 pm, Feb 03, 2026")
    // These are <span> elements with class Timestamp-module and role="switch" aria-checked="false"
    console.log('  Toggling timestamps to absolute format...');
    var timestampsToggled = await page.evaluate(function() {
      var toggled = 0;
      var tsEls = document.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
      for (var i = 0; i < tsEls.length; i++) {
        var el = tsEls[i];
        var role = el.getAttribute('role');
        var checked = el.getAttribute('aria-checked');
        if (role === 'switch' && checked === 'false') {
          var rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (el['click']) el['click']();
            toggled++;
          }
        }
      }
      return toggled;
    });

    if (timestampsToggled > 0) {
      console.log(`  Toggled ${timestampsToggled} timestamps to absolute format`);
      await page.waitForTimeout(1500);
    } else {
      console.log('  No timestamp switches found to toggle');
    }

    await page.waitForTimeout(500);
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
      var info = {
        containers: [] as any[],
        sampleElements: [] as any[],
        bodyClasses: document.body.getAttribute('class') || '',
        url: window.location.href,
        timeElements: [] as any[],
        endOfRunSamples: [] as any[],
        agentUsageSamples: [] as any[]
      };

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

      var timeEls = document.querySelectorAll('time, [datetime], [class*="timestamp"], [class*="Timestamp"], [class*="Timestamp-module"], [class*="timeAgo"], [class*="TimeAgo"], [class*="relativeTime"]');
      for (var ti = 0; ti < Math.min(15, timeEls.length); ti++) {
        info.timeElements.push({
          tag: timeEls[ti].tagName,
          className: (timeEls[ti].getAttribute('class') || '').substring(0, 200),
          datetime: timeEls[ti].getAttribute('datetime') || '',
          title: timeEls[ti].getAttribute('title') || '',
          role: timeEls[ti].getAttribute('role') || '',
          ariaChecked: timeEls[ti].getAttribute('aria-checked') || '',
          textContent: (timeEls[ti].textContent || '').trim().substring(0, 100),
          outerHTML: timeEls[ti].outerHTML.substring(0, 500),
          parentClass: (timeEls[ti].parentElement ? (timeEls[ti].parentElement as Element).getAttribute('class') || '' : '').substring(0, 200)
        });
      }

      var endOfRunEls = document.querySelectorAll('[class*="EndOfRunSummary"], [class*="endOfRun"]');
      for (var eri = 0; eri < Math.min(3, endOfRunEls.length); eri++) {
        var erEl = endOfRunEls[eri];
        info.endOfRunSamples.push({
          className: (erEl.getAttribute('class') || '').substring(0, 300),
          textContent: (erEl.textContent || '').trim().substring(0, 500),
          innerHTML: erEl.innerHTML.substring(0, 2000),
          childCount: erEl.children.length
        });
      }

      var agentUsageEls = document.querySelectorAll('[class*="EndOfRunSummary"] [aria-expanded], [class*="endOfRun"] [aria-expanded]');
      for (var aui = 0; aui < Math.min(5, agentUsageEls.length); aui++) {
        var auEl = agentUsageEls[aui];
        var auParent = auEl.parentElement;
        info.agentUsageSamples.push({
          className: (auEl.getAttribute('class') || '').substring(0, 300),
          ariaExpanded: auEl.getAttribute('aria-expanded'),
          textContent: (auEl.textContent || '').trim().substring(0, 200),
          outerHTML: auEl.outerHTML.substring(0, 500),
          parentInnerHTML: auParent ? auParent.innerHTML.substring(0, 2000) : '',
          nextSiblingHTML: auEl.nextElementSibling ? auEl.nextElementSibling.outerHTML.substring(0, 1000) : ''
        });
      }

      return info;
    });

    var debugPath = path.join(outputDir, 'dom-debug.json');
    fs.writeFileSync(debugPath, JSON.stringify(domInfo, null, 2), 'utf-8');
    console.log(`  DOM debug info saved to: ${debugPath}`);
    console.log(`  Debug stats: ${domInfo.timeElements.length} time elements, ${domInfo.endOfRunSamples.length} EndOfRunSummary elements, ${domInfo.agentUsageSamples.length} expandable Agent Usage elements`);
  }

  private async extractChatData(page: Page, outputDir: string = './exports'): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[]; workEntries: WorkEntry[] }> {
    try {
      await this.dumpDomStructure(page, outputDir);
    } catch (err) {
      console.log('  Note: Could not dump DOM structure for debugging');
    }

    // Re-toggle any timestamps that may have loaded after initial toggle
    // (lazy-loaded content from scroll or section expansion)
    var lateToggles = await page.evaluate(function() {
      var toggled = 0;
      var tsEls = document.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
      for (var i = 0; i < tsEls.length; i++) {
        var el = tsEls[i];
        var role = el.getAttribute('role');
        var checked = el.getAttribute('aria-checked');
        if (role === 'switch' && checked === 'false') {
          var rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (el['click']) el['click']();
            toggled++;
          }
        }
      }
      return toggled;
    });
    if (lateToggles > 0) {
      console.log(`  Toggled ${lateToggles} additional late-loaded timestamps`);
      await page.waitForTimeout(1000);
    }

    // Pre-compute timestamps for all event containers in a separate evaluate
    // to avoid nested function definitions inside page.evaluate (ES5 safety)
    var timestampMap = await page.evaluate(function() {
      var results = {} as any;
      var selectors = '[class*="eventContainer"], [class*="EventContainer"], [data-event-type]';
      var containers = document.querySelectorAll(selectors);

      for (var idx = 0; idx < containers.length; idx++) {
        var el = containers[idx];

        // 1. Timestamp-module span elements (Replit's actual timestamp components)
        // After toggling, these contain absolute timestamps like "3:49 pm, Feb 03, 2026"
        var tsModuleEls = el.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
        var foundTsModule = false;
        for (var tmi = 0; tmi < tsModuleEls.length; tmi++) {
          var tmText = (tsModuleEls[tmi].textContent || '').trim();
          if (tmText.length > 0 && tmText.length < 100) {
            results[idx] = tmText;
            foundTsModule = true;
            break;
          }
        }
        if (foundTsModule) continue;

        // 2. <time> element inside (fallback for other UIs)
        var timeEl = el.querySelector('time');
        if (timeEl) {
          var dt = timeEl.getAttribute('datetime');
          if (dt) { results[idx] = dt; continue; }
          var tt = (timeEl.textContent || '').trim();
          if (tt.length > 0 && tt.length < 100) { results[idx] = tt; continue; }
        }

        // 3. Own datetime/title attribute
        var elDatetime = el.getAttribute('datetime');
        if (elDatetime) { results[idx] = elDatetime; continue; }
        var elTitle = el.getAttribute('title');
        if (elTitle && elTitle.match(/\d{4}/)) { results[idx] = elTitle; continue; }

        // 4. Parent Timestamp-module or <time> element
        var parent = el.parentElement;
        if (parent) {
          var parentTsModule = parent.querySelector('[class*="Timestamp-module"]');
          if (parentTsModule) {
            var ptmText = (parentTsModule.textContent || '').trim();
            if (ptmText.length > 0 && ptmText.length < 100) { results[idx] = ptmText; continue; }
          }
          var parentTime = parent.querySelector('time');
          if (parentTime) {
            var pdt = parentTime.getAttribute('datetime');
            if (pdt) { results[idx] = pdt; continue; }
            var ptt = (parentTime.textContent || '').trim();
            if (ptt.length > 0 && ptt.length < 100) { results[idx] = ptt; continue; }
          }
        }

        // 5. Siblings with timestamp
        var foundSibling = false;
        if (parent) {
          var siblings = parent.children;
          for (var si = 0; si < siblings.length; si++) {
            var sib = siblings[si];
            if (sib === el) continue;
            var sibTsModule = sib.querySelector('[class*="Timestamp-module"]');
            if (sibTsModule) {
              var stmText = (sibTsModule.textContent || '').trim();
              if (stmText.length > 0 && stmText.length < 100) { results[idx] = stmText; foundSibling = true; break; }
            }
            var sibTime = sib.querySelector('time');
            if (sibTime) {
              var sdt = sibTime.getAttribute('datetime');
              if (sdt) { results[idx] = sdt; foundSibling = true; break; }
              var stt = (sibTime.textContent || '').trim();
              if (stt.length > 0 && stt.length < 100) { results[idx] = stt; foundSibling = true; break; }
            }
            var sibClass = (sib.getAttribute('class') || '').toLowerCase();
            if (sibClass.indexOf('timestamp') >= 0 || sibClass.indexOf('timeago') >= 0 || sibClass.indexOf('time') >= 0) {
              var sibText = (sib.textContent || '').trim();
              if (sibText.length > 0 && sibText.length < 100) { results[idx] = sibText; foundSibling = true; break; }
            }
          }
        }
        if (foundSibling) continue;

        // 6. Timestamp CSS class descendants (broader search)
        var tsEls = el.querySelectorAll('[class*="timestamp"], [class*="Timestamp"], [class*="timeAgo"], [class*="TimeAgo"], [class*="relativeTime"]');
        var foundTsClass = false;
        for (var tsi = 0; tsi < tsEls.length; tsi++) {
          var tsText = (tsEls[tsi].textContent || '').trim();
          if (tsText.length > 0 && tsText.length < 100) { results[idx] = tsText; foundTsClass = true; break; }
        }
        if (foundTsClass) continue;

        // 7. Real timestamp pattern: "3:49 pm, Feb 03, 2026"
        var rawText = (el.textContent || '');
        var realTsMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
        if (realTsMatch) { results[idx] = realTsMatch[1]; continue; }

        // 8. Relative time: "4 days ago"
        var relMatch = rawText.match(/(\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago)/i);
        if (relMatch) { results[idx] = relMatch[1]; continue; }

        // 9. ISO timestamp
        var isoMatch = rawText.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (isoMatch) { results[idx] = isoMatch[1]; continue; }
      }

      return results;
    });

    // Also pre-compute timestamps for fallback selectors
    var fallbackTimestampMap = await page.evaluate(function() {
      var results = {} as any;
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
      var els = document.querySelectorAll(selectorStr);

      for (var idx = 0; idx < els.length; idx++) {
        var el = els[idx];

        // 1. Timestamp-module span elements (Replit's actual timestamp components)
        var tsModuleEls = el.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
        var foundTsModule = false;
        for (var tmi = 0; tmi < tsModuleEls.length; tmi++) {
          var tmText = (tsModuleEls[tmi].textContent || '').trim();
          if (tmText.length > 0 && tmText.length < 100) {
            results[idx] = tmText;
            foundTsModule = true;
            break;
          }
        }
        if (foundTsModule) continue;

        // 2. <time> element (fallback)
        var timeEl = el.querySelector('time');
        if (timeEl) {
          var dt = timeEl.getAttribute('datetime');
          if (dt) { results[idx] = dt; continue; }
          var tt = (timeEl.textContent || '').trim();
          if (tt.length > 0 && tt.length < 100) { results[idx] = tt; continue; }
        }

        var elDatetime = el.getAttribute('datetime');
        if (elDatetime) { results[idx] = elDatetime; continue; }
        var elTitle = el.getAttribute('title');
        if (elTitle && elTitle.match(/\d{4}/)) { results[idx] = elTitle; continue; }

        var parent = el.parentElement;
        if (parent) {
          var parentTsModule = parent.querySelector('[class*="Timestamp-module"]');
          if (parentTsModule) {
            var ptmText = (parentTsModule.textContent || '').trim();
            if (ptmText.length > 0 && ptmText.length < 100) { results[idx] = ptmText; continue; }
          }
          var parentTime = parent.querySelector('time');
          if (parentTime) {
            var pdt = parentTime.getAttribute('datetime');
            if (pdt) { results[idx] = pdt; continue; }
            var ptt = (parentTime.textContent || '').trim();
            if (ptt.length > 0 && ptt.length < 100) { results[idx] = ptt; continue; }
          }
        }

        var foundSibling = false;
        if (parent) {
          var siblings = parent.children;
          for (var si = 0; si < siblings.length; si++) {
            var sib = siblings[si];
            if (sib === el) continue;
            var sibTsModule = sib.querySelector('[class*="Timestamp-module"]');
            if (sibTsModule) {
              var stmText = (sibTsModule.textContent || '').trim();
              if (stmText.length > 0 && stmText.length < 100) { results[idx] = stmText; foundSibling = true; break; }
            }
            var sibTime = sib.querySelector('time');
            if (sibTime) {
              var sdt = sibTime.getAttribute('datetime');
              if (sdt) { results[idx] = sdt; foundSibling = true; break; }
              var stt = (sibTime.textContent || '').trim();
              if (stt.length > 0 && stt.length < 100) { results[idx] = stt; foundSibling = true; break; }
            }
            var sibClass = (sib.getAttribute('class') || '').toLowerCase();
            if (sibClass.indexOf('timestamp') >= 0 || sibClass.indexOf('timeago') >= 0 || sibClass.indexOf('time') >= 0) {
              var sibText = (sib.textContent || '').trim();
              if (sibText.length > 0 && sibText.length < 100) { results[idx] = sibText; foundSibling = true; break; }
            }
          }
        }
        if (foundSibling) continue;

        var tsEls = el.querySelectorAll('[class*="timestamp"], [class*="Timestamp"], [class*="timeAgo"], [class*="TimeAgo"], [class*="relativeTime"]');
        var foundTsClass = false;
        for (var tsi = 0; tsi < tsEls.length; tsi++) {
          var tsText = (tsEls[tsi].textContent || '').trim();
          if (tsText.length > 0 && tsText.length < 100) { results[idx] = tsText; foundTsClass = true; break; }
        }
        if (foundTsClass) continue;

        var rawText = (el.textContent || '');
        var realTsMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
        if (realTsMatch) { results[idx] = realTsMatch[1]; continue; }

        var relMatch = rawText.match(/(\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago)/i);
        if (relMatch) { results[idx] = relMatch[1]; continue; }

        var isoMatch = rawText.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (isoMatch) { results[idx] = isoMatch[1]; continue; }
      }

      return results;
    });

    var combinedMaps = { ts: timestampMap, fb: fallbackTimestampMap };
    var data = await page.evaluate(function(maps) {
      var tsMap = maps.ts;
      var fbTsMap = maps.fb;
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

        // Look up pre-computed timestamp
        var timestamp = tsMap[ei] || null;

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

          var actionsMatch = rawText.match(/(\d+)\s*actions?/i);
          var workDoneActions = actionsMatch ? parseInt(actionsMatch[1], 10) : null;

          var itemsMatch = rawText.match(/(\d+)\s*lines/i);
          var itemsReadLines = itemsMatch ? parseInt(itemsMatch[1], 10) : null;

          var codePlusMatch = rawText.match(/\+(\d+)/);
          var codeMinusMatch = rawText.match(/-(\d+)/);
          var codeChangedPlus = codePlusMatch ? parseInt(codePlusMatch[1], 10) : null;
          var codeChangedMinus = codeMinusMatch ? parseInt(codeMinusMatch[1], 10) : null;

          var totalCharge = null as any;
          var costMatches = rawText.match(/\$[\d.]+/g);
          if (costMatches && costMatches.length > 0) {
            totalCharge = parseFloat(costMatches[0].substring(1));
            if (isNaN(totalCharge)) totalCharge = null;
          }

          // Extract individual charge line items from expanded Agent Usage section
          // KEY: Only capture items BELOW the "Agent Usage" heading, not above it
          var chargeDetails = [] as any[];
          var searchRoot = endOfRunRoot || evEl;

          // Step 1: Find the "Agent Usage" heading element in the DOM
          var agentUsageHeading = null as any;
          var allChildEls = searchRoot.querySelectorAll('*');
          for (var hi = 0; hi < allChildEls.length; hi++) {
            var hEl = allChildEls[hi];
            var hText = (hEl.textContent || '').trim();
            // Match "Agent Usage" with optional dollar amount like "Agent Usage" or just the heading
            // The heading element is typically short and contains "Agent Usage"
            if (hText.indexOf('Agent Usage') >= 0 && hText.length < 50) {
              // Prefer the most specific (deepest) element that matches
              agentUsageHeading = hEl;
            }
          }

          if (agentUsageHeading) {
            // Step 2: Only scan elements that come AFTER the Agent Usage heading
            var labelCandidates = [] as any[];
            var amountCandidates = [] as any[];

            for (var ci = 0; ci < allChildEls.length; ci++) {
              var childEl = allChildEls[ci];
              // Check if this element comes AFTER the Agent Usage heading in DOM order
              var headingPos = agentUsageHeading.compareDocumentPosition(childEl);
              // headingPos & 4 means childEl follows agentUsageHeading
              if (!(headingPos & 4)) continue;

              // Only consider leaf-ish elements
              if (childEl.children.length > 3) continue;
              var childText = (childEl.textContent || '').trim();
              if (childText.length === 0) continue;

              // Check if this is a dollar amount
              var amtMatch = childText.match(/^\$([\d.]+)$/);
              if (amtMatch) {
                amountCandidates.push({
                  el: childEl,
                  amount: parseFloat(amtMatch[1]),
                  text: childText,
                  rect: childEl.getBoundingClientRect()
                });
                continue;
              }

              // Check if this could be a label (short text, no dollar sign)
              if (childText.length > 2 && childText.length < 150 && childText.indexOf('$') < 0) {
                var lowerText = childText.toLowerCase();
                // Skip the heading text itself or noise
                if (lowerText === 'agent usage') continue;

                labelCandidates.push({
                  el: childEl,
                  text: childText,
                  rect: childEl.getBoundingClientRect()
                });
              }
            }

            // Step 3: Match labels to amounts by DOM proximity
            var usedLabels = {} as any;
            for (var ami = 0; ami < amountCandidates.length; ami++) {
              var amt = amountCandidates[ami];

              var bestLabel = null as any;
              var bestDistance = 999999;

              for (var li = 0; li < labelCandidates.length; li++) {
                var lbl = labelCandidates[li];
                if (usedLabels[li]) continue;

                // Check if this label appears before this amount in DOM order
                var pos = lbl.el.compareDocumentPosition(amt.el);
                if (pos & 4) {
                  var vDist = Math.abs(amt.rect.top - lbl.rect.top);
                  if (vDist < bestDistance && vDist < 100) {
                    bestDistance = vDist;
                    bestLabel = { index: li, text: lbl.text };
                  }
                }
              }

              if (bestLabel) {
                usedLabels[bestLabel.index] = true;
                var cleanLabel = bestLabel.text.replace(/\s+/g, ' ').trim();
                if (!isNaN(amt.amount) && amt.amount > 0) {
                  chargeDetails.push({
                    label: cleanLabel,
                    amount: amt.amount
                  });
                }
              }
            }

            // Remove the total if it got captured (matches totalCharge)
            if (chargeDetails.length > 1 && totalCharge !== null) {
              var filtered = [] as any[];
              var removedTotal = false;
              for (var fi = 0; fi < chargeDetails.length; fi++) {
                if (!removedTotal && Math.abs(chargeDetails[fi].amount - totalCharge) < 0.005) {
                  removedTotal = true;
                  continue;
                }
                filtered.push(chargeDetails[fi]);
              }
              if (filtered.length > 0) {
                chargeDetails = filtered;
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
          // Use the comprehensive timestamp finder first
          var cpTimestamp = timestamp;

          // Also try to find real timestamp in expanded content
          var realTimestampMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
          if (realTimestampMatch) {
            cpTimestamp = realTimestampMatch[1];
          }

          var cpDescription = '';
          // Try matching with absolute timestamp format first (after toggle):
          // "Checkpoint made  Saved progress...  5:46 pm, Feb 07, 2026  Rollback here..."
          var cpDescMatchAbs = rawText.match(/Checkpoint\s+made\s*([\s\S]*?)(?:\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4}|\s*Rollback|\s*Preview|\s*Changes|$)/i);
          if (cpDescMatchAbs && cpDescMatchAbs[1]) {
            var descCandidate = cpDescMatchAbs[1].trim();
            // Filter out if it only captured relative time like "4 days ago"
            if (descCandidate && !descCandidate.match(/^\d+\s+(?:second|minute|hour|day|week|month|year)s?\s*ago\s*$/i)) {
              cpDescription = descCandidate;
            }
          }
          // Fallback: try with relative timestamp "...ago" separator
          if (!cpDescription) {
            var cpDescMatchRel = rawText.match(/Checkpoint\s+made[\s\S]*?ago\s*([\s\S]*?)(?:\d{1,2}:\d{2}\s*(?:am|pm)|\s*Rollback|\s*Preview|\s*Changes|$)/i);
            if (cpDescMatchRel && cpDescMatchRel[1]) {
              cpDescription = cpDescMatchRel[1].trim();
            }
          }
          // Last resort: strip known noise from the text
          if (!cpDescription) {
            cpDescription = cleanedText
              .replace(/Checkpoint\s+made\s*/i, '')
              .replace(/\d+\s+(?:second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '')
              .replace(/\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4}/gi, '')
              .replace(/Rollback\s+here/gi, '')
              .replace(/Preview/gi, '')
              .replace(/Changes/gi, '')
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

          var bTimestamp = fbTsMap[bi] || null;

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
    }, combinedMaps);

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

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, Checkpoint, WorkEntry, ReplExport } from './types';
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

    console.log('Processing chat: expand targeted sections, then extract all...');
    const { messages, checkpoints, workEntries } = await this.walkAndExtract(page, outputDir);

    for (const cp of checkpoints) {
      cp.durationSeconds = calculateDuration(cp.timestamp, messages);
    }

    try {
      const domDebug = await page.evaluate(function() {
        var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
        var info = [] as any[];
        for (var i = 0; i < containers.length && i < 20; i++) {
          var c = containers[i];
          var children = [] as any[];
          for (var j = 0; j < c.children.length && j < 10; j++) {
            var ch = c.children[j];
            children.push({
              tag: ch.tagName,
              className: (ch.getAttribute('class') || '').substring(0, 120),
              dataTestId: ch.getAttribute('data-testid') || '',
              dataCy: ch.getAttribute('data-cy') || '',
              dataEventType: ch.getAttribute('data-event-type') || '',
              role: ch.getAttribute('role') || '',
              childCount: ch.children.length,
              textLength: (ch.textContent || '').length,
              textPreview: (ch.textContent || '').substring(0, 80),
              outerHTMLPreview: ch.outerHTML.substring(0, 300)
            });
          }
          info.push({
            tag: c.tagName,
            className: (c.getAttribute('class') || '').substring(0, 120),
            dataTestId: c.getAttribute('data-testid') || '',
            role: c.getAttribute('role') || '',
            childCount: c.children.length,
            scrollHeight: c.scrollHeight,
            clientHeight: c.clientHeight,
            childSamples: children
          });
        }
        return { containers: info, totalContainers: containers.length };
      });
      const debugPath = path.join(outputDir, 'dom-debug.json');
      fs.writeFileSync(debugPath, JSON.stringify(domDebug, null, 2));
      console.log(`  DOM debug saved: ${debugPath}`);
    } catch (err) {
      console.log('  Note: Could not save DOM debug info');
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

    return result;
  }

  private async toggleTimestamps(page: Page): Promise<number> {
    var total = 0;
    for (var round = 0; round < 3; round++) {
      var toggled = await page.evaluate(function() {
        var count = 0;
        var tsEls = document.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
        for (var i = 0; i < tsEls.length; i++) {
          var el = tsEls[i];
          var role = el.getAttribute('role');
          var checked = el.getAttribute('aria-checked');
          if (role === 'switch' && (checked === 'false' || checked === null)) {
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              if (el['click']) el['click']();
              count++;
            }
          }
        }
        return count;
      });
      total += toggled;
      if (toggled === 0) break;
      await page.waitForTimeout(800);
    }
    return total;
  }

  private async expandTargetedSections(page: Page): Promise<number> {
    var totalClicked = await page.evaluate(function() {
      var clicked = 0;

      var expandables = document.querySelectorAll(
        '[class*="ExpandableFeedContent"], [class*="expandableButton"], ' +
        'button[class*="expandable"], button[class*="Expandable"], ' +
        '[class*="expandable"][role="button"], [class*="Expandable"][role="button"], ' +
        'button[aria-expanded="false"], [role="button"][aria-expanded="false"]'
      );

      for (var i = 0; i < expandables.length; i++) {
        var btn = expandables[i];
        if (btn.getAttribute('data-exporter-clicked') === '1') continue;
        var ariaExp = btn.getAttribute('aria-expanded');
        if (ariaExp === 'true') continue;

        var text = (btn.textContent || '').trim().toLowerCase();

        var isMessageActions = /\d+\s*messages?\s*[&,]\s*\d+\s*actions?/i.test(text) ||
          /\d+\s*actions?\s*[&,]\s*\d+\s*messages?/i.test(text) ||
          /\d+\s*messages?$/i.test(text);
        var isCheckpoint = text.indexOf('checkpoint') >= 0 && text.indexOf('made') >= 0;
        var isWorkedFor = /worked\s+for\s+/i.test(text);

        if (!isMessageActions && !isCheckpoint && !isWorkedFor) continue;

        var rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          btn.setAttribute('data-exporter-clicked', '1');
          if (btn['click']) btn['click']();
          clicked++;
        }
      }

      return clicked;
    });

    return totalClicked;
  }

  private async extractElementData(page: Page, index: number, lastTimestamp: string | null): Promise<any> {
    return await page.evaluate(function(args) {
      var idx = args.idx;
      var prevTimestamp = args.prevTs;
      var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
      if (idx >= containers.length) return null;

      var el = containers[idx];
      var rawText = (el.textContent || '').trim();
      if (rawText.length < 3) return null;
      var innerRaw = ((el as any).innerText || rawText).trim();

      var evClass = (el.getAttribute('class') || '').toLowerCase();
      var evEventType = (el.getAttribute('data-event-type') || '').toLowerCase();
      var evCy = (el.getAttribute('data-cy') || '').toLowerCase();

      var relativePattern = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i;

      var timestamp = null as any;
      var tsModuleEls = el.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
      for (var tmi = 0; tmi < tsModuleEls.length; tmi++) {
        var tmText = (tsModuleEls[tmi].textContent || '').trim();
        if (tmText.length > 0 && tmText.length < 100 && !relativePattern.test(tmText)) {
          timestamp = tmText;
          break;
        }
      }
      if (!timestamp) {
        var timeEl = el.querySelector('time');
        if (timeEl) {
          var dt = timeEl.getAttribute('datetime');
          if (dt) timestamp = dt;
          else {
            var tt = (timeEl.textContent || '').trim();
            if (tt.length > 0 && tt.length < 100) timestamp = tt;
          }
        }
      }
      if (!timestamp) {
        var realTsMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
        if (realTsMatch) timestamp = realTsMatch[1];
      }
      if (!timestamp) {
        var relMatch = rawText.match(/(\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago)/i);
        if (relMatch) timestamp = relMatch[1];
      }
      if (!timestamp) timestamp = prevTimestamp;

      var innerUserMarker = el.querySelector('[data-cy="user-message"], [data-event-type="user-message"], [class*="userMessage"], [class*="UserMessage"]');
      var innerCheckpointMarker = el.querySelector('[class*="checkpoint"], [class*="Checkpoint"], [data-event-type*="checkpoint"]');

      var endOfRunRoot = el.querySelector('[class*="EndOfRunSummary"]');
      if (!endOfRunRoot) {
        var ownClass = el.getAttribute('class') || '';
        if (ownClass.indexOf('EndOfRunSummary') >= 0) endOfRunRoot = el;
      }
      var workedMatch = rawText.match(/Worked\s+for\s+(\d+\s*(?:second|minute|hour|day|week|month|year)s?(?:\s*(?:and\s*)?\d+\s*(?:second|minute|hour|day|week|month|year)s?)*)/i);

      if (endOfRunRoot || workedMatch) {
        var wDuration = workedMatch ? workedMatch[1] : '';

        var preciseDuration = null as any;
        var searchEls = (endOfRunRoot || el).querySelectorAll('*');
        for (var tdi = 0; tdi < searchEls.length; tdi++) {
          var tdEl = searchEls[tdi];
          var tdText = (tdEl.textContent || '').trim();
          var tdHasWorked = tdText.indexOf('Worked') >= 0 || tdText.indexOf('minute') >= 0 || tdText.indexOf('second') >= 0 || tdText.indexOf('hour') >= 0;
          if (!tdHasWorked) continue;

          var tdTitle = tdEl.getAttribute('title') || '';
          var tdAria = tdEl.getAttribute('aria-label') || '';
          var tdTooltip = tdTitle || tdAria;
          if (tdTooltip && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(tdTooltip) && tdTooltip.length < 100) {
            var tdClean = tdTooltip.replace(/^Worked\s+for\s+/i, '').trim();
            if (tdClean.length > 0 && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(tdClean)) {
              preciseDuration = tdClean;
              break;
            }
          }
        }
        if (preciseDuration) {
          wDuration = preciseDuration;
        }

        var wDurationSecs = 0;
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

        return {
          entryType: 'work',
          timestamp: timestamp,
          timeWorked: wDuration || '',
          durationSeconds: wDurationSecs > 0 ? wDurationSecs : null,
          workDoneActions: workDoneActions,
          itemsReadLines: itemsReadLines,
          codeChangedPlus: codeChangedPlus,
          codeChangedMinus: codeChangedMinus,
          agentUsage: totalCharge
        };
      }

      var isCheckpoint = evClass.indexOf('checkpoint') >= 0 ||
        evEventType.indexOf('checkpoint') >= 0 ||
        innerCheckpointMarker !== null ||
        (rawText.indexOf('Checkpoint') >= 0 && rawText.length < 500);

      if (isCheckpoint) {
        var cpTimestamp = null as any;
        var cpRealTsMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
        if (cpRealTsMatch) cpTimestamp = cpRealTsMatch[1];
        if (!cpTimestamp) cpTimestamp = timestamp;

        var cpDescription = rawText
          .replace(/Checkpoint\s+made\s*/i, '')
          .replace(/\d+\s+(?:second|minute|hour|day|week|month|year)s?\s*ago\s*/gi, '')
          .replace(/\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4}/gi, '')
          .replace(/Rollback\s+here/gi, '').replace(/Preview/gi, '').replace(/Changes/gi, '').trim();

        var costMatch = rawText.match(/\$[\d.]+/);
        return {
          entryType: 'checkpoint',
          timestamp: cpTimestamp,
          description: cpDescription.substring(0, 1000),
          cost: costMatch ? costMatch[0] : null
        };
      }

      var cleanedText = rawText.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
      cleanedText = cleanedText.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();
      var cleanedInner = innerRaw.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
      cleanedInner = cleanedInner.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();

      if (cleanedText.length < 5) return null;
      if (cleanedText.match(/^Worked\s+for\s+/i)) return null;
      if (cleanedText.match(/^Decided\s+on\s+/i) && cleanedText.length < 100) return null;
      if (cleanedText.match(/^\d+\s+actions?\s*$/i)) return null;
      if (cleanedText.match(/^Created task list\s*$/i)) return null;
      if (cleanedText.match(/^Ready to share\?\s*Publish/i)) return null;

      var isUser = evClass.indexOf('usermessage') >= 0 ||
        evClass.indexOf('user-message') >= 0 ||
        evEventType === 'user-message' ||
        evCy === 'user-message' ||
        innerUserMarker !== null;

      return {
        entryType: 'message',
        type: isUser ? 'user' : 'agent',
        content: cleanedInner.substring(0, 10000),
        contentKey: cleanedText.substring(0, 200),
        timestamp: timestamp
      };
    }, { idx: index, prevTs: lastTimestamp });
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

  private async walkAndExtract(page: Page, _outputDir: string = './exports'): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[]; workEntries: WorkEntry[] }> {
    // ===== PHASE 1: Toggle timestamps to absolute format =====
    console.log('  Phase 1: Toggling timestamps to absolute format...');
    var tsToggled = await this.toggleTimestamps(page);
    if (tsToggled > 0) {
      console.log(`  Toggled ${tsToggled} timestamps to absolute format`);
    }

    // ===== PHASE 2: Targeted expansion =====
    console.log('  Phase 2: Expanding targeted sections (messages & actions, checkpoints, worked for)...');
    var expandedCount = await this.expandTargetedSections(page);
    console.log(`  Expanded ${expandedCount} collapsed sections`);

    if (expandedCount > 0) {
      await page.waitForTimeout(1500);

      var tsToggledAfter = await this.toggleTimestamps(page);
      if (tsToggledAfter > 0) {
        console.log(`  Toggled ${tsToggledAfter} newly revealed timestamps`);
      }
    }

    // ===== PHASE 3: Extract all data =====
    var totalContainers = await page.evaluate(function() {
      return document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]').length;
    });
    console.log(`  Phase 3: Extracting data from ${totalContainers} containers...`);

    if (totalContainers === 0) {
      console.log('  No event containers found. Trying fallback selectors...');
      return this.fallbackExtract(page);
    }

    var messages: ChatMessage[] = [];
    var checkpoints: Checkpoint[] = [];
    var workEntries: WorkEntry[] = [];
    var seenKeys: Record<string, boolean> = {};
    var lastTimestamp: string | null = null;
    var index = 0;

    for (var i = 0; i < totalContainers; i++) {
      if (i % 50 === 0 && i > 0) {
        process.stdout.write(`\r  Extracting element ${i}/${totalContainers}...`);
      }

      var data = await this.extractElementData(page, i, lastTimestamp);
      if (!data) continue;

      if (data.timestamp && /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i.test(data.timestamp)) {
        var didClickToggle = await page.evaluate(function(idx) {
          var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
          if (idx >= containers.length) return false;
          var el = containers[idx];

          var toggles = el.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"], [class*="TimestampToggle"], [class*="timestampToggle"]');
          for (var ti = 0; ti < toggles.length; ti++) {
            var tog = toggles[ti];
            var togText = (tog.textContent || '').trim();
            if (/^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i.test(togText)) {
              var togRect = tog.getBoundingClientRect();
              if (togRect.width > 0 && togRect.height > 0) {
                if (tog['click']) tog['click']();
                return true;
              }
            }
          }
          return false;
        }, i);

        if (didClickToggle) {
          await page.waitForTimeout(300);

          var rereadTs = await page.evaluate(function(idx) {
            var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
            if (idx >= containers.length) return null;
            var el = containers[idx];

            var relativePattern = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i;

            var tsModuleEls = el.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
            for (var tmi = 0; tmi < tsModuleEls.length; tmi++) {
              var tmText = (tsModuleEls[tmi].textContent || '').trim();
              if (tmText.length > 0 && tmText.length < 100 && !relativePattern.test(tmText)) {
                return tmText;
              }
            }

            var timeEl = el.querySelector('time');
            if (timeEl) {
              var dt = timeEl.getAttribute('datetime');
              if (dt) return dt;
              var tt = (timeEl.textContent || '').trim();
              if (tt.length > 0 && tt.length < 100 && !relativePattern.test(tt)) return tt;
            }

            var rawText = (el.textContent || '').trim();
            var realTsMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
            if (realTsMatch) return realTsMatch[1];

            return null;
          }, i);

          if (rereadTs) {
            data.timestamp = rereadTs;
            console.log('  [Timestamp fix] Converted relative timestamp to: ' + rereadTs);
          }
        }
      }

      if (data.timestamp) lastTimestamp = data.timestamp;

      if (data.entryType === 'work') {
        var weKey = 'WE|' + (data.timestamp || 'noTs') + '|' + (data.timeWorked || '') + '|' + (data.durationSeconds || 0) + '|' + (data.agentUsage != null ? data.agentUsage : 'noFee') + '|' + (data.workDoneActions != null ? data.workDoneActions : '') + '|' + (data.itemsReadLines != null ? data.itemsReadLines : '');
        if (seenKeys[weKey]) continue;
        seenKeys[weKey] = true;

        workEntries.push({
          timestamp: data.timestamp,
          timeWorked: data.timeWorked || '',
          durationSeconds: data.durationSeconds,
          workDoneActions: data.workDoneActions,
          itemsReadLines: data.itemsReadLines,
          codeChangedPlus: data.codeChangedPlus,
          codeChangedMinus: data.codeChangedMinus,
          agentUsage: data.agentUsage,
          index: index++
        });
      } else if (data.entryType === 'checkpoint') {
        checkpoints.push({
          timestamp: data.timestamp,
          description: data.description || '',
          cost: data.cost,
          durationSeconds: null,
          index: index++
        });
      } else if (data.entryType === 'message') {
        var contentKey = data.contentKey || data.content.substring(0, 200);
        if (seenKeys[contentKey]) continue;
        seenKeys[contentKey] = true;

        messages.push({
          type: data.type,
          content: data.content,
          timestamp: data.timestamp,
          index: index++
        });
      }
    }

    console.log(`\r  Extracted from ${totalContainers} containers`);

    var deduped: ChatMessage[] = [];
    for (var d1 = 0; d1 < messages.length; d1++) {
      var isDuplicate = false;
      var m1 = messages[d1].content;
      for (var d2 = 0; d2 < messages.length; d2++) {
        if (d1 === d2) continue;
        var m2 = messages[d2].content;
        if (m2.length > m1.length && m2.includes(m1)) {
          isDuplicate = true;
          break;
        }
        if (m1 === m2 && d1 > d2) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) deduped.push(messages[d1]);
    }
    for (var ri = 0; ri < deduped.length; ri++) {
      deduped[ri].index = ri;
    }

    if (deduped.length === 0 && checkpoints.length === 0 && workEntries.length === 0) {
      console.log('  Primary extraction found no results, trying fallback...');
      return this.fallbackExtract(page);
    }

    return { messages: deduped, checkpoints, workEntries };
  }

  private async fallbackExtract(page: Page): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[]; workEntries: WorkEntry[] }> {
    var data = await page.evaluate(function() {
      var messages = [] as any[];
      var seenKeys = {} as any;
      var index = 0;

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

      for (var bi = 0; bi < els.length; bi++) {
        var bEl = els[bi];
        var bRaw = (bEl.textContent || '').trim();
        var bInner = ((bEl as any).innerText || bRaw).trim();

        var bClean = bRaw.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
        bClean = bClean.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();
        if (bClean.length < 5) continue;

        var bCleanInner = bInner.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
        bCleanInner = bCleanInner.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();

        var bKey = bClean.substring(0, 200);
        if (seenKeys[bKey]) continue;
        seenKeys[bKey] = true;

        var relativePattern = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i;
        var timestamp = null as any;
        var tsModuleEls = bEl.querySelectorAll('[class*="Timestamp-module"]');
        for (var tmi = 0; tmi < tsModuleEls.length; tmi++) {
          var tmText = (tsModuleEls[tmi].textContent || '').trim();
          if (tmText.length > 0 && tmText.length < 100 && !relativePattern.test(tmText)) {
            timestamp = tmText;
            break;
          }
        }
        if (!timestamp) {
          var timeEl = bEl.querySelector('time');
          if (timeEl) {
            var dt = timeEl.getAttribute('datetime');
            if (dt) timestamp = dt;
            else {
              var tt = (timeEl.textContent || '').trim();
              if (tt.length > 0 && tt.length < 100) timestamp = tt;
            }
          }
        }
        if (!timestamp) {
          var realTsMatch = bRaw.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
          if (realTsMatch) timestamp = realTsMatch[1];
        }

        var bClass = (bEl.getAttribute('class') || '').toLowerCase();
        var bCy = (bEl.getAttribute('data-cy') || '').toLowerCase();
        var bEvType = (bEl.getAttribute('data-event-type') || '').toLowerCase();
        var bUserMarker = bEl.querySelector('[data-cy="user-message"], [data-event-type="user-message"], [class*="userMessage"], [class*="UserMessage"]');

        var bIsUser = bClass.indexOf('usermessage') >= 0 ||
          bClass.indexOf('user-message') >= 0 ||
          bCy.indexOf('user') >= 0 ||
          bEvType === 'user-message' ||
          bUserMarker !== null;

        messages.push({
          type: bIsUser ? 'user' : 'agent',
          content: bCleanInner.substring(0, 10000),
          timestamp: timestamp,
          index: index++
        });
      }
      return messages;
    });

    return {
      messages: data as ChatMessage[],
      checkpoints: [],
      workEntries: []
    };
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

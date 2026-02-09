import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, Checkpoint, WorkEntry, GitCommit, ReplExport } from './types';
import { calculateDuration, extractReplName, parseTimestamp } from './utils';

const SESSION_FILE = './playwright-session.json';

const LOAD_MORE_SELECTORS = [
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

export class ReplitScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private verbose: boolean = false;

  setVerbose(v: boolean): void { this.verbose = v; }

  async init(): Promise<void> {
    console.log('Launching browser...');
    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--window-size=1440,900',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const contextOptions: any = {
      viewport: { width: 1440, height: 900 },
    };

    if (fs.existsSync(SESSION_FILE)) {
      console.log('Found existing session, attempting to restore...');
      try {
        const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        contextOptions.storageState = storageState;
        this.context = await this.browser.newContext(contextOptions);
        console.log('Session restored successfully.');
      } catch (err) {
        console.log('Failed to restore session, creating new context.');
        this.context = await this.browser.newContext(contextOptions);
      }
    } else {
      this.context = await this.browser.newContext(contextOptions);
    }

    this.page = await this.context.newPage();
  }

  async minimizeWindow(): Promise<void> {
    if (!this.page) return;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      await cdp.detach();
    } catch {
      // Minimize is best-effort; some environments may not support it
    }
  }

  async restoreWindow(): Promise<void> {
    if (!this.page) return;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' },
      });
      await cdp.detach();
    } catch {
      // Restore is best-effort
    }
  }

  async waitForLogin(page?: Page): Promise<void> {
    if (!this.context) throw new Error('Browser not initialized');

    const loginPage = page || this.page || await this.context.newPage();
    
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

  }

  async checkLoggedIn(): Promise<boolean> {
    if (!this.context || !this.page) throw new Error('Browser not initialized');

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

    try {
      await this.page.goto('https://replit.com/~', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await this.page.waitForTimeout(1000);

      const currentUrl = this.page.url();

      if (this.isLoginPage(currentUrl)) {
        return false;
      }

      return true;
    } catch {
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

  async scrapeRepl(replUrl: string, outputDir: string = './exports', fullMode: boolean = true): Promise<ReplExport> {
    if (!this.context || !this.page) throw new Error('Browser not initialized');

    const replName = extractReplName(replUrl);
    const scrapeStartTime = Date.now();
    console.log(`\nScraping: ${replName}`);

    const fullUrl = replUrl.startsWith('http') ? replUrl : `https://replit.com/${replUrl}`;
    const page: Page = this.page;
    let messages: ChatMessage[] = [];
    let checkpoints: Checkpoint[] = [];
    let workEntries: WorkEntry[] = [];
    let gitCommits: GitCommit[] = [];

    try {
    const currentBrowserUrl = page.url();
    const normalizeUrl = (u: string) => u.replace(/\/+$/, '').replace(/\?.*$/, '').toLowerCase();
    const alreadyOnPage = normalizeUrl(currentBrowserUrl).includes(normalizeUrl(fullUrl)) ||
      normalizeUrl(fullUrl).includes(normalizeUrl(currentBrowserUrl).replace('https://replit.com', ''));

    if (alreadyOnPage && currentBrowserUrl.startsWith('http') && !this.isLoginPage(currentBrowserUrl)) {
      console.log(`Already on target URL, skipping navigation: ${currentBrowserUrl}`);
    } else {
      console.log(`Navigating to: ${fullUrl}`);
      try {
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('Page DOM loaded successfully.');
      } catch (err) {
        console.log('Navigation timeout on domcontentloaded, continuing anyway...');
      }
    }

    await this.handleLoginRedirect(page);

    // Wait for the Replit SPA chat content to render before proceeding
    console.log('Waiting for chat panel to render...');
    await this.waitForChatContent(page);

    // === PRE-CHECK: Wait for Replit Agent to finish working ===
    await this.waitForAgentIdle(page);

    // === STEP 1: Load full chat history and expand sections ===
    console.log('Step 1: Scrolling to load full chat history...');
    await this.scrollToLoadAll(page);

    if (fullMode) {
      console.log('Step 1b: Expanding targeted sections (messages & actions, checkpoints, worked for)...');
      var expandedCount = await this.expandTargetedSections(page);
      console.log(`  Expanded ${expandedCount} collapsed sections`);
      if (expandedCount > 0) {
        await page.waitForTimeout(1500);
      }

      // === STEP 1c: Find oldest visible chat timestamp to limit Git commit scrolling ===
      var oldestChatTimestamp = await this.findOldestChatTimestamp(page);
      if (oldestChatTimestamp) {
        console.log(`  Oldest chat timestamp found: ${oldestChatTimestamp}`);
      } else {
        console.log('  Could not determine oldest chat timestamp — will load all Git commits');
      }

      // === STEP 2: Navigate to Git tab, click one relative timestamp, scrape commits ===
      // The one-click timestamp conversion in the Git tab converts ALL relative timestamps
      // across the entire UI to absolute. This is critical for accurate timestamp extraction.
      try {
        gitCommits = await this.scrapeGitCommits(page, oldestChatTimestamp);
      } catch (err) {
        console.log('  WARNING: Could not scrape Git commits:', (err as Error).message);
        console.log('  Timestamps may remain relative. Extraction will continue but some timestamps may be missing.');
      }

      // === STEP 3: Navigate back to chat panel ===
      console.log('\nStep 3: Navigating back to chat panel...');
      await this.navigateToChatPanel(page, fullUrl);
      await page.waitForTimeout(2000);

      // === STEP 4: Hover over duration elements for precise times ===
      console.log('Step 4: Hovering over duration elements to capture precise tooltips...');
      var hoverCount = await this.hoverDurationElements(page, this.verbose);
      if (hoverCount > 0) {
        console.log(`  Captured ${hoverCount} precise duration tooltips via hover`);
      }

      // === STEP 5: Extract all chat data (timestamps should now be absolute) ===
      console.log('Step 5: Extracting all chat data...');
      const extracted = await this.extractAllData(page, outputDir);
      messages = extracted.messages;
      checkpoints = extracted.checkpoints;
      workEntries = extracted.workEntries;

      for (const cp of checkpoints) {
        cp.durationSeconds = calculateDuration(cp.timestamp, messages);
      }
    } else {
      // Standard mode: expand collapsed message sections so agent messages are visible
      console.log('Step 1b: Expanding collapsed message sections...');
      var expandedCount = await this.expandTargetedSections(page);
      if (expandedCount > 0) {
        console.log(`  Expanded ${expandedCount} collapsed sections`);
        await page.waitForTimeout(1500);
      }

      // Standard mode: open Git tab briefly just to click one relative timestamp,
      // which converts ALL timestamps across the UI to absolute format.
      console.log('Step 2: Converting timestamps to absolute format...');
      try {
        await this.convertTimestampsViaGitTab(page);
      } catch (err) {
        console.log('  WARNING: Could not convert timestamps:', (err as Error).message);
        console.log('  Timestamps may remain relative.');
      }

      console.log('Step 3: Navigating back to chat panel...');
      await this.navigateToChatPanel(page, fullUrl);
      await page.waitForTimeout(1000);

      console.log('Step 4: Extracting chat messages...');
      const extracted = await this.extractAllData(page, outputDir);
      messages = extracted.messages;
    }

    if (fullMode) {
      // Save DOM debug info
      try {
        const domDebug = await page.evaluate(function() {
          var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
          var info = [];
          for (var i = 0; i < containers.length && i < 20; i++) {
            var c = containers[i];
            var children = [];
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
    }

    try {
      const storageState = await this.context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
    } catch (err) {
      console.log('Note: Could not update session file');
    }

    } catch (disconnectErr) {
      const errMsg = (disconnectErr as Error).message || '';
      if (errMsg.indexOf('Target closed') >= 0 ||
          errMsg.indexOf('browser has been closed') >= 0 ||
          errMsg.indexOf('Browser closed') >= 0 ||
          errMsg.indexOf('Protocol error') >= 0) {
        console.error('\n========================================');
        console.error('Browser window was closed unexpectedly (perhaps by Cmd-W or another shortcut).');
        console.error('The export for this URL was interrupted. Please re-run the tool.');
        console.error('========================================\n');
      }
      throw disconnectErr;
    }

    const result: ReplExport = {
      replName,
      replUrl: fullUrl,
      exportedAt: new Date().toISOString(),
      messages,
      checkpoints,
      workEntries,
      gitCommits,
    };

    const elapsedMs = Date.now() - scrapeStartTime;
    const elapsedMins = Math.floor(elapsedMs / 60000);
    const elapsedSecs = Math.round((elapsedMs % 60000) / 1000);
    const elapsedStr = elapsedMins > 0 ? `${elapsedMins}m ${elapsedSecs}s` : `${elapsedSecs}s`;

    console.log(`\n  Results summary:`);
    console.log(`    Messages: ${messages.length} (${messages.filter(m => m.type === 'user').length} user, ${messages.filter(m => m.type === 'agent').length} agent)`);
    if (fullMode) {
      console.log(`    Checkpoints: ${checkpoints.length}`);
      console.log(`    Work entries: ${workEntries.length}`);
      console.log(`    Git commits: ${gitCommits.length}`);
      const withTimestamp = [...messages, ...workEntries, ...checkpoints].filter((e: any) => e.timestamp).length;
      const total = messages.length + workEntries.length + checkpoints.length;
      if (withTimestamp < total) {
        console.log(`    Items with timestamps: ${withTimestamp}/${total} (${total - withTimestamp} item(s) at start of conversation may lack timestamps)`);
      } else {
        console.log(`    Items with timestamps: ${withTimestamp}/${total} (all items have timestamps)`);
      }
    } else {
      const withTimestamp = messages.filter((m: any) => m.timestamp).length;
      if (withTimestamp < messages.length) {
        console.log(`    Messages with timestamps: ${withTimestamp}/${messages.length}`);
      }
    }
    console.log(`    Extraction time: ${elapsedStr}`);

    return result;
  }

  private async checkAgentWorkingViaGit(page: Page): Promise<{ working: boolean; debug: string; checked: boolean }> {
    // Primary detection: check the top (most recent) git commit description.
    // "Transitioned from Plan to Build mode" => agent is likely running
    // "Saved progress at the end of the loop" => agent likely idle (needs secondary check)

    // First, try to open the Git panel temporarily
    var gitClicked = await page.evaluate(function() {
      var candidates = document.querySelectorAll(
        '[role="tab"], [data-testid*="tab"], button, a, ' +
        '[role="button"], [class*="Tab"], [class*="tool" i]'
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.textContent || '').trim().toLowerCase();
        var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        var title = (el.getAttribute('title') || '').toLowerCase();
        var testId = el.getAttribute('data-testid') || '';
        var isGitRelated = (
          text === 'git' ||
          ariaLabel.indexOf('git') >= 0 ||
          title.indexOf('git') >= 0 ||
          testId.indexOf('git') >= 0
        );
        if (isGitRelated) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (!gitClicked) {
      return { working: false, debug: 'Could not open Git tab for pre-check', checked: false };
    }

    await page.waitForTimeout(2000);

    // Read the top commit description using content-based detection
    var topCommit = await page.evaluate(function() {
      var relTimePattern = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i;
      var absTimePattern = /^\d{1,2}:\d{2}\s*(?:am|pm)/i;
      var justNowPattern = /^just\s+now$/i;
      var skipTexts = [
        'remote updates', 'sync changes', 'pull', 'push', 'commit',
        'there are no changes to commit', 'commit & push', 'commit all',
        'last fetched', 'origin/main', 'upstream', 'main'
      ];

      // Find the git panel by content
      var panels = document.querySelectorAll('[role="tabpanel"]');
      var gitPanel = null;
      for (var p = 0; p < panels.length; p++) {
        var style = window.getComputedStyle(panels[p]);
        if (style.opacity === '0' || style.display === 'none') continue;
        var pText = (panels[p].textContent || '').substring(0, 2000);
        if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
          gitPanel = panels[p];
          break;
        }
      }
      if (!gitPanel) return null;

      // Find the first timestamp element, then look at its container for the commit message
      var allEls = gitPanel.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.children.length > 0) continue;
        var txt = (el.textContent || '').trim();
        if (txt.length < 3 || txt.length > 80) continue;
        if (txt.indexOf('last fetched') >= 0) continue;
        if (relTimePattern.test(txt) || absTimePattern.test(txt) || justNowPattern.test(txt)) {
          // Found a timestamp — walk up to find its commit container and extract message
          var container = el;
          for (var d = 0; d < 8; d++) {
            var parent = container.parentElement;
            if (!parent || parent === gitPanel) break;
            if (parent.children.length >= 3) break;
            container = parent;
          }
          // Find message text within the container (longest non-timestamp/non-skip text)
          var kids = container.querySelectorAll('*');
          var bestMsg = '';
          for (var k = 0; k < kids.length; k++) {
            var kid = kids[k];
            if (kid.children.length > 0) continue;
            var kidText = (kid.textContent || '').trim();
            if (kidText.length < 5 || kidText.length > 500) continue;
            if (relTimePattern.test(kidText) || justNowPattern.test(kidText)) continue;
            if (/^\d{1,2}:\d{2}\s*(?:am|pm)/i.test(kidText)) continue;
            if (kidText.length <= 3) continue;
            var kidLower = kidText.toLowerCase();
            var isSkip = false;
            for (var si = 0; si < skipTexts.length; si++) {
              if (kidLower === skipTexts[si]) { isSkip = true; break; }
            }
            if (isSkip) continue;
            if (kidText.length > bestMsg.length) bestMsg = kidText;
          }
          if (bestMsg) return bestMsg;
        }
      }

      // Fallback: class-name-based selectors for older UI
      var commitSels = ['[class*="commit" i] [class*="message" i]', '[class*="CommitList"] li'];
      for (var s = 0; s < commitSels.length; s++) {
        var els = document.querySelectorAll(commitSels[s]);
        if (els.length > 0) {
          var firstText = (els[0].textContent || '').trim();
          if (firstText.length > 3) return firstText;
        }
      }
      return null;
    });

    if (!topCommit) {
      return { working: false, debug: 'Git tab opened but no commit messages found', checked: false };
    }

    var topLower = topCommit.toLowerCase();
    if (topLower.indexOf('transitioned from plan to build') >= 0) {
      return { working: true, debug: 'Top commit: "' + topCommit.substring(0, 60) + '" — agent is building', checked: true };
    }
    if (topLower.indexOf('saved progress at the end of the loop') >= 0) {
      // Likely idle, but need secondary check (user might have typed in build mode)
      return { working: false, debug: 'Top commit: "Saved progress" — likely idle, needs secondary check', checked: true };
    }

    // Some other commit message — could be user-initiated, treat as needs secondary check
    return { working: false, debug: 'Top commit: "' + topCommit.substring(0, 60) + '" — uncertain, needs secondary check', checked: true };
  }

  private async checkAgentWorkingViaDom(page: Page): Promise<{ working: boolean; debug: string }> {
    // Secondary detection: check for "Working" text at bottom of chat,
    // or do a 5-second DOM snapshot comparison to detect live changes.

    // First navigate back to chat if needed
    var chatClicked = await page.evaluate(function() {
      var tabs = document.querySelectorAll(
        '[role="tab"], [data-testid*="tab"], button[class*="tab" i], ' +
        'a[class*="tab" i], [class*="Tab"]'
      );
      for (var i = 0; i < tabs.length; i++) {
        var text = (tabs[i].textContent || '').trim().toLowerCase();
        if (text === 'chat' || text === 'agent' || text === 'ai' ||
            text === 'agent chat' || text === 'ai chat') {
          tabs[i].click();
          return true;
        }
      }
      return false;
    });

    if (chatClicked) {
      await page.waitForTimeout(1500);
    }

    // Check 1: Look for "Working" text at the very bottom of the chat
    var workingText = await page.evaluate(function() {
      var body = document.body;
      if (!body) return null;
      // Check the last visible text in the chat area
      var allText = body.innerText || '';
      var lines = allText.split('\n');
      // Check last 10 non-empty lines for "Working" indicator
      var count = 0;
      for (var i = lines.length - 1; i >= 0 && count < 10; i--) {
        var line = lines[i].trim();
        if (line.length === 0) continue;
        count++;
        if (line === 'Working' || line === 'Working...' || line === 'Working…') {
          return line;
        }
      }
      return null;
    });

    if (workingText) {
      return { working: true, debug: 'Found "' + workingText + '" text at bottom of chat — agent is working' };
    }

    // Check 2: 3-second DOM snapshot comparison to detect live typing
    var snapshot1 = await page.evaluate(function() {
      var containers = document.querySelectorAll(
        '[class*="eventContainer"], [class*="EventContainer"], [data-event-type], ' +
        '[class*="event" i], [class*="Event"], [class*="message" i], [class*="Message"]'
      );
      var lastFew = [];
      var start = Math.max(0, containers.length - 5);
      for (var i = start; i < containers.length; i++) {
        lastFew.push((containers[i].textContent || '').trim().substring(0, 500));
      }
      return { count: containers.length, lastContent: lastFew.join('|||') };
    });

    await page.waitForTimeout(3000);

    var snapshot2 = await page.evaluate(function() {
      var containers = document.querySelectorAll(
        '[class*="eventContainer"], [class*="EventContainer"], [data-event-type], ' +
        '[class*="event" i], [class*="Event"], [class*="message" i], [class*="Message"]'
      );
      var lastFew = [];
      var start = Math.max(0, containers.length - 5);
      for (var i = start; i < containers.length; i++) {
        lastFew.push((containers[i].textContent || '').trim().substring(0, 500));
      }
      return { count: containers.length, lastContent: lastFew.join('|||') };
    });

    if (snapshot2.count !== snapshot1.count || snapshot2.lastContent !== snapshot1.lastContent) {
      return { working: true, debug: 'Chat DOM changed during 3s observation (' + snapshot1.count + ' -> ' + snapshot2.count + ' containers) — agent is working' };
    }

    return { working: false, debug: 'No "Working" text and no DOM changes in 3s — agent appears idle' };
  }

  private async waitForChatContent(page: Page): Promise<void> {
    const chatSelectors = [
      '[class*="eventContainer"]', '[class*="EventContainer"]', '[data-event-type]',
      '[class*="AgentChat"]', '[class*="ChatPanel"]', '[data-testid*="chat"]',
      '[class*="message" i]', '[class*="Message"]',
      '[class*="Tab"]', '[role="tab"]',
    ];
    const selector = chatSelectors.join(', ');

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        console.log('  Chat panel detected.');
        return;
      } catch {
        if (attempt < 9) {
          console.log(`  Waiting for chat content to render... (attempt ${attempt + 1}/10)`);
        }
      }
    }
    console.log('  Chat content not found after 50s. Proceeding anyway...');
  }

  private async waitForAgentIdle(page: Page): Promise<void> {
    console.log('\nPre-check: Checking if Replit Agent is currently working...');

    // DOM-based detection: check for "Working" text + 3-second snapshot comparison
    console.log('  Running DOM check (3-second observation)...');
    var domResult = await this.checkAgentWorkingViaDom(page);
    console.log('  DOM check: ' + domResult.debug);

    if (domResult.working) {
      await this.waitForAgentToFinish(page);
      return;
    }

    console.log('  Replit Agent is idle. Proceeding with scraping.');
    console.log('\n========================================');
    console.log('IMPORTANT: Do NOT use Replit Agent while the scraper is running.');
    console.log('Agent activity during scraping will cause unreliable results.');
    console.log('========================================\n');
  }

  private async waitForAgentToFinish(page: Page): Promise<void> {
    console.log('\n========================================');
    console.log('WARNING: Replit Agent is currently working!');
    console.log('The scraper cannot run while the agent is active.');
    console.log('Waiting for the agent to finish...');
    console.log('========================================\n');

    var waitStart = Date.now();
    var maxWaitMs = 600000; // 10 minute max wait
    var checkCount = 0;

    while (Date.now() - waitStart < maxWaitMs) {
      await page.waitForTimeout(3000);
      checkCount++;

      var elapsedSec = Math.round((Date.now() - waitStart) / 1000);

      var domPoll = await this.checkAgentWorkingViaDom(page);
      if (!domPoll.working) {
        console.log(`  Re-check #${checkCount} (${elapsedSec}s): ${domPoll.debug}`);
        console.log(`  Agent finished working. (Waited ${elapsedSec}s)`);
        console.log('  Proceeding with scraping.\n');
        console.log('========================================');
        console.log('IMPORTANT: Do NOT use Replit Agent while the scraper is running.');
        console.log('Agent activity during scraping will cause unreliable results.');
        console.log('========================================\n');
        await page.waitForTimeout(3000);
        return;
      } else {
        console.log(`  Re-check #${checkCount} (${elapsedSec}s): ${domPoll.debug} — agent still working`);
      }
    }

    console.log('\n  WARNING: Timed out waiting for agent to finish (10 minutes).');
    console.log('  Proceeding anyway — results may be incomplete or unreliable.\n');
  }

  async scrapeGitCommits(page: Page, oldestChatTimestamp?: string | null): Promise<GitCommit[]> {
    console.log('\nStep 2: Scraping Git tab for commit history...');

    var gitPanelOpen = false;

    // Strategy 1: Find clickable elements with "Git" or "Version Control" text
    console.log('  Attempting to open Git panel...');
    var strategy1 = await page.evaluate(function() {
      var clicked = false;
      var debugInfo = [];

      // Look for tab-like elements with git text
      var candidates = document.querySelectorAll(
        '[role="tab"], [data-testid*="tab"], button, a, ' +
        '[role="button"], [class*="Tab"], [class*="tool" i], ' +
        '[class*="sidebar" i] button, [class*="sidebar" i] a, ' +
        '[class*="nav" i] button, [class*="nav" i] a, ' +
        '[class*="dock" i] button, [class*="dock" i] a, ' +
        '[class*="panel" i] button, [class*="panel" i] a'
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.textContent || '').trim().toLowerCase();
        var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        var title = (el.getAttribute('title') || '').toLowerCase();
        var testId = el.getAttribute('data-testid') || '';

        // Check text, aria-label, title for git-related content
        var isGitRelated = (
          text === 'git' ||
          text === 'version control' ||
          text === 'history' ||
          text === 'commits' ||
          ariaLabel.indexOf('git') >= 0 ||
          ariaLabel.indexOf('version control') >= 0 ||
          title.indexOf('git') >= 0 ||
          title === 'version control' ||
          testId.indexOf('git') >= 0 ||
          testId.indexOf('version-control') >= 0
        );

        if (isGitRelated) {
          debugInfo.push({
            strategy: 'text/aria match',
            tag: el.tagName,
            text: text.substring(0, 50),
            ariaLabel: ariaLabel.substring(0, 50),
            title: title.substring(0, 50),
            testId: testId,
            className: (el.getAttribute('class') || '').substring(0, 100)
          });
          el.click();
          clicked = true;
          break;
        }
      }
      return { clicked: clicked, debugInfo: debugInfo };
    });

    if (strategy1.clicked) {
      await page.waitForTimeout(3000);
    }

    // Verify Git panel opened by checking for commit-related content
    gitPanelOpen = await this.verifyGitPanelOpen(page);

    // Strategy 2: Look for SVG icons that look like git branch icons
    if (!gitPanelOpen) {
      
      var strategy2 = await page.evaluate(function() {
        var clicked = false;
        var debugInfo = [];
        // Git branch icon typically has a fork/branch SVG path
        // Look for buttons/links containing SVG with git-related paths
        var svgContainers = document.querySelectorAll('button, a, [role="button"], [role="tab"]');
        for (var i = 0; i < svgContainers.length; i++) {
          var el = svgContainers[i];
          var svg = el.querySelector('svg');
          if (!svg) continue;
          // Check if the SVG has git-branch-like content or the element has git hints
          var svgContent = svg.outerHTML.toLowerCase();
          var elText = (el.textContent || '').trim().toLowerCase();
          var elTitle = (el.getAttribute('title') || '').toLowerCase();
          var elAria = (el.getAttribute('aria-label') || '').toLowerCase();
          // Git branch icon heuristic: path elements with fork shapes, or "gitBranch" in class/id
          var hasGitHint = (
            svgContent.indexOf('gitbranch') >= 0 ||
            svgContent.indexOf('git-branch') >= 0 ||
            svgContent.indexOf('branch') >= 0 ||
            svgContent.indexOf('merge') >= 0 ||
            svgContent.indexOf('fork') >= 0 ||
            elTitle.indexOf('git') >= 0 ||
            elAria.indexOf('git') >= 0 ||
            elText === 'git'
          );
          if (hasGitHint) {
            debugInfo.push({
              strategy: 'svg icon',
              tag: el.tagName,
              text: elText.substring(0, 50),
              title: elTitle,
              ariaLabel: elAria,
              svgPreview: svgContent.substring(0, 200)
            });
            el.click();
            clicked = true;
            break;
          }
        }
        return { clicked: clicked, debugInfo: debugInfo };
      });

      if (strategy2.clicked) {
        await page.waitForTimeout(3000);
        gitPanelOpen = await this.verifyGitPanelOpen(page);
      }
    }

    // Strategy 3: Look for any element whose tooltip or nearby text references git
    if (!gitPanelOpen) {
      
      var strategy3 = await page.evaluate(function() {
        var clicked = false;
        var debugInfo = [];
        // Look through ALL buttons and interactive elements
        var allInteractive = document.querySelectorAll(
          'button, a, [role="button"], [role="tab"], ' +
          '[tabindex="0"], [class*="clickable" i], [class*="Clickable"]'
        );
        for (var i = 0; i < allInteractive.length; i++) {
          var el = allInteractive[i];
          var allAttrs = '';
          for (var a = 0; a < el.attributes.length; a++) {
            allAttrs += el.attributes[a].name + '=' + el.attributes[a].value + ' ';
          }
          var allAttrsLower = allAttrs.toLowerCase();
          if (allAttrsLower.indexOf('git') >= 0 || allAttrsLower.indexOf('version-control') >= 0 || allAttrsLower.indexOf('vcs') >= 0) {
            debugInfo.push({
              strategy: 'attr scan',
              tag: el.tagName,
              attrs: allAttrs.substring(0, 300),
              text: (el.textContent || '').trim().substring(0, 50)
            });
            el.click();
            clicked = true;
            break;
          }
        }
        return { clicked: clicked, debugInfo: debugInfo };
      });

      if (strategy3.clicked) {
        await page.waitForTimeout(3000);
        gitPanelOpen = await this.verifyGitPanelOpen(page);
      }
    }

    // Strategy 4: Keyboard shortcut
    if (!gitPanelOpen) {
      console.log('  No Git panel found via DOM. Trying keyboard shortcut (Ctrl+Shift+G)...');
      await page.keyboard.press('Control+Shift+G');
      await page.waitForTimeout(3000);
      gitPanelOpen = await this.verifyGitPanelOpen(page);
    }

    // Strategy 5: Try clicking on the "Commits" sub-tab if we're in the Git panel but on wrong sub-tab
    if (!gitPanelOpen) {
      console.log('  Keyboard shortcut did not open Git panel. Trying to find Commits sub-tab...');
      var clickedCommitsTab = await page.evaluate(function() {
        var allEls = document.querySelectorAll('button, a, [role="tab"], [role="button"]');
        for (var i = 0; i < allEls.length; i++) {
          var text = (allEls[i].textContent || '').trim().toLowerCase();
          if (text === 'commits' || text === 'commit history' || text === 'all commits') {
            allEls[i].click();
            return true;
          }
        }
        return false;
      });
      if (clickedCommitsTab) {
        console.log('  Found and clicked "Commits" sub-tab');
        await page.waitForTimeout(2000);
        gitPanelOpen = await this.verifyGitPanelOpen(page);
      }
    }

    if (!gitPanelOpen) {
      console.log('  WARNING: Could not verify Git panel is open. Will attempt commit extraction anyway.');
      console.log('  Saving diagnostic DOM snapshot...');
      await this.saveGitNavDebug(page);
    } else {
      console.log('  Git panel verified open.');
    }

    // Always try to switch to "Commits" sub-tab (even if git panel is already open,
    // we might be on the "Changes" tab instead of "Commits")
    var switchedToCommits = await page.evaluate(function() {
      var candidates = document.querySelectorAll('button, a, [role="tab"], [role="button"], span');
      for (var i = 0; i < candidates.length; i++) {
        var text = (candidates[i].textContent || '').trim().toLowerCase();
        var el = candidates[i];
        if (text === 'commits' || text === 'commit history' || text === 'all commits') {
          var isClickable = el.tagName === 'BUTTON' || el.tagName === 'A' ||
            el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'button' ||
            el.getAttribute('tabindex') !== null ||
            (el.parentElement && (el.parentElement.tagName === 'BUTTON' || el.parentElement.getAttribute('role') === 'tab'));
          if (isClickable) {
            el.click();
            return true;
          }
          if (el.parentElement) {
            el.parentElement.click();
            return true;
          }
        }
      }
      return false;
    });
    if (switchedToCommits) {
      console.log('  Clicked "Commits" sub-tab to ensure commit list is visible');
      await page.waitForTimeout(2000);
    }

    // Scroll to load commits (limited by oldest chat timestamp if available)
    var scrollAttempts = 0;
    var maxScrollAttempts = 2;
    var maxCommitCap = 100;
    var lastCommitCount = 0;
    var stableRounds = 0;
    var cutoffDate = oldestChatTimestamp ? new Date(oldestChatTimestamp) : null;
    if (cutoffDate) {
      // Add 1-day buffer before oldest chat timestamp
      cutoffDate = new Date(cutoffDate.getTime() - 86400000);
      console.log(`  Limiting Git scroll to commits after: ${cutoffDate.toISOString().split('T')[0]}`);
    }

    while (scrollAttempts < maxScrollAttempts) {
      var currentCount = await page.evaluate(function() {
        // Count timestamp-bearing elements inside the git panel as a proxy for commit count
        var timePattern = /\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago/i;
        var absTimePattern = /\d{1,2}:\d{2}\s*(?:am|pm)/i;
        var absDatePattern = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i;
        var count = 0;

        // Find the git panel by content
        var panels = document.querySelectorAll('[role="tabpanel"]');
        var gitPanel = null;
        for (var p = 0; p < panels.length; p++) {
          var style = window.getComputedStyle(panels[p]);
          if (style.opacity === '0' || style.display === 'none') continue;
          var pText = (panels[p].textContent || '').substring(0, 2000);
          if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
            gitPanel = panels[p];
            break;
          }
        }
        if (!gitPanel) return 0;

        // Count elements with timestamps inside the git panel (each commit has a timestamp)
        var allEls = gitPanel.querySelectorAll('*');
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          if (el.children.length > 0) continue;
          var txt = (el.textContent || '').trim();
          if (txt.length > 3 && txt.length < 80) {
            if (timePattern.test(txt) || absTimePattern.test(txt) || absDatePattern.test(txt)) {
              // Exclude header timestamps like "last fetched X ago"
              if (txt.indexOf('last fetched') < 0) {
                count++;
              }
            }
          }
        }
        return count;
      });

      if (currentCount >= maxCommitCap) {
        console.log(`  Reached commit cap (${maxCommitCap}) — stopping scroll`);
        lastCommitCount = currentCount;
        break;
      }

      if (currentCount === lastCommitCount) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
        lastCommitCount = currentCount;
      }

      // Check if oldest visible commit is already older than the chat cutoff
      if (cutoffDate) {
        var oldestCommitTs = await page.evaluate(function() {
          var timePattern = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i;
          var absDatePattern = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})(?:,?\s*(\d{4}))?/i;

          var panels = document.querySelectorAll('[role="tabpanel"]');
          var gitPanel = null;
          for (var p = 0; p < panels.length; p++) {
            var style = window.getComputedStyle(panels[p]);
            if (style.opacity === '0' || style.display === 'none') continue;
            var pText = (panels[p].textContent || '').substring(0, 2000);
            if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
              gitPanel = panels[p];
              break;
            }
          }
          if (!gitPanel) return null;

          var timestamps = [];
          var allEls = gitPanel.querySelectorAll('*');
          for (var i = 0; i < allEls.length; i++) {
            var el = allEls[i];
            if (el.children.length > 0) continue;
            var txt = (el.textContent || '').trim();
            if (txt.length < 3 || txt.length > 80) continue;
            if (txt.indexOf('last fetched') >= 0) continue;

            var relMatch = txt.match(timePattern);
            if (relMatch) {
              var amount = parseInt(relMatch[1], 10);
              var unit = relMatch[2].toLowerCase();
              var ms = 0;
              if (unit === 'second') ms = amount * 1000;
              else if (unit === 'minute') ms = amount * 60000;
              else if (unit === 'hour') ms = amount * 3600000;
              else if (unit === 'day') ms = amount * 86400000;
              else if (unit === 'week') ms = amount * 604800000;
              else if (unit === 'month') ms = amount * 2592000000;
              else if (unit === 'year') ms = amount * 31536000000;
              timestamps.push(Date.now() - ms);
              continue;
            }

            var absMatch = txt.match(absDatePattern);
            if (absMatch) {
              var monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
              var mon = monthMap[absMatch[1].substring(0, 3).toLowerCase()];
              var day = parseInt(absMatch[2], 10);
              var year = absMatch[3] ? parseInt(absMatch[3], 10) : new Date().getFullYear();
              timestamps.push(new Date(year, mon, day).getTime());
            }
          }

          if (timestamps.length === 0) return null;
          return Math.min.apply(null, timestamps);
        });

        if (oldestCommitTs) {
          var oldestCommitDate = new Date(oldestCommitTs);
          if (oldestCommitDate < cutoffDate) {
            console.log(`  Git commits reach ${oldestCommitDate.toISOString().split('T')[0]} (before chat cutoff) — stopping scroll`);
            break;
          }
        }
      }

      await page.evaluate(function() {
        // Find the git panel's scrollable container by content and scroll it
        var panels = document.querySelectorAll('[role="tabpanel"]');
        var scrolled = false;
        for (var p = 0; p < panels.length; p++) {
          var style = window.getComputedStyle(panels[p]);
          if (style.opacity === '0' || style.display === 'none') continue;
          var pText = (panels[p].textContent || '').substring(0, 2000);
          if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
            // Found git panel - look for scrollable children
            var scrollables = panels[p].querySelectorAll('*');
            for (var s = 0; s < scrollables.length; s++) {
              var sel = scrollables[s];
              if (sel.scrollHeight > sel.clientHeight + 50) {
                sel.scrollTop = sel.scrollHeight;
                scrolled = true;
                break;
              }
            }
            break;
          }
        }
        if (!scrolled) {
          window.scrollTo(0, document.body.scrollHeight);
        }
      });

      var loadMoreBtn = await page.evaluate(function() {
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var text = (buttons[i].textContent || '').trim().toLowerCase();
          if (text.indexOf('load more') >= 0 || text.indexOf('show more') >= 0 ||
              text.indexOf('older') >= 0) {
            buttons[i].click();
            return true;
          }
        }
        return false;
      });

      await page.waitForTimeout(loadMoreBtn ? 2000 : 1000);
      scrollAttempts++;
    }

    console.log(`  Scrolled Git tab (${scrollAttempts} rounds, found ~${lastCommitCount} commit elements)`);

    // Step 2b: Click ONE relative timestamp to convert ALL to absolute
    console.log('  Step 2b: Clicking a relative timestamp to convert all to absolute...');
    var clickedRelativeTs = await this.clickOneRelativeTimestamp(page);
    if (clickedRelativeTs) {
      console.log('  Successfully clicked relative timestamp - all timestamps should now be absolute');
      await page.waitForTimeout(1000);
    } else {
      console.log('  No relative timestamps found to click (may already be absolute)');
    }

    // Save Git tab DOM debug (comprehensive)
    try {
      var gitDebug = await page.evaluate(function() {
        var panels = document.querySelectorAll('[role="tabpanel"]');
        var panelInfo = [];
        for (var pi = 0; pi < panels.length && pi < 10; pi++) {
          var p = panels[pi];
          panelInfo.push({
            tag: p.tagName,
            className: (p.getAttribute('class') || '').substring(0, 300),
            role: p.getAttribute('role') || '',
            childCount: p.children.length,
            textPreview: (p.textContent || '').substring(0, 500),
            outerHTMLPreview: p.outerHTML.substring(0, 800)
          });
        }

        // Find git panel by content and capture commit-bearing elements
        var gitPanel = null;
        for (var gp = 0; gp < panels.length; gp++) {
          var style = window.getComputedStyle(panels[gp]);
          if (style.opacity === '0' || style.display === 'none') continue;
          var gpText = (panels[gp].textContent || '').substring(0, 2000);
          if (gpText.indexOf('Sync Changes') >= 0 || gpText.indexOf('Remote Updates') >= 0) {
            gitPanel = panels[gp];
            break;
          }
        }

        var commitInfo = [];
        if (gitPanel) {
          var timePattern = /\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago/i;
          var absPattern = /\d{1,2}:\d{2}\s*(?:am|pm)/i;
          var allEls = gitPanel.querySelectorAll('*');
          for (var ci = 0; ci < allEls.length && commitInfo.length < 15; ci++) {
            var c = allEls[ci];
            if (c.children.length > 0) continue;
            var cText = (c.textContent || '').trim();
            if (cText.length < 3 || cText.length > 80) continue;
            if (cText.indexOf('last fetched') >= 0) continue;
            if (timePattern.test(cText) || absPattern.test(cText)) {
              var container = c.parentElement;
              commitInfo.push({
                tag: c.tagName,
                className: (c.getAttribute('class') || '').substring(0, 300),
                timestamp: cText,
                containerText: container ? (container.textContent || '').trim().substring(0, 300) : '',
                containerTag: container ? container.tagName : ''
              });
            }
          }
        }

        // Also capture list items and scrollable containers (possible commit list containers)
        var listItems = document.querySelectorAll('li, [role="listitem"], [role="option"]');
        var listInfo = [];
        for (var li = 0; li < listItems.length && li < 20; li++) {
          var item = listItems[li];
          var parentCls = item.parentElement ? (item.parentElement.getAttribute('class') || '').substring(0, 100) : '';
          listInfo.push({
            tag: item.tagName,
            className: (item.getAttribute('class') || '').substring(0, 200),
            parentClassName: parentCls,
            textPreview: (item.textContent || '').substring(0, 200)
          });
        }

        // Capture scrollable containers (potential commit list wrappers)
        var allEls = document.querySelectorAll('div, section, ul, ol');
        var scrollable = [];
        for (var si = 0; si < allEls.length && scrollable.length < 10; si++) {
          var sel = allEls[si];
          if (sel.scrollHeight > sel.clientHeight + 50 && sel.clientHeight > 50) {
            scrollable.push({
              tag: sel.tagName,
              className: (sel.getAttribute('class') || '').substring(0, 200),
              role: sel.getAttribute('role') || '',
              scrollHeight: sel.scrollHeight,
              clientHeight: sel.clientHeight,
              childCount: sel.children.length,
              textPreview: (sel.textContent || '').substring(0, 300)
            });
          }
        }

        return {
          url: window.location.href,
          panels: panelInfo,
          commitTimestamps: commitInfo,
          totalCommitTimestamps: commitInfo.length,
          gitPanelFound: !!gitPanel,
          listItems: listInfo,
          scrollableContainers: scrollable,
          totalListItems: listItems.length
        };
      });
      var gitDebugPath = path.join('exports', 'git-tab-debug.json');
      fs.writeFileSync(gitDebugPath, JSON.stringify(gitDebug, null, 2));
      console.log(`  Git tab debug saved: ${gitDebugPath}`);
      console.log(`  Debug: ${gitDebug.totalCommitTimestamps} commit timestamps found, git panel: ${gitDebug.gitPanelFound}, ${gitDebug.scrollableContainers.length} scrollable containers`);
    } catch (err) {
      console.log('  Note: Could not save Git tab debug info');
    }

    // Step 2c: Extract commits using content-based detection
    // Replit uses hashed module class names (no "commit" substring), so we find commits
    // by locating the git panel via content and identifying repeating entry patterns
    var commits: GitCommit[] = await page.evaluate(function() {
      var results = [];
      var relTimePattern = /\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago/i;
      var absTimePattern = /\d{1,2}:\d{2}\s*(?:am|pm)/i;
      var absDatePattern = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i;
      var justNowPattern = /^just\s+now$/i;

      // Known non-commit text to skip
      var skipTexts = [
        'remote updates', 'sync changes', 'pull', 'push', 'commit',
        'there are no changes to commit', 'commit & push', 'commit all',
        'last fetched', 'origin/main', 'upstream', 'main'
      ];

      // Step 1: Find the git panel by content (visible [role="tabpanel"] with git keywords)
      var panels = document.querySelectorAll('[role="tabpanel"]');
      var gitPanel = null;
      for (var p = 0; p < panels.length; p++) {
        var style = window.getComputedStyle(panels[p]);
        if (style.opacity === '0' || style.display === 'none') continue;
        var pText = (panels[p].textContent || '').substring(0, 2000);
        if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
          gitPanel = panels[p];
          break;
        }
      }
      if (!gitPanel) return results;

      // Step 2: Find all leaf-level timestamp elements inside the git panel
      // Each commit entry has exactly one timestamp element
      var allEls = gitPanel.querySelectorAll('*');
      var timestampEls = [];
      for (var t = 0; t < allEls.length; t++) {
        var el = allEls[t];
        if (el.children.length > 0) continue;
        var txt = (el.textContent || '').trim();
        if (txt.length < 3 || txt.length > 80) continue;
        if (txt.indexOf('last fetched') >= 0) continue;
        if (relTimePattern.test(txt) || absTimePattern.test(txt) ||
            absDatePattern.test(txt) || justNowPattern.test(txt)) {
          timestampEls.push(el);
        }
      }

      // Step 3: For each timestamp element, walk up to find the commit entry container,
      // then extract the commit message from that container
      var seen = {};
      for (var ti = 0; ti < timestampEls.length; ti++) {
        var tsEl = timestampEls[ti];
        var timestamp = (tsEl.textContent || '').trim();

        // Walk up to find the commit entry container:
        // Look for an ancestor whose parent has multiple similar children (the commit list)
        var container = tsEl;
        var commitContainer = null;
        for (var depth = 0; depth < 8; depth++) {
          var parent = container.parentElement;
          if (!parent || parent === gitPanel) break;
          // A commit list parent typically has several children (the commit entries)
          if (parent.children.length >= 3) {
            commitContainer = container;
            break;
          }
          container = parent;
        }
        if (!commitContainer) {
          // Fallback: use the timestamp's grandparent or parent
          commitContainer = tsEl.parentElement;
          if (commitContainer && commitContainer.parentElement &&
              commitContainer.parentElement !== gitPanel) {
            commitContainer = commitContainer.parentElement;
          }
        }
        if (!commitContainer) continue;

        // Step 4: Extract commit message from the container
        // The message is the longest non-timestamp, non-skip text in the container
        var containerText = (commitContainer.textContent || '').trim();
        var message = '';

        // Try to find message by looking at child elements
        var kids = commitContainer.querySelectorAll('*');
        var bestMsg = '';
        var bestLen = 0;
        for (var k = 0; k < kids.length; k++) {
          var kid = kids[k];
          if (kid.children.length > 0) continue;
          var kidText = (kid.textContent || '').trim();
          if (kidText.length < 5 || kidText.length > 500) continue;
          // Skip timestamp text
          if (relTimePattern.test(kidText) || justNowPattern.test(kidText)) continue;
          if (/^\d{1,2}:\d{2}\s*(?:am|pm)/i.test(kidText)) continue;
          if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/i.test(kidText)) continue;
          // Skip short author initials (1-3 chars) and known skip texts
          if (kidText.length <= 3) continue;
          var kidLower = kidText.toLowerCase();
          var isSkip = false;
          for (var si = 0; si < skipTexts.length; si++) {
            if (kidLower === skipTexts[si]) { isSkip = true; break; }
          }
          if (isSkip) continue;
          // Prefer the longest descriptive text as the commit message
          if (kidText.length > bestLen) {
            bestMsg = kidText;
            bestLen = kidText.length;
          }
        }
        message = bestMsg;

        // Fallback: parse container text line by line
        if (!message) {
          var lines = containerText.split('\n');
          for (var ln = 0; ln < lines.length; ln++) {
            var line = lines[ln].trim();
            if (line.length < 5 || line.length > 500) continue;
            if (relTimePattern.test(line) || justNowPattern.test(line)) continue;
            if (/^\d{1,2}:\d{2}\s*(?:am|pm)/i.test(line)) continue;
            var lineLower = line.toLowerCase();
            var lineSkip = false;
            for (var ls = 0; ls < skipTexts.length; ls++) {
              if (lineLower === skipTexts[ls]) { lineSkip = true; break; }
            }
            if (lineSkip) continue;
            if (line.length <= 3) continue;
            message = line;
            break;
          }
        }

        if (!message) continue;

        // Step 5: Extract hash if present
        var hashEl = commitContainer.querySelector(
          '[class*="hash" i], [class*="sha" i], code, [class*="commit-id" i]'
        );
        var hash = hashEl ? (hashEl.textContent || '').trim() : null;
        if (hash && hash.length > 40) hash = null;

        // Deduplicate by message+timestamp
        var key = message + '|' + timestamp;
        if (seen[key]) continue;
        seen[key] = true;

        results.push({ message: message, timestamp: timestamp, hash: hash });
      }

      return results;
    });

    var withTs = commits.filter(function(c) { return c.timestamp !== null; }).length;
    console.log(`  Git commits: ${commits.length} total, ${withTs} with absolute timestamps`);

    return commits;
  }

  private async verifyGitPanelOpen(page: Page): Promise<boolean> {
    return await page.evaluate(function() {
      // Content-based detection: find a visible [role="tabpanel"] whose text
      // contains distinctive git-panel keywords (works regardless of hashed class names)
      var panels = document.querySelectorAll('[role="tabpanel"]');
      for (var i = 0; i < panels.length; i++) {
        var panel = panels[i];
        var style = window.getComputedStyle(panel);
        if (style.opacity === '0' || style.display === 'none') continue;
        var text = (panel.textContent || '').substring(0, 2000);
        var hasSyncChanges = text.indexOf('Sync Changes') >= 0;
        var hasRemoteUpdates = text.indexOf('Remote Updates') >= 0;
        var hasPullPush = text.indexOf('Pull') >= 0 && text.indexOf('Push') >= 0;
        var hasCommitText = text.indexOf('no changes to commit') >= 0 ||
          text.indexOf('Commit & push') >= 0 || text.indexOf('Commit all') >= 0;
        if (hasSyncChanges || hasRemoteUpdates || (hasPullPush && hasCommitText)) {
          return true;
        }
      }

      // Fallback: class-name-based detection for older UI versions
      var commitEls = document.querySelectorAll(
        '[class*="commit" i], [data-testid*="commit"], ' +
        '[class*="CommitList"], [class*="CommitEntry"], ' +
        '[class*="VersionControl" i], [class*="git-panel" i], ' +
        '[class*="GitPanel"], [class*="git-pane" i]'
      );
      if (commitEls.length > 0) return true;

      return false;
    });
  }

  private async saveGitNavDebug(page: Page): Promise<void> {
    try {
      var navDebug = await page.evaluate(function() {
        var result = {
          url: window.location.href,
          title: document.title,
          allButtons: [],
          allTabs: [],
          allLinks: [],
          sidebarElements: [],
          bodyClasses: document.body.getAttribute('class') || '',
          visiblePanels: []
        };

        // Capture all buttons with their text/attributes
        var buttons = document.querySelectorAll('button, [role="button"]');
        for (var i = 0; i < buttons.length && i < 100; i++) {
          var btn = buttons[i];
          result.allButtons.push({
            tag: btn.tagName,
            text: (btn.textContent || '').trim().substring(0, 80),
            ariaLabel: btn.getAttribute('aria-label') || '',
            title: btn.getAttribute('title') || '',
            testId: btn.getAttribute('data-testid') || '',
            className: (btn.getAttribute('class') || '').substring(0, 150),
            hasSvg: !!btn.querySelector('svg'),
            visible: btn.offsetParent !== null
          });
        }

        // Capture all tab elements
        var tabs = document.querySelectorAll('[role="tab"]');
        for (var t = 0; t < tabs.length && t < 50; t++) {
          var tab = tabs[t];
          result.allTabs.push({
            text: (tab.textContent || '').trim().substring(0, 80),
            ariaLabel: tab.getAttribute('aria-label') || '',
            ariaSelected: tab.getAttribute('aria-selected') || '',
            className: (tab.getAttribute('class') || '').substring(0, 150),
            testId: tab.getAttribute('data-testid') || ''
          });
        }

        // Capture sidebar-like elements
        var sidebars = document.querySelectorAll(
          '[class*="sidebar" i], [class*="Sidebar"], ' +
          '[class*="dock" i], [class*="Dock"], ' +
          '[class*="tools" i], [class*="Tools"], ' +
          '[class*="nav" i][class*="left" i], [class*="NavLeft"]'
        );
        for (var s = 0; s < sidebars.length && s < 10; s++) {
          var sb = sidebars[s];
          var sbChildren = [];
          for (var sc = 0; sc < sb.children.length && sc < 20; sc++) {
            var child = sb.children[sc];
            sbChildren.push({
              tag: child.tagName,
              text: (child.textContent || '').trim().substring(0, 60),
              className: (child.getAttribute('class') || '').substring(0, 100),
              ariaLabel: child.getAttribute('aria-label') || '',
              title: child.getAttribute('title') || ''
            });
          }
          result.sidebarElements.push({
            className: (sb.getAttribute('class') || '').substring(0, 150),
            childCount: sb.children.length,
            children: sbChildren
          });
        }

        // Capture visible panels
        var panels = document.querySelectorAll('[role="tabpanel"], [class*="panel" i], [class*="Panel"]');
        for (var p = 0; p < panels.length && p < 10; p++) {
          var panel = panels[p];
          if (panel.offsetParent !== null) {
            result.visiblePanels.push({
              tag: panel.tagName,
              className: (panel.getAttribute('class') || '').substring(0, 150),
              role: panel.getAttribute('role') || '',
              textPreview: (panel.textContent || '').substring(0, 300)
            });
          }
        }

        return result;
      });

      var debugPath = path.join('exports', 'git-nav-debug.json');
      try { fs.mkdirSync('exports', { recursive: true }); } catch(e) {}
      fs.writeFileSync(debugPath, JSON.stringify(navDebug, null, 2));
      console.log(`  Navigation debug saved: ${debugPath}`);
      console.log(`  Current URL: ${navDebug.url}`);
      console.log(`  Buttons found: ${navDebug.allButtons.length}, Tabs found: ${navDebug.allTabs.length}`);
      console.log(`  Sidebar elements: ${navDebug.sidebarElements.length}`);
    } catch (err) {
      console.log('  Could not save navigation debug info');
    }
  }

  private async convertTimestampsViaGitTab(page: Page): Promise<void> {
    console.log('  Opening Git tab to convert relative timestamps...');

    var gitPanelOpen = false;

    var strategy1 = await page.evaluate(function() {
      var clicked = false;
      var candidates = document.querySelectorAll(
        '[role="tab"], [data-testid*="tab"], button, a, ' +
        '[role="button"], [class*="Tab"], [class*="tool" i], ' +
        '[class*="sidebar" i] button, [class*="sidebar" i] a, ' +
        '[class*="nav" i] button, [class*="nav" i] a, ' +
        '[class*="dock" i] button, [class*="dock" i] a, ' +
        '[class*="panel" i] button, [class*="panel" i] a'
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.textContent || '').trim().toLowerCase();
        var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        var title = (el.getAttribute('title') || '').toLowerCase();
        var testId = el.getAttribute('data-testid') || '';

        var isGitRelated = (
          text === 'git' ||
          text === 'version control' ||
          text === 'history' ||
          text === 'commits' ||
          ariaLabel.indexOf('git') >= 0 ||
          ariaLabel.indexOf('version control') >= 0 ||
          title.indexOf('git') >= 0 ||
          title === 'version control' ||
          testId.indexOf('git') >= 0 ||
          testId.indexOf('version-control') >= 0
        );

        if (isGitRelated) {
          el.click();
          clicked = true;
          break;
        }
      }
      return { clicked: clicked };
    });

    if (strategy1.clicked) {
      await page.waitForTimeout(2000);
      gitPanelOpen = await this.verifyGitPanelOpen(page);
    }

    if (!gitPanelOpen) {
      var strategy2 = await page.evaluate(function() {
        var clicked = false;
        var svgContainers = document.querySelectorAll('button, a, [role="button"], [role="tab"]');
        for (var i = 0; i < svgContainers.length; i++) {
          var el = svgContainers[i];
          var svg = el.querySelector('svg');
          if (!svg) continue;
          var paths = svg.querySelectorAll('path, circle, line');
          if (paths.length >= 2 && paths.length <= 8) {
            var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            var title = (el.getAttribute('title') || '').toLowerCase();
            if (ariaLabel.indexOf('git') >= 0 || title.indexOf('git') >= 0 ||
                ariaLabel.indexOf('version') >= 0 || title.indexOf('version') >= 0) {
              el.click();
              clicked = true;
              break;
            }
          }
        }
        return { clicked: clicked };
      });

      if (strategy2.clicked) {
        await page.waitForTimeout(2000);
        gitPanelOpen = await this.verifyGitPanelOpen(page);
      }
    }

    if (!gitPanelOpen) {
      try {
        await page.keyboard.press('Control+Shift+G');
        await page.waitForTimeout(2000);
        gitPanelOpen = await this.verifyGitPanelOpen(page);
      } catch (err) {}
    }

    if (!gitPanelOpen) {
      console.log('  Could not open Git tab — timestamps may remain relative');
      return;
    }

    console.log('  Git panel opened, looking for relative timestamps...');

    var clickedRelativeTs = await this.clickOneRelativeTimestamp(page);
    if (clickedRelativeTs) {
      var converted = false;
      for (var pollAttempt = 0; pollAttempt < 5; pollAttempt++) {
        await page.waitForTimeout(100);
        var stillRelative = await this.hasRelativeTimestamps(page);
        if (!stillRelative) {
          converted = true;
          break;
        }
      }
      if (converted) {
        console.log('  Successfully converted all timestamps to absolute format');
      } else {
        console.log('  Clicked timestamp but conversion may still be in progress');
      }
    } else {
      console.log('  No relative timestamps found (may already be absolute)');
    }
  }

  private async clickOneRelativeTimestamp(page: Page): Promise<boolean> {
    // Content-based detection: find timestamp elements inside the git panel,
    // check if they're relative or absolute. If relative, click to convert all.
    var detection = await page.evaluate(function() {
      var relativePattern = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i;
      var justNowPattern = /^just\s+now$/i;
      var absoluteTimePattern = /\d{1,2}:\d{2}\s*(?:am|pm)/i;
      var absoluteDatePattern = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/i;
      var absoluteNumericDatePattern = /\d{1,2}\/\d{1,2}\/\d{2,4}/;

      // Find the git panel by content
      var panels = document.querySelectorAll('[role="tabpanel"]');
      var gitPanel = null;
      for (var p = 0; p < panels.length; p++) {
        var style = window.getComputedStyle(panels[p]);
        if (style.opacity === '0' || style.display === 'none') continue;
        var pText = (panels[p].textContent || '').substring(0, 2000);
        if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
          gitPanel = panels[p];
          break;
        }
      }
      if (!gitPanel) return { status: 'none', text: '', elIndex: -1 };

      // Find leaf-level timestamp elements (excluding "last fetched")
      var allEls = gitPanel.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.children.length > 0) continue;
        var txt = (el.textContent || '').trim();
        if (txt.length < 3 || txt.length > 80) continue;
        if (txt.indexOf('last fetched') >= 0) continue;

        if (relativePattern.test(txt) || justNowPattern.test(txt)) {
          return { status: 'relative', text: txt, elIndex: i };
        }
        if (absoluteTimePattern.test(txt) || absoluteDatePattern.test(txt) || absoluteNumericDatePattern.test(txt)) {
          return { status: 'absolute', text: txt, elIndex: i };
        }
      }

      return { status: 'none', text: '', elIndex: -1 };
    });

    if (detection.status === 'absolute') {
      console.log(`  Timestamps already absolute ("${detection.text}"). No click needed.`);
      return true;
    }

    if (detection.status === 'none') {
      console.log('  No commit entries with recognizable timestamps found in Git tab.');
      return false;
    }

    // Status is 'relative' — click it to convert all timestamps
    console.log(`  Found relative timestamp "${detection.text}". Clicking to convert...`);

    var clicked = await page.evaluate(function(targetElIndex) {
      // Re-find the git panel and its elements
      var panels = document.querySelectorAll('[role="tabpanel"]');
      var gitPanel = null;
      for (var p = 0; p < panels.length; p++) {
        var style = window.getComputedStyle(panels[p]);
        if (style.opacity === '0' || style.display === 'none') continue;
        var pText = (panels[p].textContent || '').substring(0, 2000);
        if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
          gitPanel = panels[p];
          break;
        }
      }
      if (!gitPanel) return null;

      var allEls = gitPanel.querySelectorAll('*');
      if (targetElIndex >= 0 && targetElIndex < allEls.length) {
        var el = allEls[targetElIndex];
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return 'clicked-timestamp';
      }
      return null;
    }, detection.elIndex);

    if (!clicked) {
      console.log('  Could not click the relative timestamp element.');
      return false;
    }

    console.log(`  Click executed (${clicked}).`);
    return true;
  }

  private async hasRelativeTimestamps(page: Page): Promise<boolean> {
    return page.evaluate(function() {
      var relativePattern = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i;
      var justNowPattern = /^just\s+now$/i;
      var panels = document.querySelectorAll('[role="tabpanel"]');
      for (var p = 0; p < panels.length; p++) {
        var style = window.getComputedStyle(panels[p]);
        if (style.opacity === '0' || style.display === 'none') continue;
        var pText = (panels[p].textContent || '').substring(0, 2000);
        if (pText.indexOf('Sync Changes') >= 0 || pText.indexOf('Remote Updates') >= 0) {
          var allEls = panels[p].querySelectorAll('*');
          for (var i = 0; i < allEls.length; i++) {
            var el = allEls[i];
            if (el.children.length > 0) continue;
            var txt = (el.textContent || '').trim();
            if (txt.length < 3 || txt.length > 80) continue;
            if (txt.indexOf('last fetched') >= 0) continue;
            if (relativePattern.test(txt) || justNowPattern.test(txt)) return true;
          }
        }
      }
      return false;
    });
  }

  private async navigateToChatPanel(page: Page, replUrl: string): Promise<void> {
    var chatClicked = await page.evaluate(function() {
      var tabs = document.querySelectorAll(
        '[role="tab"], [data-testid*="tab"], button[class*="tab" i], ' +
        'a[class*="tab" i], [class*="Tab"]'
      );
      for (var i = 0; i < tabs.length; i++) {
        var text = (tabs[i].textContent || '').trim().toLowerCase();
        if (text === 'chat' || text === 'agent' || text === 'ai' || text === 'assistant') {
          tabs[i].click();
          return true;
        }
      }
      var chatIcons = document.querySelectorAll(
        '[data-testid="chat-tab"], [data-testid*="agent-tab"], ' +
        '[aria-label*="Chat" i], [aria-label*="Agent" i], [aria-label*="AI" i]'
      );
      if (chatIcons.length > 0) {
        chatIcons[0].click();
        return true;
      }
      return false;
    });

    if (chatClicked) {
      console.log('  Clicked chat panel tab');
      await page.waitForTimeout(2000);
    } else {
      console.log('  Could not find chat tab, navigating to repl URL...');
      try {
        await page.goto(replUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        console.log('  Navigation timeout, continuing...');
      }
      await page.waitForTimeout(5000);
    }

    // Verify chat panel is loaded by checking for event containers
    var maxRetries = 3;
    for (var retry = 0; retry < maxRetries; retry++) {
      var containerCount = await page.evaluate(function() {
        return document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]').length;
      });
      if (containerCount > 0) {
        console.log(`  Chat panel confirmed (${containerCount} containers found)`);
        return;
      }
      console.log(`  Chat panel not yet loaded (attempt ${retry + 1}/${maxRetries}), waiting...`);
      if (retry < maxRetries - 1) {
        await page.waitForTimeout(3000);
        // Try navigating directly if tab click didn't work
        if (retry === 1) {
          console.log('  Retrying via direct URL navigation...');
          try {
            await page.goto(replUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch (err) {
            console.log('  Navigation timeout, continuing...');
          }
          await page.waitForTimeout(5000);
        }
      }
    }
    console.log('  WARNING: Could not confirm chat panel loaded. Extraction may be incomplete.');
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

  private async hoverDurationElements(page: Page, verbose: boolean = false): Promise<number> {
    var durationIndices: number[] = await page.evaluate(function() {
      var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
      var indices = [];
      for (var i = 0; i < containers.length; i++) {
        var el = containers[i];
        var text = (el.textContent || '').trim();
        var elClass = (el.getAttribute('class') || '').toLowerCase();
        var isEndOfRun = elClass.indexOf('endofrunsummary') >= 0 || el.querySelector('[class*="EndOfRunSummary"]') !== null;
        var hasExpandable = el.querySelector('[aria-expanded]') !== null ||
          elClass.indexOf('xpandable') >= 0 ||
          el.querySelector('[class*="xpandable"], [class*="Expandable"]') !== null;
        if (isEndOfRun || (/Worked\s+for\s+/i.test(text) && hasExpandable)) {
          indices.push(i);
        }
      }
      return indices;
    });

    if (durationIndices.length === 0) return 0;
    console.log(`  Found ${durationIndices.length} work entry containers to check for precise durations`);

    var captured = 0;

    for (var di = 0; di < durationIndices.length; di++) {
      var containerIdx = durationIndices[di];

      var durationElInfo = await page.evaluate(function(idx) {
        var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
        if (idx >= containers.length) return null;
        var el = containers[idx];

        var already = el.getAttribute('data-precise-duration');
        if (already && already.length > 0) return null;

        var titleAttr = '';
        var candidates = el.querySelectorAll('*');
        for (var ci = 0; ci < candidates.length; ci++) {
          var cand = candidates[ci];
          var ct = (cand.textContent || '').trim();
          var hasTimeWord = ct.indexOf('minute') >= 0 || ct.indexOf('second') >= 0 || ct.indexOf('hour') >= 0;
          if (!hasTimeWord) continue;
          if (ct.length > 100) continue;

          var ta = cand.getAttribute('title') || '';
          var aa = cand.getAttribute('aria-label') || '';
          if (ta && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(ta)) {
            titleAttr = ta;
            break;
          }
          if (aa && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(aa)) {
            titleAttr = aa;
            break;
          }
        }

        if (titleAttr.length > 0) {
          var cleaned = titleAttr.replace(/^Worked\s+for\s+/i, '').trim();
          el.setAttribute('data-precise-duration', cleaned);
          return null;
        }

        var durationElements = [];
        for (var si = 0; si < candidates.length; si++) {
          var sel = candidates[si];
          var st = (sel.textContent || '').trim();
          if (st.length === 0 || st.length > 60) continue;
          if (!/\d+\s*(minute|second|hour)s?/i.test(st)) continue;
          if (sel.children && sel.children.length > 3) continue;

          var sr = sel.getBoundingClientRect();
          if (sr.width > 0 && sr.height > 0) {
            durationElements.push({
              index: si,
              text: st,
              top: sr.top,
              left: sr.left,
              width: sr.width,
              height: sr.height
            });
          }
        }

        if (durationElements.length === 0) return null;

        var best = durationElements[0];
        for (var bi = 1; bi < durationElements.length; bi++) {
          if (durationElements[bi].text.length < best.text.length) {
            best = durationElements[bi];
          }
        }

        return {
          containerIdx: idx,
          elIndex: best.index,
          text: best.text,
          centerX: best.left + best.width / 2,
          centerY: best.top + best.height / 2
        };
      }, containerIdx);

      if (!durationElInfo) continue;

      // Skip hover if duration already shows only seconds (no more precision available)
      var dText = durationElInfo.text.toLowerCase();
      if (/\d+\s*seconds?/i.test(dText) && dText.indexOf('minute') < 0 && dText.indexOf('hour') < 0) {
        continue;
      }

      try {
        await page.evaluate(function(idx) {
          var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
          if (idx < containers.length) {
            containers[idx].scrollIntoView({ block: 'center', behavior: 'instant' });
          }
        }, containerIdx);
        await page.waitForTimeout(200);

        var freshCoords = await page.evaluate(function(args) {
          var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
          if (args.containerIdx >= containers.length) return null;
          var el = containers[args.containerIdx];
          var candidates = el.querySelectorAll('*');
          if (args.elIndex >= candidates.length) return null;
          var target = candidates[args.elIndex];
          var r = target.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, { containerIdx: containerIdx, elIndex: durationElInfo.elIndex });

        if (!freshCoords) continue;

        await page.mouse.move(freshCoords.x, freshCoords.y);
        await page.waitForTimeout(500);

        var tooltipText = await page.evaluate(function(info) {
          var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
          if (info.containerIdx >= containers.length) return null;
          var el = containers[info.containerIdx];

          var candidates = el.querySelectorAll('*');
          if (info.elIndex < candidates.length) {
            var hovered = candidates[info.elIndex];
            var ta = hovered.getAttribute('title') || '';
            var aa = hovered.getAttribute('aria-label') || '';
            if (ta && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(ta) && ta.length < 100) {
              return ta.replace(/^Worked\s+for\s+/i, '').trim();
            }
            if (aa && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(aa) && aa.length < 100) {
              return aa.replace(/^Worked\s+for\s+/i, '').trim();
            }
          }

          var tooltipSelectors = [
            '[role="tooltip"]',
            '[class*="tooltip" i]',
            '[class*="Tooltip"]',
            '[class*="popover" i]',
            '[class*="Popover"]',
            '[data-radix-popper-content-wrapper]',
            '[data-state="open"][class*="Content"]',
            '[data-side]'
          ];
          var allTooltips = document.querySelectorAll(tooltipSelectors.join(', '));
          for (var ti = 0; ti < allTooltips.length; ti++) {
            var tt = (allTooltips[ti].textContent || '').trim();
            if (tt.length > 0 && tt.length < 150 && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(tt)) {
              return tt.replace(/^Worked\s+for\s+/i, '').trim();
            }
          }

          return null;
        }, durationElInfo);

        if (tooltipText) {
          await page.evaluate(function(args) {
            var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
            if (args.idx < containers.length) {
              containers[args.idx].setAttribute('data-precise-duration', args.duration);
            }
          }, { idx: containerIdx, duration: tooltipText });
          if (verbose) {
            console.log(`  [Hover] Container ${containerIdx}: "${durationElInfo.text}" -> "${tooltipText}"`);
          }
          captured++;
        }

        await page.mouse.move(0, 0);
        await page.waitForTimeout(100);
      } catch (e) {
        // Skip on hover error
      }
    }

    return captured;
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
      var innerRaw = (el.innerText || rawText).trim();

      var evClass = (el.getAttribute('class') || '').toLowerCase();
      var evEventType = (el.getAttribute('data-event-type') || '').toLowerCase();
      var evCy = (el.getAttribute('data-cy') || '').toLowerCase();

      // === STEP 1: Classify entry type BEFORE timestamp extraction ===
      var innerUserMarker = el.querySelector('[data-cy="user-message"], [data-event-type="user-message"], [class*="userMessage"], [class*="UserMessage"]');
      var innerCheckpointMarker = el.querySelector('[class*="checkpoint"], [class*="Checkpoint"], [data-event-type*="checkpoint"]');

      var endOfRunRoot = el.querySelector('[class*="EndOfRunSummary"]');
      if (!endOfRunRoot) {
        var ownClass = el.getAttribute('class') || '';
        if (ownClass.indexOf('EndOfRunSummary') >= 0) endOfRunRoot = el;
      }
      var workedMatch = rawText.match(/Worked\s+for\s+(\d+\s*(?:second|minute|hour|day|week|month|year)s?(?:\s*(?:and\s*)?\d+\s*(?:second|minute|hour|day|week|month|year)s?)*)/i);

      var isExpandableWork = false;
      if (workedMatch && !endOfRunRoot) {
        var hasExpanded = el.querySelector('[aria-expanded]') !== null;
        var hasExpandable = (el.getAttribute('class') || '').indexOf('xpandable') >= 0 ||
          el.querySelector('[class*="xpandable"], [class*="Expandable"]') !== null;
        isExpandableWork = hasExpanded || hasExpandable;
      }

      var isWorkEntry = !!(endOfRunRoot || (workedMatch && isExpandableWork));

      var isCheckpoint = evClass.indexOf('checkpoint') >= 0 ||
        evEventType.indexOf('checkpoint') >= 0 ||
        innerCheckpointMarker !== null ||
        (rawText.indexOf('Checkpoint') >= 0 && rawText.length < 500);

      // TIMESTAMP RULES (explicit per entry type):
      // - Work entries: always inherit from preceding checkpoint (prevTimestamp)
      // - Checkpoints: timestamp is embedded in their own container text
      // - Messages: timestamp is in a following sibling element outside the container;
      //   fall back to prevTimestamp if not found

      // === STEP 2: Entry-type-specific timestamp extraction ===
      var timestamp = null;

      if (isWorkEntry) {
        // Work entries never have their own timestamp; inherit from preceding checkpoint
        timestamp = prevTimestamp;

      } else if (isCheckpoint) {
        // Checkpoints: search inside the container only (timestamp embedded in text)
        var cpRealTsMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
        if (cpRealTsMatch) {
          timestamp = cpRealTsMatch[1];
        }
        if (!timestamp) {
          var cpTsModuleEls = el.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
          for (var cpTmi = 0; cpTmi < cpTsModuleEls.length; cpTmi++) {
            var cpTmText = (cpTsModuleEls[cpTmi].textContent || '').trim();
            if (cpTmText.length > 0 && cpTmText.length < 100) {
              var cpIsRelative = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i.test(cpTmText);
              if (!cpIsRelative) {
                timestamp = cpTmText;
                break;
              }
            }
          }
        }
        if (!timestamp) {
          var cpTimeEl = el.querySelector('time');
          if (cpTimeEl) {
            var cpDt = cpTimeEl.getAttribute('datetime');
            if (cpDt) timestamp = cpDt;
            else {
              var cpTt = (cpTimeEl.textContent || '').trim();
              if (cpTt.length > 0 && cpTt.length < 100) timestamp = cpTt;
            }
          }
        }
        if (!timestamp) timestamp = prevTimestamp;

      } else {
        // Messages: search inside container first
        var realTsMatch = rawText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
        if (realTsMatch) timestamp = realTsMatch[1];

        if (!timestamp) {
          var tsModuleEls = el.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]');
          for (var tmi = 0; tmi < tsModuleEls.length; tmi++) {
            var tmText = (tsModuleEls[tmi].textContent || '').trim();
            if (tmText.length > 0 && tmText.length < 100) {
              var isRelative = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i.test(tmText);
              if (!isRelative) {
                timestamp = tmText;
                break;
              }
            }
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

        // For messages: check next sibling element(s) for timestamp
        if (!timestamp) {
          var nextSib = el.nextElementSibling;
          var sibChecked = 0;
          while (nextSib && sibChecked < 3 && !timestamp) {
            var sibText = (nextSib.textContent || '').trim();
            var sibTsMatch = sibText.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
            if (sibTsMatch) {
              timestamp = sibTsMatch[1];
              break;
            }
            var sibTsModules = nextSib.querySelectorAll ? nextSib.querySelectorAll('[class*="Timestamp-module"], [class*="timestamp-module"]') : [];
            for (var stm = 0; stm < sibTsModules.length; stm++) {
              var stmText = (sibTsModules[stm].textContent || '').trim();
              if (stmText.length > 0 && stmText.length < 100) {
                var stmRelative = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i.test(stmText);
                if (!stmRelative) {
                  timestamp = stmText;
                  break;
                }
              }
            }
            if (timestamp) break;
            var sibTimeEl = nextSib.querySelector ? nextSib.querySelector('time') : null;
            if (sibTimeEl) {
              var sibDt = sibTimeEl.getAttribute('datetime');
              if (sibDt) { timestamp = sibDt; break; }
              var sibTt = (sibTimeEl.textContent || '').trim();
              if (sibTt.length > 0 && sibTt.length < 100) { timestamp = sibTt; break; }
            }
            nextSib = nextSib.nextElementSibling;
            sibChecked++;
          }
        }

        if (!timestamp) timestamp = prevTimestamp;
      }

      // === STEP 3: Build and return entry based on type ===

      if (isWorkEntry) {
        var wDuration = workedMatch ? workedMatch[1] : '';

        var hoverPrecise = el.getAttribute('data-precise-duration');
        if (hoverPrecise && hoverPrecise.length > 0 && /\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(hoverPrecise)) {
          wDuration = hoverPrecise;
        } else {
          var preciseDuration = null;
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

        var totalCharge = null;
        var costMatches = rawText.match(/\$[\d.]+/g);
        if (costMatches && costMatches.length > 0) {
          totalCharge = parseFloat(costMatches[0].substring(1));
          if (isNaN(totalCharge)) totalCharge = null;
        }

        return {
          entryType: 'work',
          containerIdx: idx,
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

      if (isCheckpoint) {
        var cpDescription = rawText
          .replace(/Checkpoint\s+made\s*/i, '')
          .replace(/\d+\s+(?:second|minute|hour|day|week|month|year)s?\s*ago\s*/gi, '')
          .replace(/\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4}/gi, '')
          .replace(/Rollback\s+here/gi, '').replace(/Preview/gi, '').replace(/Changes/gi, '').trim();

        var costMatch = rawText.match(/\$[\d.]+/);
        return {
          entryType: 'checkpoint',
          containerIdx: idx,
          timestamp: timestamp,
          description: cpDescription.substring(0, 1000),
          cost: costMatch ? costMatch[0] : null
        };
      }

      var isUser = evClass.indexOf('usermessage') >= 0 ||
        evClass.indexOf('user-message') >= 0 ||
        evEventType === 'user-message' ||
        evCy === 'user-message' ||
        innerUserMarker !== null;

      var cleanedText = rawText.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
      cleanedText = cleanedText.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();
      var cleanedInner = innerRaw.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
      cleanedInner = cleanedInner.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();

      // Check for file/image attachments (user messages that are just attached files)
      var attachmentNames = [];
      if (isUser) {
        var imgs = el.querySelectorAll('img[src], img[alt]');
        for (var ai = 0; ai < imgs.length; ai++) {
          var imgAlt = (imgs[ai].getAttribute('alt') || '').trim();
          var imgSrc = (imgs[ai].getAttribute('src') || '').trim();
          if (imgAlt && imgAlt.length > 0 && imgAlt.length < 200) {
            attachmentNames.push(imgAlt);
          } else if (imgSrc) {
            var srcParts = imgSrc.split('/');
            var srcName = srcParts[srcParts.length - 1].split('?')[0];
            if (srcName && srcName.length > 0 && srcName.length < 200) {
              attachmentNames.push(srcName);
            }
          }
        }
        var fileLinks = el.querySelectorAll('a[href*="file"], a[href*="upload"], a[href*="attachment"], a[download], [class*="attachment" i], [class*="file" i]:not([class*="profile"])');
        for (var fi = 0; fi < fileLinks.length; fi++) {
          var linkText = (fileLinks[fi].textContent || '').trim();
          var linkDownload = (fileLinks[fi].getAttribute('download') || '').trim();
          var linkHref = (fileLinks[fi].getAttribute('href') || '').trim();
          var fileName = linkDownload || linkText;
          if (!fileName && linkHref) {
            var hrefParts = linkHref.split('/');
            fileName = hrefParts[hrefParts.length - 1].split('?')[0];
          }
          if (fileName && fileName.length > 0 && fileName.length < 200) {
            var alreadyHave = false;
            for (var ch = 0; ch < attachmentNames.length; ch++) {
              if (attachmentNames[ch] === fileName) { alreadyHave = true; break; }
            }
            if (!alreadyHave) attachmentNames.push(fileName);
          }
        }
        // Also check for Replit-specific attached asset patterns
        var assetEls = el.querySelectorAll('[class*="Attached" i], [class*="attached" i], [class*="Asset" i], [data-testid*="attachment"], [data-testid*="file"]');
        for (var aei = 0; aei < assetEls.length; aei++) {
          var assetText = (assetEls[aei].textContent || '').trim();
          if (assetText && assetText.length > 0 && assetText.length < 200) {
            var assetAlready = false;
            for (var ach = 0; ach < attachmentNames.length; ach++) {
              if (attachmentNames[ach] === assetText) { assetAlready = true; break; }
            }
            if (!assetAlready) attachmentNames.push(assetText);
          }
        }
      }

      // If text content is too short, check if we have attachments to use instead
      if (cleanedText.length < 5) {
        if (isUser && attachmentNames.length > 0) {
          cleanedText = attachmentNames.join(', ');
          cleanedInner = attachmentNames.join(', ');
        } else {
          return null;
        }
      }

      if (cleanedText.match(/^Worked\s+for\s+/i)) return null;
      if (cleanedText.match(/^Decided\s+on\s+/i) && cleanedText.length < 100) return null;
      if (cleanedText.match(/^\d+\s+actions?\s*$/i)) return null;
      if (cleanedText.match(/^Created task list\s*$/i)) return null;
      if (cleanedText.match(/^Ready to share\?\s*Publish/i)) return null;

      // If user message has both text and attachments, append filenames
      var messageContent = cleanedInner;
      if (isUser && attachmentNames.length > 0 && cleanedInner.length >= 5) {
        messageContent = cleanedInner + '\n[Attached: ' + attachmentNames.join(', ') + ']';
      }

      return {
        entryType: 'message',
        type: isUser ? 'user' : 'agent',
        content: messageContent.substring(0, 10000),
        contentKey: cleanedText.substring(0, 200),
        timestamp: timestamp
      };
    }, { idx: index, prevTs: lastTimestamp });
  }

  private async countMessageElements(page: Page): Promise<number> {
    return page.evaluate(function() {
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
  }

  private async scrollToLoadAll(page: Page): Promise<void> {
    let previousCount = 0;
    let sameCountIterations = 0;
    let loadMoreFailedClicks = 0;
    const maxIterations = 500;
    const maxLoadMoreFailures = 5;
    const startTime = Date.now();
    const maxTime = 300000;
    
    for (let i = 0; i < maxIterations; i++) {
      if (Date.now() - startTime > maxTime) {
        console.log(`\nReached time limit for loading history (5 min)`);
        break;
      }
      const currentCount = await this.countMessageElements(page);

      await page.evaluate(function() {
        var scrollAreas = document.querySelectorAll('[class*="ScrollArea"], [class*="scroll"], [role="log"]');
        for (var j = 0; j < scrollAreas.length; j++) {
          scrollAreas[j].scrollTop = 0;
        }
      });

      const clickedLoadMore = await this.clickLoadMoreButton(page);
      if (clickedLoadMore) {
        process.stdout.write(`\rClicked load more button, waiting for new messages...`);
        
        let loadWaitAttempts = 0;
        const maxLoadWaitAttempts = 5;
        let newCount = currentCount;
        
        while (loadWaitAttempts < maxLoadWaitAttempts) {
          await page.waitForTimeout(200);
          newCount = await this.countMessageElements(page);
          if (newCount > currentCount) {
            process.stdout.write(`\rLoaded ${newCount - currentCount} new messages...`);
            loadMoreFailedClicks = 0;
            break;
          }
          loadWaitAttempts++;
        }
        
        if (newCount <= currentCount) {
          const buttonStillVisible = await this.isLoadMoreButtonVisible(page);
          if (!buttonStillVisible) {
            console.log(`\nReached beginning of chat (load more button disappeared)`);
            break;
          }
          loadMoreFailedClicks++;
          process.stdout.write(`\rLoad more click ${loadMoreFailedClicks}/${maxLoadMoreFailures} didn't add messages...`);
          if (loadMoreFailedClicks >= maxLoadMoreFailures) {
            console.log(`\nReached beginning of chat (no new messages after ${maxLoadMoreFailures} attempts)`);
            break;
          }
        }
        
        sameCountIterations = 0;
        previousCount = newCount;
        continue;
      }

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
    
    await page.evaluate(function() {
      var scrollAreas = document.querySelectorAll('[class*="ScrollArea"], [class*="scroll"], [role="log"]');
      for (var j = 0; j < scrollAreas.length; j++) {
        scrollAreas[j].scrollTop = scrollAreas[j].scrollHeight;
      }
    });
    
    await page.waitForTimeout(500);
  }

  private async findOldestChatTimestamp(page: Page): Promise<string | null> {
    try {
      var result = await page.evaluate(function() {
        var timePattern = /\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago/i;
        var absDatePattern = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i;
        var absTimePattern = /\d{1,2}:\d{2}\s*(?:am|pm)/i;
        var fullDatePattern = /\d{1,2}\/\d{1,2}\/\d{2,4}/;

        // Find chat-specific containers to limit search scope
        var chatSelectors = [
          '[class*="eventContainer"]', '[class*="EventContainer"]',
          '[class*="ChatMessage"]', '[class*="chat-message"]',
          '[class*="UserMessage"]', '[class*="AgentMessage"]',
          '[class*="AssistantMessage"]', '[class*="EndOfRunSummary"]',
          '[data-event-type]', '[class*="checkpoint"]'
        ];
        var chatContainers = document.querySelectorAll(chatSelectors.join(', '));

        var timestamps = [];
        for (var c = 0; c < chatContainers.length; c++) {
          var container = chatContainers[c];
          var leafEls = container.querySelectorAll('*');
          for (var i = 0; i < leafEls.length; i++) {
            var el = leafEls[i];
            if (el.children.length > 0) continue;
            var txt = (el.textContent || '').trim();
            if (txt.length < 3 || txt.length > 100) continue;

            if (timePattern.test(txt) || absDatePattern.test(txt) || absTimePattern.test(txt) || fullDatePattern.test(txt)) {
              var rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                timestamps.push({ text: txt, top: rect.top });
              }
            }
          }
        }

        if (timestamps.length === 0) return null;

        timestamps.sort(function(a, b) { return a.top - b.top; });
        return timestamps[0].text;
      });

      if (!result) return null;

      var parsed = this.parseRelativeOrAbsoluteTimestamp(result);
      return parsed;
    } catch {
      return null;
    }
  }

  private parseRelativeOrAbsoluteTimestamp(text: string): string | null {
    var relMatch = text.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
    if (relMatch) {
      var amount = parseInt(relMatch[1], 10);
      var unit = relMatch[2].toLowerCase();
      var now = new Date();
      var ms = 0;
      if (unit === 'second') ms = amount * 1000;
      else if (unit === 'minute') ms = amount * 60000;
      else if (unit === 'hour') ms = amount * 3600000;
      else if (unit === 'day') ms = amount * 86400000;
      else if (unit === 'week') ms = amount * 604800000;
      else if (unit === 'month') ms = amount * 2592000000;
      else if (unit === 'year') ms = amount * 31536000000;
      var pastDate = new Date(now.getTime() - ms);
      return pastDate.toISOString();
    }

    var absMatch = text.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
    if (absMatch) {
      var months: { [key: string]: number } = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      var mon = months[absMatch[1].substring(0, 3).toLowerCase()];
      var day = parseInt(absMatch[2], 10);
      var year = absMatch[3] ? parseInt(absMatch[3], 10) : new Date().getFullYear();
      var d = new Date(year, mon, day);
      return d.toISOString();
    }

    var slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (slashMatch) {
      var m = parseInt(slashMatch[1], 10) - 1;
      var dy = parseInt(slashMatch[2], 10);
      var yr = parseInt(slashMatch[3], 10);
      if (yr < 100) yr += 2000;
      var dt = new Date(yr, m, dy);
      return dt.toISOString();
    }

    return null;
  }

  private async clickLoadMoreButton(page: Page): Promise<boolean> {
    for (const selector of LOAD_MORE_SELECTORS) {
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

  private async isLoadMoreButtonVisible(page: Page): Promise<boolean> {
    for (const selector of LOAD_MORE_SELECTORS) {
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isVisible();
          if (isVisible) return true;
        }
      } catch {
        continue;
      }
    }

    return page.evaluate(function() {
      var buttons = document.querySelectorAll('button, [role="button"], a');
      for (var i = 0; i < buttons.length; i++) {
        var text = (buttons[i].textContent || '').toLowerCase();
        if (text.indexOf('show previous') >= 0 ||
            text.indexOf('load more') >= 0 ||
            text.indexOf('earlier') >= 0 ||
            text.indexOf('previous message') >= 0) {
          var rect = buttons[i].getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        }
      }
      return false;
    });
  }

  private async extractAllData(page: Page, _outputDir: string = './exports'): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[]; workEntries: WorkEntry[] }> {
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

      if (data.timestamp) {
        if (!lastTimestamp) {
          lastTimestamp = data.timestamp;
        } else {
          var curParsed = parseTimestamp(lastTimestamp);
          var newParsed = parseTimestamp(data.timestamp);
          if (newParsed && curParsed && newParsed.getTime() >= curParsed.getTime()) {
            lastTimestamp = data.timestamp;
          }
        }
      }

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
          index: index++,
          _containerIdx: data.containerIdx
        });
      } else if (data.entryType === 'checkpoint') {
        checkpoints.push({
          timestamp: data.timestamp,
          description: data.description || '',
          cost: data.cost,
          durationSeconds: null,
          index: index++,
          _containerIdx: data.containerIdx
        });
      } else if (data.entryType === 'message') {
        var contentKey = data.contentKey || data.content.substring(0, 200);
        if (seenKeys[contentKey]) continue;
        seenKeys[contentKey] = true;

        messages.push({
          type: data.type,
          content: data.content,
          timestamp: data.timestamp,
          index: index++,
          _containerIdx: i
        });
      }
    }

    console.log(`\r  Extracted from ${totalContainers} containers`);

    // Phase 3.5: Re-read precise durations using deterministic container index mapping
    if (workEntries.length > 0) {
      var containerIndices = workEntries
        .map(function(we) { return we._containerIdx; })
        .filter(function(idx) { return idx != null; }) as number[];

      if (containerIndices.length > 0) {
        var precisionMap = await page.evaluate(function(indices) {
          var containers = document.querySelectorAll('[class*="eventContainer"], [class*="EventContainer"], [data-event-type]');
          var result = {};
          for (var pi = 0; pi < indices.length; pi++) {
            var ci = indices[pi];
            if (ci < containers.length) {
              var attr = containers[ci].getAttribute('data-precise-duration');
              if (attr && attr.length > 0) {
                result[String(ci)] = attr;
              }
            }
          }
          return result;
        }, containerIndices);

        var mergeCount = 0;
        for (var wi = 0; wi < workEntries.length; wi++) {
          var we = workEntries[wi];
          if (we._containerIdx == null) continue;
          var preciseVal = precisionMap[String(we._containerIdx)];
          if (!preciseVal || preciseVal.length === 0) continue;

          var cleanPrecise = preciseVal.replace(/^Worked\s+for\s+/i, '').trim();
          if (!/\d+\s*(second|minute|hour|day|week|month|year)s?/i.test(cleanPrecise)) continue;

          var newSecs = 0;
          var pParts = cleanPrecise.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?/gi);
          if (pParts) {
            for (var pp = 0; pp < pParts.length; pp++) {
              var pMatch = pParts[pp].match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
              if (pMatch) {
                var pVal = parseInt(pMatch[1], 10);
                var pUnit = pMatch[2].toLowerCase();
                if (pUnit === 'second') newSecs += pVal;
                else if (pUnit === 'minute') newSecs += pVal * 60;
                else if (pUnit === 'hour') newSecs += pVal * 3600;
                else if (pUnit === 'day') newSecs += pVal * 86400;
              }
            }
          }
          if (newSecs > 0 && (newSecs !== we.durationSeconds || cleanPrecise !== we.timeWorked)) {
            if (this.verbose) {
              console.log(`  [Precision merge] Container ${we._containerIdx}: "${we.timeWorked}" -> "${cleanPrecise}" (${newSecs}s)`);
            }
            workEntries[wi] = { ...we, timeWorked: cleanPrecise, durationSeconds: newSecs };
            mergeCount++;
          }
        }
        if (mergeCount > 0) {
          console.log(`  Phase 3.5: Merged ${mergeCount} precise durations into work entries`);
        }
      }
    }

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
    var allEntries: Array<ChatMessage | Checkpoint | WorkEntry> = [];
    for (var ai = 0; ai < deduped.length; ai++) allEntries.push(deduped[ai]);
    for (var ai2 = 0; ai2 < checkpoints.length; ai2++) allEntries.push(checkpoints[ai2]);
    for (var ai3 = 0; ai3 < workEntries.length; ai3++) allEntries.push(workEntries[ai3]);

    allEntries.sort(function(a, b) {
      var ca = (a as any)._containerIdx != null ? (a as any)._containerIdx : 0;
      var cb = (b as any)._containerIdx != null ? (b as any)._containerIdx : 0;
      return ca - cb;
    });

    for (var si = 0; si < allEntries.length; si++) {
      allEntries[si].index = si;
    }

    var repairCount = 0;
    var highWaterTs: string | null = null;
    var highWaterDate: Date | null = null;
    for (var ri = 0; ri < allEntries.length; ri++) {
      var rEntry = allEntries[ri];
      if (!rEntry.timestamp) continue;
      var rDate = parseTimestamp(rEntry.timestamp);
      if (!rDate) continue;

      if (!highWaterDate) {
        highWaterTs = rEntry.timestamp;
        highWaterDate = rDate;
      } else if (rDate.getTime() < highWaterDate.getTime()) {
        rEntry.timestamp = highWaterTs;
        repairCount++;
      } else {
        highWaterTs = rEntry.timestamp;
        highWaterDate = rDate;
      }
    }
    if (repairCount > 0) {
      console.log(`  Repaired ${repairCount} stale timestamps via monotonic forward-fill`);
    }

    deduped = [];
    checkpoints = [];
    workEntries = [];
    for (var sep = 0; sep < allEntries.length; sep++) {
      var entry = allEntries[sep];
      if ('type' in entry && 'content' in entry) {
        deduped.push(entry as ChatMessage);
      } else if ('description' in entry) {
        checkpoints.push(entry as Checkpoint);
      } else if ('timeWorked' in entry) {
        workEntries.push(entry as WorkEntry);
      }
    }

    if (deduped.length === 0 && checkpoints.length === 0 && workEntries.length === 0) {
      console.log('  Primary extraction found no results, trying fallback...');
      return this.fallbackExtract(page);
    }

    return { messages: deduped, checkpoints, workEntries };
  }

  private async fallbackExtract(page: Page): Promise<{ messages: ChatMessage[]; checkpoints: Checkpoint[]; workEntries: WorkEntry[] }> {
    var data = await page.evaluate(function() {
      var messages = [];
      var seenKeys = {};
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
        var bInner = (bEl.innerText || bRaw).trim();

        var bClean = bRaw.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
        bClean = bClean.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();
        if (bClean.length < 5) continue;

        var bCleanInner = bInner.replace(/\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*$/i, '').trim();
        bCleanInner = bCleanInner.replace(/^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\s*/i, '').trim();

        var bKey = bClean.substring(0, 200);
        if (seenKeys[bKey]) continue;
        seenKeys[bKey] = true;

        var relativePattern = /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i;
        var timestamp = null;
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
      this.page = null;
    }
  }

  deleteSession(): void {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      console.log('Session file deleted.');
    }
  }
}

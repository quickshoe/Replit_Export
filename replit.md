# Replit Agent Exporter

## Overview

The Replit Agent Exporter is a Node.js CLI tool designed to backup and export Replit Agent chat history and checkpoint metadata. It allows users to extract and preserve their Replit Agent conversations, including detailed work data, usage charge breakdowns, and duration calculations for each work entry. This tool provides a comprehensive solution for backing up and analyzing interactions with the Replit Agent, offering insights into project progression and agent resource consumption.

**Two Modes:**
- **Standard mode** (default): Extracts only user and agent chat messages with timestamps. Outputs JSON, chat CSV, and chat Markdown.
- **Full mode** (`--full` flag): Performs complete extraction including git commits, work tracking, checkpoints, hover durations, and all CSV/JSON outputs (all-events, work-tracking, work-summary, combined work-summary).

## User Preferences

I want iterative development.
I prefer detailed explanations.
Ask before making major changes.

## System Architecture

The tool is implemented as a Node.js CLI application, leveraging Playwright for browser automation to interact with the Replit web interface. It maintains login state via cookies without storing user passwords.

**Core Functionality:**
- **Browser Automation:** Playwright operates in a headed, visible browser instance with explicit window size (`--window-size=1440,900`) and viewport (`1440x900`) set at launch to prevent visual resize during initialization. Uses `chromium.launchPersistentContext()` with a temp userDataDir for proper browser behavior. **Critical:** `launchPersistentContext` does NOT support the `storageState` launch option (it silently ignores it). Session cookies must be manually injected via `context.addCookies()` after launch, and localStorage items restored via `page.evaluate()`. The window restores for user interaction during login if necessary. Verbose mode enables detailed per-item logging.
- **Debug Session Mode:** The `--debug-session` flag traces session restore step-by-step — inspects session file contents (cookie names, domains, expiry dates), navigates to replit.com/~, captures page content/title/body, checks for page errors, retries via reload, and outputs a verdict (LOGGED_IN / NOT_LOGGED_IN / PAGE_ERROR). Dumps all diagnostics to `debug-session.json`.
- **Debug Login Mode:** The `--debug-login` flag deletes the session file to force a fresh login, launches the browser to the login page, and traces the entire login flow. Captures all URL transitions (via `framenavigated` events), HTTP redirect/error responses (3xx, 425), cookie changes (with auth cookie detection for `connect.sid`, `replit_authed`, `ajs_user_id`), page errors, and post-login state. Handles HTTP 425 errors by auto-reloading. After login detection, saves session and dumps full diagnostics to `debug-login.json`.
- **Debug URL Mode:** The `--debug-url <url>` flag restores the session, navigates to a specific Replit URL, and traces the full page loading sequence. Captures pre-navigation auth state, URL transitions, HTTP error responses (4xx+), page error detection with retry/reload (3 attempts with increasing backoff), URL settle verification against target path, DOM stability checks, and chat content detection polling (12 attempts, 60s). Includes DOM snapshot on failure. Dumps all diagnostics to `debug-url.json`.
- **Page Error Recovery:** Navigation in `scrapeRepl()` retries up to 3 times with increasing backoff (2s/4s/6s) when "page not working" or HTTP error pages are detected. The `isPageError()` helper checks body text for common error indicators (HTTP ERROR, ERR_, "This page isn't working", etc.).
- **Page Ready Detection (`waitForPageReady`):** Replaces the old `waitForChatContent`. Uses a three-phase approach: (1) Wait up to 15s for URL to settle to target path, (2) Wait for DOM to stabilize (children count stops changing over 500ms windows), (3) Poll for chat content selectors (12 attempts, 60s total) with page error recovery during polling. This prevents detecting stale chat elements from a previous page.
- **Data Scraping Pipeline:** The scraper navigates to Replit URLs, auto-scrolls, and processes DOM elements through a multi-step pipeline:
    1.  **Agent Idle Check:** Uses DOM-based detection: checks for "Working" text at bottom of chat, then performs a 3-second DOM snapshot comparison to detect live typing/changes. Waits up to 10 minutes for the agent to finish if active. During the wait, each re-check is logged to the terminal (e.g., `Re-check #1 (10s): DOM still changing — agent still working`) so the user can see ongoing progress.
    2.  **Load & Expand:** Scrolls to load full chat history (up to 5 minutes, 500 iterations max) and expands all relevant sections like "X messages & X actions," "Checkpoint made," and "Worked for X." "Show previous messages" button clicks retry up to 5 times immediately (no delays between retries — each `page.evaluate` call takes ~200ms naturally). Both standard and full modes expand collapsed message sections to ensure agent messages are captured.
    3.  **Git Tab Navigation & Timestamp Conversion:** Navigates to the Git tab, scrolls to load commits, and clicks a single relative timestamp to convert all UI timestamps to absolute format. Extracts commit messages and timestamps. Git commit scrolling is limited by the oldest visible chat timestamp (with 1-day buffer) to avoid loading thousands of irrelevant older commits.
    4.  **Return to Chat:** Navigates back to the chat panel.
    5.  **Hover Durations:** Hovers over "Time worked" elements within "Worked for X" sections to capture precise duration tooltips.
    6.  **Extraction:** Performs read-only extraction of all chat, checkpoint, and work entry containers, incorporating precise durations.
- **Key Insight: One-Click Timestamp Conversion:** A single click on a relative timestamp in the Git tab converts all relative timestamps across the entire Replit UI to absolute values, simplifying timestamp resolution. After clicking, fast polling (100ms intervals, up to 5 attempts) verifies conversion completed.
- **Work Entry Detection:** Work entries are identified by structural DOM evidence (e.g., `EndOfRunSummary` class or expandable attributes) to prevent misidentification of user messages.
- **Robust Extraction:** Employs fallback selectors and deduplicates work entries using composite keys.
- **Precise Duration:** Extracts precise duration from tooltips triggered by Playwright hover actions.
- **Timestamp Strategy:** After the Git tab conversion, all timestamps are absolute. Extraction uses entry-type-specific rules for work entries (inherit from preceding checkpoint), checkpoints (internal search), and messages (internal search or next sibling elements).
- **URL Skip Navigation:** Before navigating to a Repl URL, the tool checks `page.url()` against the target URL. If the browser is already on the correct page (and not on a login page), navigation is skipped entirely, avoiding unnecessary reloads.
- **Git Commit Scraping & Matching:** Git commits are scraped from the Git tab and matched to "Saved progress at the end of the loop" checkpoints by timestamp proximity for enriching work entry descriptions. Git tab navigation uses a multi-strategy approach with verification: (1) text/aria-label match on buttons/tabs/links, (2) SVG icon detection for git-branch icons, (3) keyboard shortcut Ctrl+Shift+G. The "Commits" heading is not a clickable sub-tab — the git panel directly shows commit history when opened.
- **Content-Based DOM Detection:** All git panel detection, commit extraction, and timestamp conversion use **content-based detection** rather than CSS class-name selectors. Replit uses hashed module class names (e.g., `useView-module__etopAW__view`) with no "commit" or "git" substrings, so class-name-based selectors fail. Instead, the tool: (1) Finds the git panel by locating a visible `[role="tabpanel"]` element whose text contains "Sync Changes" or "Remote Updates". (2) Identifies commit entries by finding leaf-level timestamp elements (relative or absolute) within the git panel, then walking up the DOM to find each commit's container. (3) Extracts commit messages by finding the longest non-timestamp, non-skip text within each container. (4) Skips known non-commit text ("Remote Updates", "Sync Changes", "Pull", "Push", "There are no changes to commit", etc.). Old class-name-based selectors are kept as fallbacks for older UI versions. Debug files `git-tab-debug.json` and `git-nav-debug.json` capture comprehensive DOM snapshots for diagnosing navigation failures.
- **Output Generation:** Exports are organized into per-URL directories with run timestamps, producing:
    -   JSON files for structured data.
    -   CSV files: `all-events.csv`, `chat.csv`, `work-tracking.csv`, `work-summary.csv`.
    -   Markdown: `chat.md`.
    -   A combined `_work-summary.csv` aggregating data from all URLs.
- **Unified Re-Indexing:** All extracted entry types (messages, checkpoints, work entries) are combined, sorted by their original DOM order, and assigned sequential indices for unique identification and chronological consistency.
- **Timestamp Repair:** After re-indexing, a monotonic forward-fill pass ensures timestamps never go backward in chat order. The extraction loop only advances `lastTimestamp` forward (never backward) by comparing parsed dates. Any entry whose timestamp is earlier than a preceding entry's timestamp is repaired to use the preceding entry's timestamp. This prevents stale inherited timestamps from cascading through work entries.
- **All-Events CSV:** The `all-events.csv` export includes all checkpoints without filtering, including "Saved progress" and "Transitioned" boilerplate entries, providing a complete event log.

**Technical Implementations:**
- **Playwright `page.evaluate` Context:** CRITICAL: All code inside `page.evaluate()` blocks MUST be pure ES5 JavaScript with NO TypeScript syntax (`as` casts, typed declarations like `var x: Type`, etc.) AND NO function expressions assigned to variables (e.g., `var fn = function(x) {...}` causes esbuild to inject `__name` helper). Functions passed to `page.evaluate` are serialized and run in the browser context where esbuild helpers (like `__name`) do not exist. Instead of function expressions, inline the logic directly or use regex patterns inline. LSP warnings within these blocks are expected and non-blocking (tsc --noEmit passes cleanly).
- **Navigation Strategy:** Uses `waitUntil: 'domcontentloaded'` for navigation due to Replit's continuous WebSocket connections.
- **Timestamp Extraction:** Leverages specific DOM patterns and a prioritized search strategy for robust timestamp capture.
- **DOM Pattern Recognition:** Utilizes Replit-specific DOM classes and attributes for identifying and interacting with content.
- **File Attachment Detection:** Identifies and extracts filenames from user messages containing only file attachments.
- **Browser Disconnect Handling:** Gracefully handles unexpected browser closures.

## External Dependencies

-   **Playwright:** Browser automation.
-   **Node.js:** Runtime environment.
-   **TypeScript:** Language for development.
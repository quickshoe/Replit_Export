# Replit Agent Exporter

## Overview

The Replit Agent Exporter is a Node.js CLI tool designed to backup and export Replit Agent chat history and checkpoint metadata. It allows users to extract and preserve their Replit Agent conversations, including detailed work data, usage charge breakdowns, and duration calculations for each work entry. This tool provides a comprehensive solution for backing up and analyzing interactions with the Replit Agent, offering insights into project progression and agent resource consumption.

## User Preferences

I want iterative development.
I prefer detailed explanations.
Ask before making major changes.

## System Architecture

The tool is implemented as a Node.js CLI application, leveraging Playwright for browser automation to interact with the Replit web interface. It maintains login state via cookies without storing user passwords.

**Core Functionality:**
- **Browser Automation:** Playwright operates in a headed, minimized browser instance. It restores the window for user interaction during login if necessary, then minimizes it again. Verbose mode keeps the browser visible for live DOM operation viewing.
- **Data Scraping Pipeline:** The scraper navigates to Replit URLs, auto-scrolls, and processes DOM elements through a multi-step pipeline:
    1.  **Agent Idle Check:** Verifies the Replit Agent is idle before proceeding, waiting and warning the user if the agent is active.
    2.  **Load & Expand:** Scrolls to load full chat history and expands all relevant sections like "X messages & X actions," "Checkpoint made," and "Worked for X."
    3.  **Git Tab Navigation & Timestamp Conversion:** Navigates to the Git tab, scrolls to load all commits, and clicks a single relative timestamp to convert all UI timestamps to absolute format. Extracts commit messages and timestamps.
    4.  **Return to Chat:** Navigates back to the chat panel.
    5.  **Hover Durations:** Hovers over "Time worked" elements within "Worked for X" sections to capture precise duration tooltips.
    6.  **Extraction:** Performs read-only extraction of all chat, checkpoint, and work entry containers, incorporating precise durations.
- **Key Insight: One-Click Timestamp Conversion:** A single click on a relative timestamp in the Git tab converts all relative timestamps across the entire Replit UI to absolute values, simplifying timestamp resolution.
- **Work Entry Detection:** Work entries are identified by structural DOM evidence (e.g., `EndOfRunSummary` class or expandable attributes) to prevent misidentification of user messages.
- **Robust Extraction:** Employs fallback selectors and deduplicates work entries using composite keys.
- **Precise Duration:** Extracts precise duration from tooltips triggered by Playwright hover actions.
- **Timestamp Strategy:** After the Git tab conversion, all timestamps are absolute. Extraction uses entry-type-specific rules for work entries (inherit from preceding checkpoint), checkpoints (internal search), and messages (internal search or next sibling elements).
- **Git Commit Scraping & Matching:** Git commits are scraped from the Git tab and matched to "Saved progress at the end of the loop" checkpoints by timestamp proximity for enriching work entry descriptions.
- **Output Generation:** Exports are organized into per-URL directories with run timestamps, producing:
    -   JSON files for structured data.
    -   CSV files: `all-events.csv`, `chat.csv`, `work-tracking.csv`, `work-summary.csv`.
    -   Markdown: `chat.md`.
    -   A combined `_work-summary.csv` aggregating data from all URLs.
- **Unified Re-Indexing:** All extracted entry types (messages, checkpoints, work entries) are combined, sorted by their original DOM order, and assigned sequential indices for unique identification and chronological consistency.

**Technical Implementations:**
- **Playwright `page.evaluate` Context:** CRITICAL: All code inside `page.evaluate()` blocks MUST be pure ES5 JavaScript with NO TypeScript syntax (`as` casts, typed declarations like `var x: Type`, etc.). Functions passed to `page.evaluate` are serialized and run in the browser context where esbuild helpers (like `__name`) do not exist. TypeScript syntax causes esbuild to inject helper functions that crash at runtime. LSP warnings within these blocks are expected and non-blocking (tsc --noEmit passes cleanly).
- **Navigation Strategy:** Uses `waitUntil: 'domcontentloaded'` for navigation due to Replit's continuous WebSocket connections.
- **Timestamp Extraction:** Leverages specific DOM patterns and a prioritized search strategy for robust timestamp capture.
- **DOM Pattern Recognition:** Utilizes Replit-specific DOM classes and attributes for identifying and interacting with content.
- **File Attachment Detection:** Identifies and extracts filenames from user messages containing only file attachments.
- **Browser Disconnect Handling:** Gracefully handles unexpected browser closures.

## External Dependencies

-   **Playwright:** Browser automation.
-   **Node.js:** Runtime environment.
-   **TypeScript:** Language for development.
# Replit Agent Exporter

## Overview

The Replit Agent Exporter is a Node.js CLI tool designed to backup and export Replit Agent chat history and checkpoint metadata. Its primary purpose is to allow users to extract and preserve their Replit Agent conversations, including detailed work data and usage charge breakdowns.

Key capabilities include:
- Exporting all chat messages (user and agent)
- Extracting checkpoint entries with real timestamps and descriptions
- Expanding "Worked for X" summaries to capture structured work data
- Detailing agent usage charge breakdowns, including individual line items
- Calculating duration for each work entry

This tool provides a comprehensive solution for backing up and analyzing interactions with the Replit Agent, offering insights into project progression and agent resource consumption.

## User Preferences

I want iterative development.
I prefer detailed explanations.
Ask before making major changes.

## System Architecture

The tool is implemented as a Node.js CLI application, leveraging Playwright for browser automation to interact with the Replit web interface. It does not store user passwords, relying on Playwright's session management to maintain login state via cookies.

**Core Functionality:**
- **Browser Automation:** Playwright opens a Chromium browser for manual user login and saves session cookies for persistence.
- **Data Scraping:** The scraper navigates to specified Replit URLs, auto-scrolls to load full chat history, then processes DOM elements in two phases.
- **Two-Phase Processing:** Phase 1 performs a single-pass targeted expansion that only clicks buttons matching three patterns: "X messages & X actions" (reveals agent chat history), "Checkpoint made" (reveals timestamps), and "Worked for X" (reveals work metrics). Everything else is left untouched. Phase 2 performs a single extraction pass over all visible containers after expansions are complete.
- **Robust Extraction:** Fallback selectors run only when the primary extraction yields zero results. Work entries are deduplicated using composite keys (timestamp + duration + fee + actions + lines).
- **Precise Duration:** Extracts tooltip/title attributes on duration elements to capture precise times (e.g., "6 minutes 30 seconds") instead of truncated display text ("6 minutes"). Uses Playwright hover to trigger tooltip popups on duration elements, reads the tooltip content from floating DOM elements (`[role="tooltip"]`, Radix popper wrappers, etc.), and stores the precise value as a `data-precise-duration` attribute for Phase 3 extraction. Falls back to `title`/`aria-label` attributes if hover doesn't produce a tooltip.
- **Relative Timestamp Fallback:** After extraction, if a timestamp matches the "X days/hours ago" pattern, the scraper clicks the timestamp toggle element within that container, waits 300ms, and re-reads the timestamp to capture the absolute value.
- **DOM Debug Output:** Saves `dom-debug.json` with container structure samples for debugging DOM changes.
- **Output Generation:** Exports data into multiple formats:
    - **JSON:** Individual `.json` file per repl, containing structured work entries.
    - **CSV:** `all-events.csv` (combined messages, checkpoints, work entries, sorted by index then timestamp, includes index column), `chat.csv` (clean chat messages only), `work-tracking.csv` (structured work data with index number, description from nearest checkpoint or preceding message, and dedup by index), `work-summary.csv` (daily aggregated totals with human-readable duration and numeric minutes column).
    - **Markdown:** `chat.md` provides a human-readable chat history with all events, speakers, and timestamps.

**Technical Implementations:**
- **Playwright `page.evaluate` Context:** Code executed within `page.evaluate` strictly adheres to pure ES5 JavaScript, avoiding modern JS features (`const`/`let`, arrow functions, `forEach`, `.includes()`, regex `s` flag) to ensure compatibility within the browser context. Special attention is paid to `el.getAttribute('class')` over `el.className` for SVG compatibility.
- **Navigation Strategy:** Uses `waitUntil: 'domcontentloaded'` for navigation instead of `networkidle` due to Replit's constant WebSocket connections. Navigation directly to the repl URL automatically loads the agent chat panel.
- **Timestamp Extraction:** Employs a prioritized strategy for finding timestamps, checking `<time>` elements, parent/sibling elements, CSS classes, real-time patterns, and relative time. It explicitly clicks timestamp toggle switches within the UI to reveal absolute timestamps before extraction.
- **DOM Pattern Recognition:** Leverages specific Replit DOM patterns (e.g., `EndOfRunSummary-module__*__root`, `ExpandableFeedContent-module__*__expandableButton`, `aria-expanded` attributes) to identify and interact with expandable content sections.

## External Dependencies

- **Playwright:** Used for browser automation to interact with the Replit web interface, including navigation, DOM manipulation, and screenshotting.
- **Node.js:** The core runtime environment for the CLI tool.
- **TypeScript:** The primary language used for development, providing type safety and improved code maintainability.
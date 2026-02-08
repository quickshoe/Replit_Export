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
- **Multi-Phase Processing:** Phase 1 performs targeted expansion (clicks "X messages & X actions", "Checkpoint made", "Worked for X" buttons). Phase 2 resolves relative timestamps on user comments via Playwright hover (user comments display "X time ago" but hover reveals absolute timestamp; checkpoints display absolute timestamp so are NOT hovered). Phase 2.5 hovers over duration elements for precise time-worked recording. Phase 3 performs read-only extraction. Phase 3.5 merges precise durations.
- **Work Entry Detection:** Work entries are identified by structural evidence, not just text content. A container must have either an `EndOfRunSummary` class or expandable structure (`aria-expanded`, `Expandable` class) to be treated as a work entry. This prevents user chat messages containing "Worked for" or "Time worked" from being misidentified as work entries.
- **Robust Extraction:** Fallback selectors run only when the primary extraction yields zero results. Work entries are deduplicated using composite keys (timestamp + duration + fee + actions + lines). Each work entry carries its DOM container index (`_containerIdx`) for deterministic cross-phase mapping.
- **Precise Duration:** Extracts tooltip/title attributes on duration elements to capture precise times (e.g., "6 minutes 30 seconds") instead of truncated display text ("6 minutes"). Uses Playwright hover to trigger tooltip popups on duration elements, reads the tooltip content from floating DOM elements (`[role="tooltip"]`, Radix popper wrappers, etc.), and stores the precise value as a `data-precise-duration` attribute. Phase 3.5 then re-reads these attributes using deterministic container index mapping and merges precise durations into the extracted work entries. Falls back to `title`/`aria-label` attributes if hover doesn't produce a tooltip.
- **Timestamp Strategy:** User comments show "X time ago" as text but reveal absolute timestamps on hover — the scraper hovers to capture these. Checkpoints show absolute timestamps as text but reveal relative times on hover — the scraper reads the text directly and does NOT hover. This asymmetry is handled by the `resolveRelativeTimestamps` phase which only processes non-checkpoint, non-work containers.
- **Git Commit Scraping:** After chat extraction, the scraper navigates to the Git tab, scrolls to load all commits, and extracts commit messages with their timestamps. For relative timestamps ("X time ago"), it uses Playwright click interaction (not hover tooltips) to reveal absolute timestamps — checking `datetime` attributes, `title` attributes, then clicking to toggle the display. Git commits are stored in the JSON output and matched to work entries during CSV export.
- **Git-to-Work-Entry Matching:** In `work-tracking.csv`, "Saved progress at the end of the loop" checkpoints are matched to git commits by timestamp proximity (3-minute window). The matching git commit's description replaces the boilerplate text. Processing runs from most recent to oldest for correct temporal association. Each commit matches at most one checkpoint (1:1 mapping). "Transitioned from Plan to Build mode" descriptions are kept as-is. Duplicate descriptions are eliminated — each description is used at most once across all work entries.
- **Boilerplate Detection:** Uses startsWith patterns (`/^saved progress/i`, `/^transitioned from \w+ to \w+ mode/i`) for broader matching of boilerplate descriptions.
- **DOM Debug Output:** Saves `dom-debug.json` with container structure samples for debugging DOM changes.
- **Output Generation:** Exports data into multiple formats:
    - **JSON:** Individual `.json` file per repl, containing structured work entries and git commits.
    - **CSV:** `all-events.csv` (combined messages, checkpoints, work entries, sorted by index then timestamp, includes index column), `chat.csv` (clean chat messages only), `work-tracking.csv` (structured work data with index number, description from git commit matching or nearest checkpoint or preceding message, dedup by index, no duplicate descriptions), `work-summary.csv` (daily aggregated totals with human-readable duration and numeric minutes column).
    - **Markdown:** `chat.md` provides a human-readable chat history with all events, speakers, and timestamps.

**Technical Implementations:**
- **Playwright `page.evaluate` Context:** Code executed within `page.evaluate` strictly adheres to pure ES5 JavaScript, avoiding modern JS features (`const`/`let`, arrow functions, `forEach`, `.includes()`, regex `s` flag) to ensure compatibility within the browser context. Special attention is paid to `el.getAttribute('class')` over `el.className` for SVG compatibility.
- **Navigation Strategy:** Uses `waitUntil: 'domcontentloaded'` for navigation instead of `networkidle` due to Replit's constant WebSocket connections. Navigation directly to the repl URL automatically loads the agent chat panel.
- **Timestamp Extraction:** Employs a prioritized strategy: (1) check `data-resolved-timestamp` attribute set by hover phase, (2) regex match for absolute timestamp pattern in text (e.g., "3:45 PM, January 8, 2025"), (3) Timestamp-module element text content, (4) `<time>` element `datetime` attribute or text, (5) fall back to previous container's timestamp. No switch toggling — timestamps are resolved via hover for user comments and read directly from text for checkpoints.
- **DOM Pattern Recognition:** Leverages specific Replit DOM patterns (e.g., `EndOfRunSummary-module__*__root`, `ExpandableFeedContent-module__*__expandableButton`, `aria-expanded` attributes) to identify and interact with expandable content sections.

## External Dependencies

- **Playwright:** Used for browser automation to interact with the Replit web interface, including navigation, DOM manipulation, and screenshotting.
- **Node.js:** The core runtime environment for the CLI tool.
- **TypeScript:** The primary language used for development, providing type safety and improved code maintainability.
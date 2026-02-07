# Replit Agent Exporter

A Node.js CLI tool that exports Replit Agent chat history and checkpoint metadata using Playwright browser automation.

## Overview

This tool allows you to extract and backup your Replit Agent conversations, including:
- All chat messages (user and agent)
- Checkpoint entries with timestamps, descriptions, and costs
- Duration calculations for each checkpoint

## Project Structure

```
exporter/           # CLI tool source code
├── index.ts        # Main entry point with CLI parsing
├── scraper.ts      # Playwright browser automation
├── types.ts        # TypeScript interfaces
└── utils.ts        # Helper functions for export

exports/            # Output directory for exports
run-exporter.sh     # Shell script to run the exporter
EXPORTER_README.md  # Detailed usage documentation
```

## Quick Start

```bash
# Run the exporter
npx tsx exporter/index.ts

# Dry run (test with first URL only)
npx tsx exporter/index.ts --dry-run

# Provide URLs directly
npx tsx exporter/index.ts -u "https://replit.com/@user/app"

# Clear saved session
npx tsx exporter/index.ts --clear-session
```

## How It Works

1. Opens a Chromium browser window for manual login (no password storage)
2. Saves session cookies to `playwright-session.json` for future runs
3. Accepts Replit URLs or IDs interactively or via command line
4. Navigates to each repl's Agent tab
5. Auto-scrolls to load full chat history
6. Extracts messages and checkpoints using DOM selectors
7. Exports to JSON (per repl) and CSV (combined)

## Security

- Passwords are never stored
- Only Playwright session state is saved locally
- Delete `playwright-session.json` to clear all session data

## Output Files

- `./exports/{replId}.json` - Individual JSON export per repl
- `./exports/all-events.csv` - Combined CSV with all messages and checkpoints
- `./exports/work-tracking.csv` - Simplified CSV with time worked and agent usage

## Recent Changes

- 2026-02-07: Completely rewrote extractChatData with multi-strategy approach:
  - Strategy 1: Finds chat scroll container by structure (most text-bearing children), walks its children
  - Strategy 2: Falls back to broad CSS selectors if Strategy 1 finds too few messages
  - Added DOM debug dump (exports/dom-debug.json) with scrollable containers and selector matches
  - Fixed deduplication: removes substring duplicates and exact duplicates
  - Fixed text cleanup: strips relative timestamps ("X hours ago") from message content
  - Fixed classification: defaults unclassified messages to "agent" (since user messages are reliably detected)
  - Searches inner element classes (up to 50 descendants) for user/agent/assistant/bot/human keywords
  - Added checkpoint detection from page-wide text patterns
- 2026-02-04: Made OAuth login more resilient - uses polling instead of waitForURL to handle redirect errors
- 2026-02-04: Added fallback that continues if any cookies exist after OAuth (even if automatic detection fails)
- 2026-02-04: Fixed __name error completely - inlined all function logic (no nested functions in page.evaluate)
- 2026-02-04: Added "Show previous messages" button click detection to load full chat history
- 2026-02-04: Improved login flow to avoid multiple prompts - better OAuth/GitHub login handling
- 2026-02-04: Added work-tracking.csv output for simplified time/cost tracking
- 2026-02-04: Fixed login redirect detection - tool now waits for re-authentication when session expires
- 2026-02-03: Initial implementation with Playwright scraper

## Technical Notes

**Important: page.evaluate browser context code must use pure ES5 JavaScript**
- Use `var` instead of `const/let`
- Do NOT define nested functions even as `var funcName = function() {}` - tsx still adds __name helper
- Inline all function logic directly instead of creating helper functions inside page.evaluate
- Use `for` loops instead of `.forEach()` with arrow callbacks
- Use `.indexOf() >= 0` instead of `.includes()`
- Do NOT use TypeScript type annotations on variables (`: string`, `: number`) inside page.evaluate
- `as any[]` type assertions on array literals ARE safe (they're erased at compile time, not transformed)
- Use bracket notation for dynamic property access: `btn['click']()` instead of `(btn as HTMLElement).click()`
- This prevents tsx from injecting `__name` helper functions that don't exist in browser context

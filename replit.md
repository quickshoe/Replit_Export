# Replit Agent Exporter

A Node.js CLI tool that exports Replit Agent chat history and checkpoint metadata using Playwright browser automation.

## Overview

This tool allows you to extract and backup your Replit Agent conversations, including:
- All chat messages (user and agent)
- Checkpoint entries with real timestamps and descriptions
- Expanded "Worked for X" summaries with structured work data
- Agent usage charge breakdowns (individual line items from expanded Agent Usage chevron)
- Duration calculations for each work entry

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
4. Navigates to each repl directly (agent chat is in the side panel, no tab switching needed)
5. Auto-scrolls to load full chat history
6. Clicks "Show previous messages" buttons to load older history
7. Expands all collapsed "Worked for X" sections
8. Expands "Agent Usage" chevrons within each work entry to reveal charge line items
9. Expands checkpoint sections to extract real timestamps
10. Extracts structured data: messages, checkpoints, work entries with charge breakdowns
11. Exports to JSON (per repl) and CSV files (combined)

## Security

- Passwords are never stored
- Only Playwright session state is saved locally
- Delete `playwright-session.json` to clear all session data

## Output Files

### Naming Convention
- `replName` is the part after `/repls/` in the URL (e.g., `Replit-Export-Tool`)
- Used consistently in all CSV content, JSON filenames, and file structure

### Files Generated
- `./exports/{replName}.json` - Individual JSON export per repl (includes workEntries array with structured fields)
- `./exports/chat.csv` - Clean chat messages only (replName, timestamp, messageType, content) - no checkpoints, no "Worked for" noise
- `./exports/work-tracking.csv` - Structured work data:
  - replName, timestamp, timeWorked (e.g. "2 minutes"), workDoneActions (number), itemsReadLines (number), codeChangedPlus (number), codeChangedMinus (number), agentUsage (number, no $ symbol)
- `./exports/agent-usage-details.csv` - Individual charge line items from expanded Agent Usage sections:
  - replName, timestamp, timeWorked, lineItemLabel, lineItemAmount (number), totalAgentUsage (number)

## Recent Changes

- 2026-02-08: Major data quality improvements:
  - replName now uses just the part after /repls/ (e.g. "Replit-Export-Tool") consistently across all files
  - timestamp always second column in all CSVs for consistency
  - Replaced all-events.csv with clean chat.csv (user/agent messages only, no checkpoints/noise)
  - work-tracking.csv now has structured columns: timeWorked, workDoneActions, itemsReadLines, codeChangedPlus, codeChangedMinus, agentUsage (no $ symbol)
  - agent-usage-details.csv captures individual line items from expanded Agent Usage chevron
  - expandAllCollapsedSections now also clicks Agent Usage chevrons and checkpoint sections
  - Checkpoint timestamps extracted from expanded content (e.g. "3:49 pm, Feb 03, 2026") not relative "X ago"
  - Checkpoint descriptions cleaned: no "Rollback here", "Preview", "Changes" noise
  - Chat messages filtered: no "Worked for X", "Decided on X", "Created task list", "Ready to share? Publish" entries
  - WorkEntry type uses structured numeric fields instead of concatenated text strings
  - AgentUsageDetail.amount is now a number (no $ prefix)
  - Removed CsvRow type (replaced by direct Record usage)
- 2026-02-07: Expand collapsed sections and extract detailed work data
- 2026-02-07: Major rewrite of extractChatData using Replit-specific DOM selectors
- 2026-02-04: Made OAuth login more resilient
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
- **CRITICAL**: Use `el.getAttribute('class')` instead of `el.className` — SVG elements have `SVGAnimatedString` for className which is NOT a string and crashes `.toLowerCase()` / `.indexOf()` etc.
- Use `el.querySelector('[data-cy="user-message"]')` for descendant checks instead of walking className strings
- Do NOT use regex `s` flag — requires ES2018+. Use `[\s\S]` instead of `.` for matching newlines.

**Navigation Notes**
- Agent chat is always visible in the left (or right) side panel - no separate "Agent tab" exists
- The `?tab=agent` URL parameter only opens the console tab, not a separate agent view
- Navigation goes directly to the repl URL; agent chat panel loads automatically
- The expandAllCollapsedSections step is critical - without it, "Worked for X" entries only show collapsed summaries

**DOM Patterns for Expanded Content**
- `EndOfRunSummary-module__*__root` - Container for "Worked for X" summaries
- `ExpandableFeedContent-module__*__expandableButton` - Button to expand collapsed sections
- `aria-expanded` attribute tracks expand/collapse state
- After expanding "Worked for X", a second expansion of "Agent Usage" chevron reveals individual charge line items
- Labels precede their amounts in the DOM tree
- Checkpoint sections expand to reveal real timestamps like "3:49 pm, Feb 03, 2026"

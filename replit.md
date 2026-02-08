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
4. Navigates to each repl using domcontentloaded (no more networkidle timeout)
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
- `./exports/all-events.csv` - All events: messages, checkpoints, and work entries combined (replName, timestamp, eventType, content)
- `./exports/chat.csv` - Clean chat messages only (replName, timestamp, messageType, content) - no checkpoints, no "Worked for" noise
- `./exports/work-tracking.csv` - Structured work data:
  - replName, timestamp, timeWorked (e.g. "2 minutes"), workDoneActions (number), itemsReadLines (number), codeChangedPlus (number), codeChangedMinus (number), agentUsage (number, no $ symbol)
- `./exports/agent-usage-details.csv` - Individual charge line items from expanded Agent Usage sections:
  - replName, timestamp, timeWorked, lineItemLabel, lineItemAmount (number)

## Recent Changes

- 2026-02-08: Timestamp toggle and extraction fix:
  - Replit's timestamps are <span> elements with class Timestamp-module, role="switch", aria-checked="false"
  - Clicking them toggles from relative ("4 days ago") to absolute ("3:49 pm, Feb 03, 2026")
  - Added step in expandAllCollapsedSections to click all timestamp switches before extraction
  - Pre-computation now prioritizes [class*="Timestamp-module"] elements over <time> elements
  - Both primary and fallback timestamp maps updated with Timestamp-module as first priority
  - dom-debug now captures role and aria-checked attributes on timestamp elements
- 2026-02-08: Agent Usage extraction fix and terminal formatting:
  - Agent Usage detail extraction now finds the "Agent Usage" heading element first, then only extracts $amounts and labels from DOM elements that appear AFTER that heading (uses compareDocumentPosition). This prevents capturing "Time worked", "Work done", "Items read", "Code changed" which appear ABOVE the heading.
  - Terminal box formatting uses padEnd for consistent alignment regardless of number length
- 2026-02-08: Timestamp, navigation, and detail extraction improvements:
  - Navigation uses domcontentloaded instead of networkidle (eliminates 60s timeout)
  - Comprehensive timestamp finder: checks <time> elements, datetime attributes, parent/sibling elements, timestamp CSS classes, real time patterns, and relative time text
  - Agent Usage detail extraction uses DOM proximity matching (compareDocumentPosition) to pair labels with $amounts, filtering out structural noise and totals
  - Re-added all-events.csv alongside chat.csv
  - Removed totalAgentUsage column from agent-usage-details.csv (was causing confusion)
  - DOM debug output now includes: time elements, EndOfRunSummary HTML, and expandable Agent Usage sections for diagnostics
  - Added results summary with counts for messages, checkpoints, work entries, timestamps found, and charge line items
  - Debug logging throughout scraping process
- 2026-02-08: Major data quality improvements:
  - replName now uses just the part after /repls/ (e.g. "Replit-Export-Tool") consistently across all files
  - timestamp always second column in all CSVs for consistency
  - chat.csv has user/agent messages only, no checkpoints/noise
  - work-tracking.csv has structured columns: timeWorked, workDoneActions, itemsReadLines, codeChangedPlus, codeChangedMinus, agentUsage (no $ symbol)
  - agent-usage-details.csv captures individual line items from expanded Agent Usage chevron
  - expandAllCollapsedSections clicks Agent Usage chevrons and checkpoint sections
  - Checkpoint timestamps extracted from expanded content (e.g. "3:49 pm, Feb 03, 2026") not relative "X ago"
  - Checkpoint descriptions cleaned: no "Rollback here", "Preview", "Changes" noise
  - Chat messages filtered: no "Worked for X", "Decided on X", "Created task list", "Ready to share? Publish" entries
  - WorkEntry type uses structured numeric fields instead of concatenated text strings
  - AgentUsageDetail.amount is now a number (no $ prefix)
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
- **EXCEPTION**: `var funcName = function(arg) { ... }` IS safe when used as a variable assignment (not nested inside another function), because tsx doesn't add __name to variable-assigned anonymous functions

**Navigation Notes**
- Agent chat is always visible in the left (or right) side panel - no separate "Agent tab" exists
- The `?tab=agent` URL parameter only opens the console tab, not a separate agent view
- Navigation uses `waitUntil: 'domcontentloaded'` (not 'networkidle') because Replit's IDE has constant WebSocket connections that prevent networkidle from ever resolving
- Navigation goes directly to the repl URL; agent chat panel loads automatically
- The expandAllCollapsedSections step is critical - without it, "Worked for X" entries only show collapsed summaries

**Timestamp Extraction Strategy**
- Priority order: <time> element datetime attr > <time> element text > parent/sibling time elements > CSS timestamp classes > real timestamp pattern (e.g. "3:49 pm, Feb 03, 2026") > relative time (e.g. "4 days ago") > ISO timestamp
- The findTimestamp helper checks the element, its parent, and siblings
- Work entries and agent messages often don't have timestamps in their own DOM element - must look at nearby elements

**DOM Patterns for Expanded Content**
- `EndOfRunSummary-module__*__root` - Container for "Worked for X" summaries
- `ExpandableFeedContent-module__*__expandableButton` - Button to expand collapsed sections
- `aria-expanded` attribute tracks expand/collapse state
- After expanding "Worked for X", a second expansion of "Agent Usage" chevron reveals individual charge line items
- Charge details are extracted by scanning child elements for $X.XX amounts and pairing with nearest preceding label using DOM position (compareDocumentPosition)
- Checkpoint sections expand to reveal real timestamps like "3:49 pm, Feb 03, 2026"

**Debug Output**
- `dom-debug.json` includes: scrollable containers, chat element samples, <time> elements, EndOfRunSummary HTML samples, and expandable Agent Usage section samples
- Results summary printed to terminal: message/checkpoint/work entry counts, timestamp coverage, and charge line item counts

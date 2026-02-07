# Replit Agent Exporter

A Node.js CLI tool that exports Replit Agent chat history and checkpoint metadata using Playwright browser automation.

## Overview

This tool allows you to extract and backup your Replit Agent conversations, including:
- All chat messages (user and agent)
- Checkpoint entries with timestamps, descriptions, and costs
- Expanded "Worked for X" summaries with detailed work descriptions
- Agent usage charge breakdowns (individual line items)
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
7. Expands all collapsed "Worked for X" and "X messages & X actions" sections
8. Extracts messages, checkpoints, and work entries with cost breakdowns
9. Exports to JSON (per repl) and CSV files (combined)

## Security

- Passwords are never stored
- Only Playwright session state is saved locally
- Delete `playwright-session.json` to clear all session data

## Output Files

- `./exports/{replId}.json` - Individual JSON export per repl (includes workEntries array)
- `./exports/all-events.csv` - Combined CSV with all messages and checkpoints
- `./exports/work-tracking.csv` - CSV with time worked, duration, cost, and work descriptions
- `./exports/agent-usage-details.csv` - CSV with individual charge line items (excludes redundant "Agent Usage" top-level line)

## Recent Changes

- 2026-02-07: Expand collapsed sections and extract detailed work data:
  - Removed navigateToAgentTab - agent chat is always in side panel (left or right)
  - Added expandAllCollapsedSections: clicks ExpandableFeedContent buttons to reveal "Worked for X" summaries
  - Multiple expansion rounds to handle nested collapsed content
  - New WorkEntry type captures duration, durationSeconds, description, agentUsageCharge, chargeDetails
  - New AgentUsageDetail type for individual charge line items
  - extractChatData now detects EndOfRunSummary elements and parses expanded content
  - Parses "Worked for X minutes" duration strings into seconds
  - Extracts charge details by scanning span/div text nodes for $X.XX patterns with preceding labels
  - Excludes redundant top-level "Agent Usage" line from charge details
  - work-tracking.csv now populated from workEntries (falls back to checkpoints if no work entries found)
  - New agent-usage-details.csv with per-line-item charge breakdown
  - ReplExport type includes workEntries array in JSON output
- 2026-02-07: Major rewrite of extractChatData using Replit-specific DOM selectors:
  - Primary strategy: queries `[class*="eventContainer"]` and `[data-event-type]` elements directly
  - Uses `data-cy="user-message"` and `data-event-type="user-message"` for reliable user message classification
  - Uses `querySelector` on descendants instead of walking className strings (avoids SVGAnimatedString crash)
  - All `.className` access replaced with `.getAttribute('class')` to handle SVG elements safely
  - Fallback strategy: broader selectors like `[data-cy*="message"]`, `[class*="Message"][class*="module"]`
  - DOM debug dump now captures `data-cy` and `data-event-type` attributes
  - Deduplication uses first-200-chars key + substring comparison pass
  - Checkpoint detection from page-wide text patterns
  - Eliminated the broken "find scrollable container" approach (was picking CodeMirror editor)
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
- **CRITICAL**: Use `el.getAttribute('class')` instead of `el.className` — SVG elements have `SVGAnimatedString` for className which is NOT a string and crashes `.toLowerCase()` / `.indexOf()` etc.
- Use `el.querySelector('[data-cy="user-message"]')` for descendant checks instead of walking className strings

**Navigation Notes**
- Agent chat is always visible in the left (or right) side panel - no separate "Agent tab" exists
- The `?tab=agent` URL parameter only opens the console tab, not a separate agent view
- Navigation goes directly to the repl URL; agent chat panel loads automatically
- The expandAllCollapsedSections step is critical - without it, "Worked for X" entries only show collapsed summaries

**DOM Patterns for Expanded Content**
- `EndOfRunSummary-module__*__root` - Container for "Worked for X" summaries
- `ExpandableFeedContent-module__*__expandableButton` - Button to expand collapsed sections
- `aria-expanded` attribute tracks expand/collapse state
- After expanding, charge details appear as span/div elements with $X.XX amounts
- Labels precede their amounts in the DOM tree

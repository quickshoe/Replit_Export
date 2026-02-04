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

- 2026-02-04: Added work-tracking.csv output for simplified time/cost tracking
- 2026-02-04: Fixed login redirect detection - tool now waits for re-authentication when session expires
- 2026-02-03: Initial implementation with Playwright scraper

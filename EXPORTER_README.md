# Replit Agent Exporter

A Node.js tool that exports your Replit Agent chat history and checkpoint metadata using browser automation.

## Requirements

- Node.js 18+
- This project (with dependencies installed)

## Quick Start

### 1. Run the Exporter

```bash
# Standard run (will prompt for URLs)
npx tsx exporter/index.ts

# Or use the shell script
./run-exporter.sh
```

### 2. Log In

- A browser window will open to Replit's login page
- Log in manually (your password is never stored)
- The tool will detect when you're logged in and save the session cookies

### 3. Enter Replit URLs

After login, paste your Replit App URLs or Repl IDs (one per line):

```
https://replit.com/@username/my-app
https://replit.com/@username/another-app?tab=agent
my-project-id
```

Press Enter on an empty line to start processing.

### 4. View Exports

Find your exports in the `./exports/` directory:
- `{replId}.json` - Individual JSON file per app
- `all-events.csv` - Combined CSV with all messages and checkpoints
- `work-tracking.csv` - Simplified CSV with just time worked and agent usage

## Command Line Options

```bash
# Dry run - only process the first URL (for testing)
npx tsx exporter/index.ts --dry-run
npx tsx exporter/index.ts -d

# Provide URLs directly (space-separated)
npx tsx exporter/index.ts -u "https://replit.com/@user/app1" "https://replit.com/@user/app2"

# Custom output directory
npx tsx exporter/index.ts -o ./my-exports

# Clear saved session (log out)
npx tsx exporter/index.ts --clear-session

# Show help
npx tsx exporter/index.ts --help
```

## Output Format

### JSON Export (`{replId}.json`)

```json
{
  "replId": "username-my-app",
  "replUrl": "https://replit.com/@username/my-app",
  "exportedAt": "2024-01-15T10:30:00.000Z",
  "messages": [
    {
      "type": "user",
      "content": "Build a todo app",
      "timestamp": "2024-01-15T10:00:00.000Z",
      "index": 0
    },
    {
      "type": "agent",
      "content": "I'll create a todo application for you...",
      "timestamp": "2024-01-15T10:00:05.000Z",
      "index": 1
    }
  ],
  "checkpoints": [
    {
      "timestamp": "2024-01-15T10:05:00.000Z",
      "description": "Initial setup complete",
      "cost": "$0.15",
      "durationSeconds": 300,
      "index": 2
    }
  ]
}
```

### CSV Export (`all-events.csv`)

| replId | eventType | messageType | content | timestamp | cost | durationSeconds | index |
|--------|-----------|-------------|---------|-----------|------|-----------------|-------|
| my-app | message | user | Build a todo app | 2024-01-15T10:00:00Z | | | 0 |
| my-app | message | agent | I'll create... | 2024-01-15T10:00:05Z | | | 1 |
| my-app | checkpoint | | Initial setup | 2024-01-15T10:05:00Z | $0.15 | 300 | 2 |

## Duration Calculation

For each checkpoint, the tool calculates `durationSeconds` by:
1. Finding the nearest preceding user message with a timestamp
2. Computing the time delta in seconds
3. If timestamps are missing, `durationSeconds` is left blank

## Security

- **No password storage**: You log in manually in the browser
- **Session cookies only**: Saved to `./playwright-session.json` for convenience
- **Easy cleanup**: Run `--clear-session` to delete stored session data

## Troubleshooting

### Browser doesn't open
Make sure Playwright browsers are installed:
```bash
npx playwright install chromium
```

### Can't find Agent tab
- Ensure you have the correct Replit URL
- The tool will try to navigate to `?tab=agent` automatically

### Login not detected
- Complete the full login process including any 2FA
- Wait a moment after the page loads
- If it times out, try running again (session should be saved)

### Redirected to login during export
- If your session expires while exporting, the tool will pause and wait for you to log in again
- Simply complete the login in the browser window
- The tool will automatically continue after detecting successful login
- You have 5 minutes to complete the login

### Empty exports
- The tool uses DOM selectors to find chat elements
- If Replit's UI has changed, the selectors may need updating
- Check the browser window during scraping to see what's happening

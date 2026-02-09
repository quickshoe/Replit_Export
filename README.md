# Replit Agent Exporter

A Node.js CLI tool that backs up and exports your Replit Agent chat history, checkpoint metadata, and Git commit information. It uses browser automation to scrape data directly from the Replit web interface, preserving the full structure of your conversations including work entries, usage charges, duration calculations, and agent activity timelines.

## Features

- Exports complete chat history (user messages, agent responses, checkpoints, work entries)
- Extracts Git commit messages and matches them to work-tracking entries by timestamp
- Calculates precise work durations from tooltip hover data
- Produces structured JSON, CSV, and Markdown output files
- Processes multiple Replit projects in a single run
- Generates combined work-summary reports across all projects
- Preserves login sessions so you only need to log in once
- Waits for the Replit Agent to finish working before exporting (auto-detects idle state)
- Never stores your password -- only browser session cookies are saved locally

## Requirements

- **Node.js 18+** (includes npm)
- **Git** (for cloning the repository)
- A Replit account with Agent chat history to export

## Installation

### macOS

1. **Install Node.js** (if not already installed):

   Using [Homebrew](https://brew.sh/):
   ```bash
   brew install node
   ```

   Or download the installer from [nodejs.org](https://nodejs.org/).

2. **Clone the repository and install dependencies**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/replit-agent-exporter.git
   cd replit-agent-exporter
   npm install
   ```

3. **Install the Playwright browser**:
   ```bash
   npx playwright install chromium
   ```

### Windows

1. **Install Node.js** (if not already installed):

   Download and run the installer from [nodejs.org](https://nodejs.org/). Choose the LTS version. Make sure "Add to PATH" is checked during installation.

2. **Open a terminal** (Command Prompt, PowerShell, or Windows Terminal) and **clone the repository**:
   ```cmd
   git clone https://github.com/YOUR_USERNAME/replit-agent-exporter.git
   cd replit-agent-exporter
   npm install
   ```

3. **Install the Playwright browser**:
   ```cmd
   npx playwright install chromium
   ```

### Linux

1. **Install Node.js** (if not already installed):

   ```bash
   # Using NodeSource (Ubuntu/Debian)
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # Or use your distribution's package manager
   ```

2. **Clone the repository and install dependencies**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/replit-agent-exporter.git
   cd replit-agent-exporter
   npm install
   ```

3. **Install the Playwright browser and its system dependencies**:
   ```bash
   npx playwright install chromium
   npx playwright install-deps chromium
   ```

## Quick Start

### 1. Run the exporter

```bash
npx tsx exporter/index.ts
```

On macOS/Linux you can also use the shell script:
```bash
./run-exporter.sh
```

### 2. Log in to Replit

A browser window will open to Replit's login page. Log in manually -- the tool will detect when you are authenticated and save the session for future runs.

### 3. Enter your Replit URLs

After login, paste your Replit App URLs (one per line). Press Enter on an empty line to start processing:

```
https://replit.com/@username/my-app
https://replit.com/@username/another-app?tab=agent
```

### 4. View your exports

Find your exports in the `./exports/` directory, organized by project name and run timestamp.

## Command Line Options

```bash
# Provide URLs directly (skip the interactive prompt)
npx tsx exporter/index.ts -u "https://replit.com/@user/app1" "https://replit.com/@user/app2"

# Dry run -- only process the first URL (useful for testing)
npx tsx exporter/index.ts --dry-run

# Verbose mode -- show detailed per-item logs
npx tsx exporter/index.ts --verbose

# Full extraction -- include git commits, work tracking, checkpoints
npx tsx exporter/index.ts --full

# Custom output directory
npx tsx exporter/index.ts -o ./my-exports

# Clear saved session (log out)
npx tsx exporter/index.ts --clear-session

# Debug session restore (trace what happens step-by-step)
npx tsx exporter/index.ts --debug-session

# Show help
npx tsx exporter/index.ts --help
```

> **Important:** Use `npx tsx` (not `npx ts-node`) to run the exporter. The project uses ES modules which `ts-node` does not handle correctly.

| Flag | Short | Description |
|------|-------|-------------|
| `--urls <urls...>` | `-u` | Replit URLs or IDs to export (space-separated) |
| `--dry-run` | `-d` | Only export the first URL (for testing) |
| `--verbose` | `-v` | Show detailed per-item logging |
| `--full` | `-f` | Full extraction: git commits, work tracking, checkpoints |
| `--cutoff <date>` | `-c` | Only include data from this date onward (e.g. `2025-01-15` or `Jan 15, 2025`) |
| `--output <dir>` | `-o` | Output directory (default: `./exports`) |
| `--clear-session` | | Delete saved session cookies and exit |
| `--debug-session` | | Trace session restore step-by-step, dump diagnostics to `debug-session.json` |
| `--help` | `-h` | Show help |

## Output Structure

Exports are organized into per-project directories named `{ReplName} - YYYYMMDD_HH-MM`:

```
exports/
  my-app - 20250208_14-30/
    my-app.json              Full structured export
    all-events.csv           Complete event log (messages, checkpoints, work entries)
    chat.csv                 Clean chat messages only
    chat.md                  Markdown-formatted chat history
    work-tracking.csv        Time worked, actions, cost breakdown per work entry
    work-summary.csv         Daily totals summary
  20250208_14-30_work-summary.csv   Combined summary across all projects
```

### JSON Export

```json
{
  "replUrl": "https://replit.com/@username/my-app",
  "exportedAt": "2025-02-08T14:30:00.000Z",
  "messages": [
    {
      "type": "user",
      "content": "Build a todo app",
      "timestamp": "2025-02-08T10:00:00.000Z",
      "index": 0
    },
    {
      "type": "agent",
      "content": "I'll create a todo application for you...",
      "timestamp": "2025-02-08T10:00:05.000Z",
      "index": 1
    }
  ],
  "checkpoints": [
    {
      "timestamp": "2025-02-08T10:05:00.000Z",
      "description": "Initial setup complete",
      "cost": "$0.15",
      "durationSeconds": 300,
      "index": 2
    }
  ]
}
```

### CSV Exports

**all-events.csv** -- Every event in chronological order:

| replId | eventType | messageType | content | timestamp | cost | durationSeconds | index |
|--------|-----------|-------------|---------|-----------|------|-----------------|-------|
| my-app | message | user | Build a todo app | 2025-02-08T10:00:00Z | | | 0 |
| my-app | message | agent | I'll create... | 2025-02-08T10:00:05Z | | | 1 |
| my-app | checkpoint | | Initial setup | 2025-02-08T10:05:00Z | $0.15 | 300 | 2 |

**work-tracking.csv** -- Detailed breakdown of each work session with time, actions, and costs.

**work-summary.csv** -- Aggregated daily totals per project. The combined `_work-summary.csv` in the main exports directory includes data from all projects with per-URL daily subtotals.

## How It Works

The tool uses Playwright to automate a Chromium browser and scrape data from the Replit web interface through a multi-step pipeline:

1. **Agent idle check** -- Before scraping, the tool detects whether the Replit Agent is actively working by checking the latest Git commit message and monitoring for live DOM changes. If the agent is running, it waits up to 10 minutes for it to finish.

2. **Load and expand** -- Scrolls through the entire chat history to load all messages, then expands collapsed sections like "X messages & X actions," "Checkpoint made," and "Worked for X."

3. **Git tab and timestamps** -- Navigates to the Git tab, scrolls to load all commits, and clicks a single relative timestamp. This one click converts all relative timestamps across the entire Replit UI to absolute format.

4. **Hover for precise durations** -- Hovers over "Time worked" elements to capture exact duration values from tooltips.

5. **Extraction** -- Reads all chat messages, checkpoints, and work entries from the DOM, assigns sequential indices, and repairs any out-of-order timestamps.

6. **Git commit matching** -- Matches scraped Git commits to "Saved progress" checkpoints by timestamp proximity to enrich work entry descriptions.

7. **Export** -- Generates JSON, CSV, and Markdown files organized into per-project directories.

## Security

- Your password is **never stored**. You log in manually in the browser window.
- Only browser session cookies are saved (to `playwright-session.json`) so you don't have to log in every time.
- Run `--clear-session` to delete the saved session at any time.
- The `exports/` directory and `playwright-session.json` are in `.gitignore` and will not be committed to version control.

## Troubleshooting

### Browser doesn't open
Make sure Playwright browsers are installed:
```bash
npx playwright install chromium
```

On Linux, you may also need system dependencies:
```bash
npx playwright install-deps chromium
```

### Login not detected
- Complete the full login process including any 2FA/captcha
- Wait a moment after the page loads
- If it times out, run the tool again -- your session should be saved from the partial login

### Redirected to login during export
- If your session expires mid-export, the tool will pause and wait for you to log in again in the browser window
- Complete the login and the tool will automatically continue
- You have 5 minutes to complete the re-login

### Empty or incomplete exports
- Make sure you have the correct Replit URL (it should look like `https://replit.com/@username/project-name`)
- The tool automatically appends `?tab=agent` if needed
- Keep the browser window visible during scraping -- minimized browsers can cause incomplete DOM rendering
- If Replit's UI has changed significantly, the DOM selectors may need updating

### Windows-specific issues
- If you get permission errors, try running the terminal as Administrator
- Make sure Node.js was added to your PATH during installation (open a new terminal after installing)
- Use forward slashes or double backslashes in paths: `-o ./my-exports` or `-o .\\my-exports`

## License

MIT

#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs';
import { ReplitScraper } from './scraper';
import { saveJsonExport, exportAllEventsCsv, exportChatCsv, exportChatMarkdown, exportWorkTrackingCsv, exportWorkSummaryCsv, exportCombinedWorkSummaryCsv, ensureDir, formatRunTimestamp, extractReplName } from './utils';
import type { ReplExport } from './types';

const OUTPUT_DIR = './exports';

async function promptForUrls(): Promise<string[]> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log('\n========================================');
    console.log('Enter Replit App URLs or Repl IDs');
    console.log('(one per line, empty line to finish):');
    console.log('========================================\n');

    const urls: string[] = [];
    
    const askLine = () => {
      rl.question('> ', (answer) => {
        const trimmed = answer.trim();
        if (!trimmed) {
          rl.close();
          resolve(urls);
        } else {
          urls.push(trimmed);
          askLine();
        }
      });
    };
    
    askLine();
  });
}

async function main() {
  const program = new Command();

  program
    .name('replit-agent-exporter')
    .description('Export Replit Agent chat history and checkpoint metadata')
    .version('1.0.0')
    .option('-d, --dry-run', 'Only export the first app (for testing)', false)
    .option('-u, --urls <urls...>', 'Replit URLs or IDs to export (space-separated)')
    .option('--clear-session', 'Delete saved session and exit', false)
    .option('-v, --verbose', 'Show detailed per-item logs (hover, precision merge)', false)
    .option('-f, --full', 'Full extraction: git commits, work tracking, checkpoints, hover durations', false)
    .option('-o, --output <dir>', 'Output directory', OUTPUT_DIR);

  program.parse();
  const options = program.opts();

  if (options.clearSession) {
    const sessionFile = './playwright-session.json';
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      console.log('Session cleared successfully.');
    } else {
      console.log('No session file found.');
    }
    process.exit(0);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  Replit Agent Exporter v1.0.0                                 ║
║                                                               ║
║  This tool exports chat history and checkpoints from          ║
║  Replit Agent sessions to JSON and CSV files.                 ║
║                                                               ║
║  Security: Your password is never stored. Only browser        ║
║  session cookies are saved locally for convenience.           ║
║  Delete ./playwright-session.json to clear the session.       ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const outputDir = options.output;
  ensureDir(outputDir);

  const runStart = new Date();
  const runTimestamp = formatRunTimestamp(runStart);

  const scraper = new ReplitScraper();
  const isVerbose = options.verbose;
  const isFullMode = options.full;
  if (isVerbose) {
    scraper.setVerbose(true);
  }
  
  try {
    await scraper.init();

    const isLoggedIn = await scraper.checkLoggedIn();
    if (!isLoggedIn) {
      console.log('Not logged in. Opening login page...');
      // Restore the window so the user can see the login page
      await scraper.restoreWindow();
      await scraper.waitForLogin();
    } else {
      console.log('Already logged in (using saved session).');
    }

    // Browser stays visible for proper rendering (minimized browsers cause incomplete scraping)
    if (isVerbose) {
      console.log('Verbose mode: detailed per-item logging enabled.');
    }
    console.log(`Mode: ${isFullMode ? 'Full extraction (git, work tracking, checkpoints)' : 'Standard (chat messages only)'}`);

    let urls: string[] = options.urls || [];
    if (urls.length === 0) {
      urls = await promptForUrls();
    }

    if (urls.length === 0) {
      console.log('No URLs provided. Exiting.');
      await scraper.close();
      process.exit(0);
    }

    if (options.dryRun && urls.length > 1) {
      console.log(`\n[DRY RUN] Only processing first URL: ${urls[0]}`);
      urls = [urls[0]];
    }

    console.log(`\nProcessing ${urls.length} repl(s)...\n`);

    const exports: ReplExport[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);
      
      try {
        const data = await scraper.scrapeRepl(url, outputDir, isFullMode);
        exports.push(data);

        const replName = extractReplName(url);
        const replDir = `${replName} - ${runTimestamp}`;
        const replOutputDir = `${outputDir}/${replDir}`;
        ensureDir(replOutputDir);

        const jsonPath = saveJsonExport(data, replOutputDir);
        console.log(`  Saved: ${jsonPath}`);

        const singleExport = [data];

        const chatPath = exportChatCsv(singleExport, replOutputDir);
        console.log(`  Chat CSV: ${chatPath}`);

        const chatMdPath = exportChatMarkdown(singleExport, replOutputDir);
        console.log(`  Chat Markdown: ${chatMdPath}`);

        if (isFullMode) {
          const allEventsPath = exportAllEventsCsv(singleExport, replOutputDir);
          console.log(`  All events CSV: ${allEventsPath}`);

          const workTrackingPath = exportWorkTrackingCsv(singleExport, replOutputDir);
          console.log(`  Work tracking CSV: ${workTrackingPath}`);

          const workSummaryPath = exportWorkSummaryCsv(singleExport, replOutputDir);
          console.log(`  Work summary CSV: ${workSummaryPath}`);
        }

      } catch (err) {
        console.error(`  Error processing ${url}:`, err);
      }
    }

    if (isFullMode && exports.length > 0) {
      const combinedPath = exportCombinedWorkSummaryCsv(exports, outputDir, runTimestamp);
      console.log(`\nCombined work summary saved: ${combinedPath}`);
    }

    const w = 63;
    const pad = (s: string) => '║' + s.padEnd(w) + '║';
    const border = '═'.repeat(w);

    if (isFullMode) {
      console.log(`
╔${border}╗
${pad('                  Export Complete! (--full)                  ')}
╠${border}╣
${pad('  Processed: ' + String(exports.length).padEnd(3) + ' repl(s)')}
${pad('  Output:    ' + outputDir)}
${pad('  Run:       ' + runTimestamp)}
${pad('')}
${pad('  Per-URL directory: {ReplName} - ' + runTimestamp)}
${pad('    {replName}.json         - Full export per repl')}
${pad('    all-events.csv          - All events (messages+more)')}
${pad('    chat.csv                - Clean chat messages only')}
${pad('    chat.md                 - Markdown chat history')}
${pad('    work-tracking.csv       - Time, actions, cost breakdown')}
${pad('    work-summary.csv        - Daily totals summary')}
${pad('')}
${pad('  Main directory:')}
${pad('    ' + runTimestamp + '_work-summary.csv - Combined summary')}
╚${border}╝
`);
    } else {
      console.log(`
╔${border}╗
${pad('                      Export Complete!                      ')}
╠${border}╣
${pad('  Processed: ' + String(exports.length).padEnd(3) + ' repl(s)')}
${pad('  Output:    ' + outputDir)}
${pad('  Run:       ' + runTimestamp)}
${pad('')}
${pad('  Per-URL directory: {ReplName} - ' + runTimestamp)}
${pad('    {replName}.json         - Full export per repl')}
${pad('    chat.csv                - Chat messages only')}
${pad('    chat.md                 - Markdown chat history')}
${pad('')}
${pad('  Tip: Use --full for complete extraction with')}
${pad('  git commits, work tracking, and checkpoints.')}
╚${border}╝
`);
    }

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);

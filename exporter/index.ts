#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs';
import { ReplitScraper } from './scraper';
import { saveJsonExport, exportAllEventsCsv, exportChatCsv, exportChatMarkdown, exportWorkTrackingCsv, exportWorkSummaryCsv, ensureDir } from './utils';
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

  const scraper = new ReplitScraper();
  
  try {
    await scraper.init();

    const isLoggedIn = await scraper.checkLoggedIn();
    if (!isLoggedIn) {
      console.log('Not logged in. Opening login page...');
      await scraper.waitForLogin();
    } else {
      console.log('Already logged in (using saved session).');
    }

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
        const data = await scraper.scrapeRepl(url, outputDir);
        exports.push(data);

        const jsonPath = saveJsonExport(data, outputDir);
        console.log(`  Saved: ${jsonPath}`);
      } catch (err) {
        console.error(`  Error processing ${url}:`, err);
      }
    }

    if (exports.length > 0) {
      const allEventsPath = exportAllEventsCsv(exports, outputDir);
      console.log(`\nAll events CSV saved: ${allEventsPath}`);

      const chatPath = exportChatCsv(exports, outputDir);
      console.log(`Chat CSV saved: ${chatPath}`);

      const chatMdPath = exportChatMarkdown(exports, outputDir);
      console.log(`Chat Markdown saved: ${chatMdPath}`);
      
      const workTrackingPath = exportWorkTrackingCsv(exports, outputDir);
      console.log(`Work tracking CSV saved: ${workTrackingPath}`);
      
      const workSummaryPath = exportWorkSummaryCsv(exports, outputDir);
      console.log(`Work summary CSV saved: ${workSummaryPath}`);

    }

    const w = 63;
    const pad = (s: string) => '║' + s.padEnd(w) + '║';
    const border = '═'.repeat(w);
    console.log(`
╔${border}╗
${pad('                      Export Complete!                      ')}
╠${border}╣
${pad('  Processed: ' + String(exports.length).padEnd(3) + ' repl(s)')}
${pad('  Output:    ' + outputDir)}
${pad('')}
${pad('  Files created:')}
${pad('    {replName}.json         - Full export per repl')}
${pad('    all-events.csv          - All events (messages+more)')}
${pad('    chat.csv                - Clean chat messages only')}
${pad('    chat.md                 - Markdown chat history')}
${pad('    work-tracking.csv       - Time, actions, cost breakdown')}
${pad('    work-summary.csv        - Daily totals summary')}
╚${border}╝
`);

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);

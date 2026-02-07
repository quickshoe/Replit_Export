#!/usr/bin/env node

import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs';
import { ReplitScraper } from './scraper';
import { saveJsonExport, exportToCsv, exportWorkTrackingCsv, exportAgentUsageDetailsCsv, ensureDir } from './utils';
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

  // Handle clear session
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
╔══════════════════════════════════════════════════════════════╗
║         Replit Agent Exporter v1.0.0                        ║
║                                                              ║
║  This tool exports chat history and checkpoints from        ║
║  Replit Agent sessions to JSON and CSV files.               ║
║                                                              ║
║  Security: Your password is never stored. Only browser      ║
║  session cookies are saved locally for convenience.         ║
║  Delete ./playwright-session.json to clear the session.     ║
╚══════════════════════════════════════════════════════════════╝
`);

  const outputDir = options.output;
  ensureDir(outputDir);

  // Initialize scraper
  const scraper = new ReplitScraper();
  
  try {
    await scraper.init();

    // Check if already logged in
    const isLoggedIn = await scraper.checkLoggedIn();
    if (!isLoggedIn) {
      console.log('Not logged in. Opening login page...');
      await scraper.waitForLogin();
    } else {
      console.log('Already logged in (using saved session).');
    }

    // Get URLs to export
    let urls: string[] = options.urls || [];
    if (urls.length === 0) {
      urls = await promptForUrls();
    }

    if (urls.length === 0) {
      console.log('No URLs provided. Exiting.');
      await scraper.close();
      process.exit(0);
    }

    // Apply dry-run mode
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

        // Save individual JSON
        const jsonPath = saveJsonExport(data, outputDir);
        console.log(`  ✓ Saved: ${jsonPath}`);
      } catch (err) {
        console.error(`  ✗ Error processing ${url}:`, err);
      }
    }

    // Export combined CSV files
    if (exports.length > 0) {
      const csvPath = exportToCsv(exports, outputDir);
      console.log(`\n✓ Combined CSV saved: ${csvPath}`);
      
      const workTrackingPath = exportWorkTrackingCsv(exports, outputDir);
      console.log(`✓ Work tracking CSV saved: ${workTrackingPath}`);
      
      const agentUsagePath = exportAgentUsageDetailsCsv(exports, outputDir);
      console.log(`✓ Agent usage details CSV saved: ${agentUsagePath}`);
    }

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                     Export Complete!                         ║
╠══════════════════════════════════════════════════════════════╣
║  Processed: ${String(exports.length).padEnd(3)} repl(s)                                    ║
║  Output:    ${outputDir.padEnd(45)}║
║                                                              ║
║  Files created:                                              ║
║    • Individual JSON files per repl                          ║
║    • all-events.csv (full chat + checkpoints)                ║
║    • work-tracking.csv (time & cost summary)                 ║
║    • agent-usage-details.csv (charge line items)             ║
╚══════════════════════════════════════════════════════════════╝
`);

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);

import * as fs from 'fs';
import * as path from 'path';
import type { ReplExport, ChatMessage } from './types';

export function extractReplName(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  
  const replsMatch = trimmed.match(/\/repls\/([^\/\?#]+)/);
  if (replsMatch) {
    return replsMatch[1];
  }
  
  const atMatch = trimmed.match(/replit\.com\/@[^\/]+\/([^\/\?#]+)/);
  if (atMatch) {
    return atMatch[1];
  }
  
  if (/^[a-zA-Z0-9-_]+$/.test(trimmed) && !trimmed.includes('/')) {
    return trimmed;
  }
  
  const lastSegment = trimmed.split('/').filter(s => s.length > 0).pop();
  if (lastSegment) {
    return lastSegment.replace(/[^a-zA-Z0-9-_]/g, '_');
  }
  
  return trimmed.replace(/[^a-zA-Z0-9-_]/g, '_');
}

export function parseTimestamp(timeStr: string | null): Date | null {
  if (!timeStr) return null;
  
  const cleaned = timeStr.trim();
  
  try {
    const isoDate = new Date(cleaned);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }
  } catch {
  }
  
  const relativeMatch = cleaned.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const now = new Date();
    
    switch (unit) {
      case 'second':
        return new Date(now.getTime() - value * 1000);
      case 'minute':
        return new Date(now.getTime() - value * 60 * 1000);
      case 'hour':
        return new Date(now.getTime() - value * 60 * 60 * 1000);
      case 'day':
        return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
      case 'week':
        return new Date(now.getTime() - value * 7 * 24 * 60 * 60 * 1000);
      case 'month':
        return new Date(now.getTime() - value * 30 * 24 * 60 * 60 * 1000);
      case 'year':
        return new Date(now.getTime() - value * 365 * 24 * 60 * 60 * 1000);
    }
  }

  const realTimeMatch = cleaned.match(/(\d{1,2}:\d{2}\s*(?:am|pm),\s*\w+\s+\d{1,2},\s*\d{4})/i);
  if (realTimeMatch) {
    try {
      const parsed = new Date(realTimeMatch[1]);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    } catch {
    }
  }
  
  if (/just now|moment ago/i.test(cleaned)) {
    return new Date();
  }
  
  if (/yesterday/i.test(cleaned)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }
  
  return null;
}

export function calculateDuration(
  checkpointTimestamp: string | null,
  messages: ChatMessage[]
): number | null {
  const checkpointDate = parseTimestamp(checkpointTimestamp);
  if (!checkpointDate) return null;
  
  const userMessages = messages
    .filter(m => m.type === 'user' && m.timestamp)
    .map(m => ({
      ...m,
      date: parseTimestamp(m.timestamp)
    }))
    .filter(m => m.date && m.date < checkpointDate)
    .sort((a, b) => (b.date!.getTime() - a.date!.getTime()));
  
  if (userMessages.length === 0) return null;
  
  const nearestUserMessage = userMessages[0];
  const durationMs = checkpointDate.getTime() - nearestUserMessage.date!.getTime();
  
  if (durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) {
    return null;
  }
  
  return Math.round(durationMs / 1000);
}

function escapeCsvValue(val: any): string {
  const strVal = String(val ?? '');
  if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n') || strVal.includes('\r')) {
    return `"${strVal.replace(/"/g, '""').replace(/\r\n/g, ' ').replace(/\n/g, ' ')}"`;
  }
  return strVal;
}

function writeCsv(columns: { key: string; label: string }[], rows: Record<string, any>[], filePath: string): void {
  const csvLines = [columns.map(c => escapeCsvValue(c.label)).join(',')];
  for (const row of rows) {
    const values = columns.map(c => escapeCsvValue(row[c.key]));
    csvLines.push(values.join(','));
  }
  fs.writeFileSync(filePath, csvLines.join('\n'), 'utf-8');
}

export function saveJsonExport(data: ReplExport, outputDir: string): string {
  const safeName = data.replName.replace(/[^a-zA-Z0-9-_]/g, '_');
  const filePath = path.join(outputDir, `${safeName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

export function exportAllEventsCsv(exports: ReplExport[], outputDir: string): string {
  const rows: Record<string, any>[] = [];
  
  for (const exp of exports) {
    for (const msg of exp.messages) {
      rows.push({
        replName: exp.replName,
        timestamp: msg.timestamp || '',
        eventType: msg.type,
        content: msg.content.substring(0, 10000),
      });
    }

    for (const cp of exp.checkpoints) {
      rows.push({
        replName: exp.replName,
        timestamp: cp.timestamp || '',
        eventType: 'checkpoint',
        content: cp.description || '',
      });
    }

    for (const we of exp.workEntries) {
      const parts: string[] = [];
      if (we.timeWorked) parts.push('Worked for ' + we.timeWorked);
      if (we.workDoneActions != null) parts.push(we.workDoneActions + ' actions');
      if (we.itemsReadLines != null) parts.push(we.itemsReadLines + ' lines read');
      if (we.codeChangedPlus != null || we.codeChangedMinus != null) {
        parts.push('Code: +' + (we.codeChangedPlus || 0) + '/-' + (we.codeChangedMinus || 0));
      }
      if (we.agentUsage != null) parts.push('Agent usage: $' + we.agentUsage);
      
      rows.push({
        replName: exp.replName,
        timestamp: we.timestamp || '',
        eventType: 'work-entry',
        content: parts.join(', '),
      });
    }
  }
  
  const columns = [
    { key: 'replName', label: 'Repl name' },
    { key: 'timestamp', label: 'Timestamp' },
    { key: 'eventType', label: 'Event type' },
    { key: 'content', label: 'Content' },
  ];
  const filePath = path.join(outputDir, 'all-events.csv');
  writeCsv(columns, rows, filePath);
  return filePath;
}

export function exportChatCsv(exports: ReplExport[], outputDir: string): string {
  const rows: Record<string, any>[] = [];
  
  for (const exp of exports) {
    for (const msg of exp.messages) {
      const content = msg.content;
      if (content.match(/^Worked\s+for\s+/i)) continue;
      if (content.match(/^Checkpoint\s+made/i)) continue;
      if (content.match(/^Decided\s+on\s+/i) && content.length < 100) continue;
      if (content.match(/^\d+\s+actions?\s*$/i)) continue;
      if (content.match(/^Created task list\s*$/i)) continue;
      if (content.match(/^Ready to share\?\s*Publish/i)) continue;
      
      rows.push({
        replName: exp.replName,
        timestamp: msg.timestamp || '',
        messageType: msg.type,
        content: content.substring(0, 10000),
      });
    }
  }
  
  const columns = [
    { key: 'replName', label: 'Repl name' },
    { key: 'timestamp', label: 'Timestamp' },
    { key: 'messageType', label: 'Message type' },
    { key: 'content', label: 'Content' },
  ];
  const filePath = path.join(outputDir, 'chat.csv');
  writeCsv(columns, rows, filePath);
  return filePath;
}

export function exportWorkTrackingCsv(exports: ReplExport[], outputDir: string): string {
  const rows: Record<string, any>[] = [];
  const seenIndexes = new Set<string>();
  let dupCount = 0;
  
  for (const exp of exports) {
    if (exp.workEntries && exp.workEntries.length > 0) {
      const sortedCheckpoints = (exp.checkpoints || [])
        .filter(cp => cp.description && cp.description.length > 0)
        .sort((a, b) => a.index - b.index);

      const sortedMessages = (exp.messages || [])
        .sort((a, b) => a.index - b.index);

      for (const we of exp.workEntries) {
        const indexKey = exp.replName + '|' + we.index;
        if (seenIndexes.has(indexKey)) {
          dupCount++;
          continue;
        }
        seenIndexes.add(indexKey);

        let description = '';
        let bestCp = null as typeof sortedCheckpoints[0] | null;
        let bestCpDist = Infinity;
        for (const cp of sortedCheckpoints) {
          const dist = Math.abs(cp.index - we.index);
          if (dist < bestCpDist) {
            bestCpDist = dist;
            bestCp = cp;
          }
        }
        if (bestCp && bestCpDist <= 5) {
          description = bestCp.description;
        }

        if (!description) {
          let bestMsg = null as typeof sortedMessages[0] | null;
          for (const msg of sortedMessages) {
            if (msg.index < we.index) {
              bestMsg = msg;
            } else {
              break;
            }
          }
          if (bestMsg) {
            const content = bestMsg.content.replace(/\s+/g, ' ').trim();
            description = content.length > 100 ? content.substring(0, 100) + '...' : content;
          }
        }

        rows.push({
          index: we.index,
          replName: exp.replName,
          timestamp: we.timestamp || '',
          timeWorked: we.timeWorked || '',
          workDoneActions: we.workDoneActions ?? '',
          itemsReadLines: we.itemsReadLines ?? '',
          codeChangedPlus: we.codeChangedPlus ?? '',
          codeChangedMinus: we.codeChangedMinus ?? '',
          agentUsage: we.agentUsage ?? '',
          description: description,
        });
      }
    }
  }

  if (dupCount > 0) {
    console.log(`  [Dedup] Removed ${dupCount} duplicate work-tracking rows`);
  }
  
  const columns = [
    { key: 'index', label: 'Index' },
    { key: 'replName', label: 'Repl name' },
    { key: 'timestamp', label: 'Timestamp' },
    { key: 'timeWorked', label: 'Time worked' },
    { key: 'workDoneActions', label: 'Work done (actions)' },
    { key: 'itemsReadLines', label: 'Items read (lines)' },
    { key: 'codeChangedPlus', label: 'Code added' },
    { key: 'codeChangedMinus', label: 'Code removed' },
    { key: 'agentUsage', label: 'Agent usage fee' },
    { key: 'description', label: 'Description' },
  ];
  const filePath = path.join(outputDir, 'work-tracking.csv');
  writeCsv(columns, rows, filePath);
  return filePath;
}

export function exportWorkSummaryCsv(exports: ReplExport[], outputDir: string): string {
  const dailyMap: Record<string, {
    totalSeconds: number;
    workDoneActions: number;
    itemsReadLines: number;
    codeChangedPlus: number;
    codeChangedMinus: number;
    agentUsage: number;
  }> = {};

  for (const exp of exports) {
    if (!exp.workEntries) continue;
    for (const we of exp.workEntries) {
      let dateKey = 'Unknown';
      if (we.timestamp) {
        let parsed = parseTimestamp(we.timestamp);
        if (!parsed) {
          const rawDateMatch = we.timestamp.match(/(\w+\s+\d{1,2},\s*\d{4})/);
          if (rawDateMatch) {
            const tryParse = new Date(rawDateMatch[1]);
            if (!isNaN(tryParse.getTime())) parsed = tryParse;
          }
        }
        if (parsed) {
          const y = parsed.getFullYear();
          const m = String(parsed.getMonth() + 1).padStart(2, '0');
          const d = String(parsed.getDate()).padStart(2, '0');
          dateKey = `${y}-${m}-${d}`;
        }
      }

      if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = {
          totalSeconds: 0,
          workDoneActions: 0,
          itemsReadLines: 0,
          codeChangedPlus: 0,
          codeChangedMinus: 0,
          agentUsage: 0,
        };
      }

      const day = dailyMap[dateKey];
      if (we.durationSeconds != null) {
        day.totalSeconds += we.durationSeconds;
      }
      if (we.workDoneActions != null) {
        day.workDoneActions += we.workDoneActions;
      }
      if (we.itemsReadLines != null) {
        day.itemsReadLines += we.itemsReadLines;
      }
      if (we.codeChangedPlus != null) {
        day.codeChangedPlus += we.codeChangedPlus;
      }
      if (we.codeChangedMinus != null) {
        day.codeChangedMinus += we.codeChangedMinus;
      }
      if (we.agentUsage != null) {
        day.agentUsage += we.agentUsage;
      }
    }
  }

  const sortedDates = Object.keys(dailyMap).sort(function(a, b) {
    if (a === 'Unknown') return 1;
    if (b === 'Unknown') return -1;
    return a.localeCompare(b);
  });
  const rows: Record<string, any>[] = [];

  for (const dateKey of sortedDates) {
    const day = dailyMap[dateKey];

    const hours = Math.floor(day.totalSeconds / 3600);
    const mins = Math.floor((day.totalSeconds % 3600) / 60);
    const secs = day.totalSeconds % 60;
    const durationParts: string[] = [];
    if (hours > 0) durationParts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (mins > 0) durationParts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
    if (secs > 0 || durationParts.length === 0) durationParts.push(`${secs} second${secs !== 1 ? 's' : ''}`);
    const durationHuman = durationParts.join(' ');

    const durationMinutes = Math.round((day.totalSeconds / 60) * 100) / 100;

    rows.push({
      date: dateKey,
      timeWorked: durationHuman,
      durationMinutes: durationMinutes,
      workDoneActions: day.workDoneActions,
      itemsReadLines: day.itemsReadLines,
      codeChangedPlus: day.codeChangedPlus,
      codeChangedMinus: day.codeChangedMinus,
      agentUsage: Math.round(day.agentUsage * 100) / 100,
    });
  }

  const columns = [
    { key: 'date', label: 'Date' },
    { key: 'timeWorked', label: 'Time worked' },
    { key: 'durationMinutes', label: 'Duration (minutes)' },
    { key: 'workDoneActions', label: 'Work done (actions)' },
    { key: 'itemsReadLines', label: 'Items read (lines)' },
    { key: 'codeChangedPlus', label: 'Code added' },
    { key: 'codeChangedMinus', label: 'Code removed' },
    { key: 'agentUsage', label: 'Agent usage fee' },
  ];
  const filePath = path.join(outputDir, 'work-summary.csv');
  writeCsv(columns, rows, filePath);
  return filePath;
}

export function exportChatMarkdown(exports: ReplExport[], outputDir: string): string {
  const lines: string[] = [];

  for (const exp of exports) {
    lines.push(`# ${exp.replName}`);
    lines.push('');

    const allEvents: { timestamp: string | null; type: string; content: string; sortIndex: number }[] = [];

    for (const msg of exp.messages) {
      const content = msg.content;
      if (content.match(/^Worked\s+for\s+/i)) continue;
      if (content.match(/^Checkpoint\s+made/i)) continue;
      if (content.match(/^Decided\s+on\s+/i) && content.length < 100) continue;
      if (content.match(/^\d+\s+actions?\s*$/i)) continue;
      if (content.match(/^Created task list\s*$/i)) continue;
      if (content.match(/^Ready to share\?\s*Publish/i)) continue;

      allEvents.push({
        timestamp: msg.timestamp,
        type: msg.type === 'user' ? 'User' : 'Agent',
        content: content,
        sortIndex: msg.index
      });
    }

    for (const cp of exp.checkpoints) {
      allEvents.push({
        timestamp: cp.timestamp,
        type: 'Checkpoint',
        content: cp.description || 'Checkpoint made',
        sortIndex: cp.index
      });
    }

    for (const we of exp.workEntries) {
      const parts: string[] = [];
      if (we.timeWorked) parts.push(`Worked for ${we.timeWorked}`);
      if (we.workDoneActions != null) parts.push(`${we.workDoneActions} actions`);
      if (we.itemsReadLines != null) parts.push(`${we.itemsReadLines} lines read`);
      if (we.codeChangedPlus != null || we.codeChangedMinus != null) {
        parts.push(`Code: +${we.codeChangedPlus || 0}/-${we.codeChangedMinus || 0}`);
      }
      if (we.agentUsage != null) parts.push(`Agent usage: $${we.agentUsage}`);

      allEvents.push({
        timestamp: we.timestamp,
        type: 'Work Summary',
        content: parts.join('\n'),
        sortIndex: we.index
      });
    }

    allEvents.sort((a, b) => a.sortIndex - b.sortIndex);

    for (const event of allEvents) {
      const ts = event.timestamp ? ` — ${event.timestamp}` : '';
      lines.push(`## ${event.type}${ts}`);
      lines.push('');
      lines.push(event.content);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  const filePath = path.join(outputDir, 'chat.md');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

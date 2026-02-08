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

function writeCsv(headers: string[], rows: Record<string, any>[], filePath: string): void {
  const csvLines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map(h => escapeCsvValue(row[h]));
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
  
  const headers = ['replName', 'timestamp', 'eventType', 'content'];
  const filePath = path.join(outputDir, 'all-events.csv');
  writeCsv(headers, rows, filePath);
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
  
  const headers = ['replName', 'timestamp', 'messageType', 'content'];
  const filePath = path.join(outputDir, 'chat.csv');
  writeCsv(headers, rows, filePath);
  return filePath;
}

export function exportWorkTrackingCsv(exports: ReplExport[], outputDir: string): string {
  const rows: Record<string, any>[] = [];
  
  for (const exp of exports) {
    if (exp.workEntries && exp.workEntries.length > 0) {
      for (const we of exp.workEntries) {
        rows.push({
          replName: exp.replName,
          timestamp: we.timestamp || '',
          timeWorked: we.timeWorked || '',
          workDoneActions: we.workDoneActions ?? '',
          itemsReadLines: we.itemsReadLines ?? '',
          codeChangedPlus: we.codeChangedPlus ?? '',
          codeChangedMinus: we.codeChangedMinus ?? '',
          agentUsage: we.agentUsage ?? '',
        });
      }
    }
  }
  
  const headers = ['replName', 'timestamp', 'timeWorked', 'workDoneActions', 'itemsReadLines', 'codeChangedPlus', 'codeChangedMinus', 'agentUsage'];
  const filePath = path.join(outputDir, 'work-tracking.csv');
  writeCsv(headers, rows, filePath);
  return filePath;
}

export function exportAgentUsageDetailsCsv(exports: ReplExport[], outputDir: string): string {
  const rows: Record<string, any>[] = [];
  
  for (const exp of exports) {
    if (!exp.workEntries) continue;
    for (const we of exp.workEntries) {
      if (we.chargeDetails && we.chargeDetails.length > 0) {
        for (const detail of we.chargeDetails) {
          rows.push({
            replName: exp.replName,
            timestamp: we.timestamp || '',
            timeWorked: we.timeWorked || '',
            lineItemLabel: detail.label,
            lineItemAmount: detail.amount ?? '',
          });
        }
      }
    }
  }
  
  const headers = ['replName', 'timestamp', 'timeWorked', 'lineItemLabel', 'lineItemAmount'];
  const filePath = path.join(outputDir, 'agent-usage-details.csv');
  writeCsv(headers, rows, filePath);
  return filePath;
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

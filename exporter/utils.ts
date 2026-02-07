import * as fs from 'fs';
import * as path from 'path';
import type { ReplExport, CsvRow, ChatMessage, Checkpoint, AgentUsageDetail } from './types';

export function extractReplId(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  
  // If it's already just an ID (alphanumeric with hyphens)
  if (/^[a-zA-Z0-9-]+$/.test(trimmed) && !trimmed.includes('/')) {
    return trimmed;
  }
  
  // Extract from URL patterns
  const urlMatch = trimmed.match(/replit\.com\/@?([^\/\?#]+\/[^\/\?#]+|[^\/\?#]+)/);
  if (urlMatch) {
    return urlMatch[1].replace(/\//g, '-');
  }
  
  return trimmed;
}

export function parseTimestamp(timeStr: string | null): Date | null {
  if (!timeStr) return null;
  
  const cleaned = timeStr.trim();
  
  // Try ISO format first
  try {
    const isoDate = new Date(cleaned);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }
  } catch {
    // Continue to other formats
  }
  
  // Try common date formats
  const formats = [
    // ISO variants
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
    // US format: MM/DD/YYYY
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
    // Time only with AM/PM
    /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i,
  ];
  
  // Check for relative timestamps like "2 hours ago"
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
  
  // Check for "just now", "a moment ago"
  if (/just now|moment ago/i.test(cleaned)) {
    return new Date();
  }
  
  // Check for "yesterday"
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
  
  // Find the nearest preceding user message
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
  
  // Sanity check: duration should be positive and less than 24 hours
  if (durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) {
    return null;
  }
  
  return Math.round(durationMs / 1000);
}

export function saveJsonExport(data: ReplExport, outputDir: string): string {
  // Sanitize replId for filename
  const safeReplId = data.replId.replace(/[^a-zA-Z0-9-_]/g, '_');
  const filePath = path.join(outputDir, `${safeReplId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

export function exportToCsv(exports: ReplExport[], outputDir: string): string {
  const rows: CsvRow[] = [];
  
  for (const exp of exports) {
    // Add messages (already in DOM order via index)
    for (const msg of exp.messages) {
      rows.push({
        replId: exp.replId,
        eventType: 'message',
        messageType: msg.type,
        content: msg.content,
        timestamp: msg.timestamp || '',
        index: msg.index
      });
    }
    
    // Add checkpoints
    for (const cp of exp.checkpoints) {
      rows.push({
        replId: exp.replId,
        eventType: 'checkpoint',
        content: cp.description,
        timestamp: cp.timestamp || '',
        cost: cp.cost || '',
        durationSeconds: cp.durationSeconds?.toString() || '',
        index: cp.index
      });
    }
  }
  
  // Sort by replId, then by index (preserves DOM order which is chronological)
  rows.sort((a, b) => {
    if (a.replId !== b.replId) return a.replId.localeCompare(b.replId);
    return a.index - b.index;
  });
  
  // Generate CSV
  const headers = ['replId', 'eventType', 'messageType', 'content', 'timestamp', 'cost', 'durationSeconds', 'index'];
  const csvLines = [headers.join(',')];
  
  for (const row of rows) {
    const values = headers.map(h => {
      const val = (row as any)[h] ?? '';
      const strVal = String(val);
      // Escape quotes and wrap in quotes if contains comma, quote, or newline
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n') || strVal.includes('\r')) {
        return `"${strVal.replace(/"/g, '""').replace(/\r\n/g, ' ').replace(/\n/g, ' ')}"`;
      }
      return strVal;
    });
    csvLines.push(values.join(','));
  }
  
  const filePath = path.join(outputDir, 'all-events.csv');
  fs.writeFileSync(filePath, csvLines.join('\n'), 'utf-8');
  return filePath;
}

export function exportWorkTrackingCsv(exports: ReplExport[], outputDir: string): string {
  interface WorkRow {
    replId: string;
    timestamp: string;
    duration: string;
    durationSeconds: string;
    durationFormatted: string;
    cost: string;
    description: string;
  }
  
  const rows: WorkRow[] = [];
  
  for (const exp of exports) {
    if (exp.workEntries && exp.workEntries.length > 0) {
      for (const we of exp.workEntries) {
        let durationFormatted = '';
        if (we.durationSeconds) {
          const hours = Math.floor(we.durationSeconds / 3600);
          const minutes = Math.floor((we.durationSeconds % 3600) / 60);
          const seconds = we.durationSeconds % 60;
          durationFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        rows.push({
          replId: exp.replId,
          timestamp: we.timestamp || '',
          duration: we.duration || '',
          durationSeconds: we.durationSeconds?.toString() || '',
          durationFormatted,
          cost: we.agentUsageCharge || '',
          description: we.description.substring(0, 500).replace(/\n/g, ' '),
        });
      }
    } else {
      for (const cp of exp.checkpoints) {
        let durationFormatted = '';
        if (cp.durationSeconds) {
          const hours = Math.floor(cp.durationSeconds / 3600);
          const minutes = Math.floor((cp.durationSeconds % 3600) / 60);
          const seconds = cp.durationSeconds % 60;
          durationFormatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        rows.push({
          replId: exp.replId,
          timestamp: cp.timestamp || '',
          duration: '',
          durationSeconds: cp.durationSeconds?.toString() || '',
          durationFormatted,
          cost: cp.cost || '',
          description: cp.description.substring(0, 500).replace(/\n/g, ' '),
        });
      }
    }
  }
  
  rows.sort((a, b) => {
    if (a.replId !== b.replId) return a.replId.localeCompare(b.replId);
    return a.timestamp.localeCompare(b.timestamp);
  });
  
  const headers = ['replId', 'timestamp', 'duration', 'durationSeconds', 'durationFormatted', 'cost', 'description'];
  const csvLines = [headers.join(',')];
  
  for (const row of rows) {
    const values = headers.map(h => {
      const val = (row as any)[h] ?? '';
      const strVal = String(val);
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n') || strVal.includes('\r')) {
        return `"${strVal.replace(/"/g, '""').replace(/\r\n/g, ' ').replace(/\n/g, ' ')}"`;
      }
      return strVal;
    });
    csvLines.push(values.join(','));
  }
  
  const filePath = path.join(outputDir, 'work-tracking.csv');
  fs.writeFileSync(filePath, csvLines.join('\n'), 'utf-8');
  return filePath;
}

export function exportAgentUsageDetailsCsv(exports: ReplExport[], outputDir: string): string {
  interface DetailRow {
    replId: string;
    timestamp: string;
    duration: string;
    lineItemLabel: string;
    lineItemAmount: string;
    totalAgentUsage: string;
  }
  
  const rows: DetailRow[] = [];
  
  for (const exp of exports) {
    if (!exp.workEntries) continue;
    for (const we of exp.workEntries) {
      if (we.chargeDetails && we.chargeDetails.length > 0) {
        for (const detail of we.chargeDetails) {
          rows.push({
            replId: exp.replId,
            timestamp: we.timestamp || '',
            duration: we.duration || '',
            lineItemLabel: detail.label,
            lineItemAmount: detail.amount,
            totalAgentUsage: we.agentUsageCharge || '',
          });
        }
      } else if (we.agentUsageCharge) {
        rows.push({
          replId: exp.replId,
          timestamp: we.timestamp || '',
          duration: we.duration || '',
          lineItemLabel: 'Total',
          lineItemAmount: we.agentUsageCharge,
          totalAgentUsage: we.agentUsageCharge,
        });
      }
    }
  }
  
  rows.sort((a, b) => {
    if (a.replId !== b.replId) return a.replId.localeCompare(b.replId);
    return a.timestamp.localeCompare(b.timestamp);
  });
  
  const headers = ['replId', 'timestamp', 'duration', 'lineItemLabel', 'lineItemAmount', 'totalAgentUsage'];
  const csvLines = [headers.join(',')];
  
  for (const row of rows) {
    const values = headers.map(h => {
      const val = (row as any)[h] ?? '';
      const strVal = String(val);
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n') || strVal.includes('\r')) {
        return `"${strVal.replace(/"/g, '""').replace(/\r\n/g, ' ').replace(/\n/g, ' ')}"`;
      }
      return strVal;
    });
    csvLines.push(values.join(','));
  }
  
  const filePath = path.join(outputDir, 'agent-usage-details.csv');
  fs.writeFileSync(filePath, csvLines.join('\n'), 'utf-8');
  return filePath;
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

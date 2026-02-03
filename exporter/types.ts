export interface ChatMessage {
  type: 'user' | 'agent';
  content: string;
  timestamp: string | null;
  index: number;
}

export interface Checkpoint {
  timestamp: string | null;
  description: string;
  cost: string | null;
  durationSeconds: number | null;
  index: number;
}

export interface ReplExport {
  replId: string;
  replUrl: string;
  exportedAt: string;
  messages: ChatMessage[];
  checkpoints: Checkpoint[];
}

export interface CsvRow {
  replId: string;
  eventType: 'message' | 'checkpoint';
  messageType?: 'user' | 'agent';
  content: string;
  timestamp: string;
  cost?: string;
  durationSeconds?: string;
  index: number;
}

export interface ExporterConfig {
  dryRun: boolean;
  sessionFile: string;
  outputDir: string;
}

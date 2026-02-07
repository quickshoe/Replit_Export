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

export interface WorkEntry {
  timestamp: string | null;
  duration: string;
  durationSeconds: number | null;
  description: string;
  agentUsageCharge: string | null;
  chargeDetails: AgentUsageDetail[];
  index: number;
}

export interface AgentUsageDetail {
  label: string;
  amount: string;
  replId?: string;
  timestamp?: string | null;
}

export interface ReplExport {
  replId: string;
  replUrl: string;
  exportedAt: string;
  messages: ChatMessage[];
  checkpoints: Checkpoint[];
  workEntries: WorkEntry[];
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

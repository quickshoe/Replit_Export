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
  timeWorked: string;
  durationSeconds: number | null;
  workDoneActions: number | null;
  itemsReadLines: number | null;
  codeChangedPlus: number | null;
  codeChangedMinus: number | null;
  agentUsage: number | null;
  chargeDetails: AgentUsageDetail[];
  index: number;
}

export interface AgentUsageDetail {
  label: string;
  amount: number | null;
}

export interface ReplExport {
  replName: string;
  replUrl: string;
  exportedAt: string;
  messages: ChatMessage[];
  checkpoints: Checkpoint[];
  workEntries: WorkEntry[];
}

export interface ExporterConfig {
  dryRun: boolean;
  sessionFile: string;
  outputDir: string;
}

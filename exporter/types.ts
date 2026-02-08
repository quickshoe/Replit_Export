export interface ChatMessage {
  type: 'user' | 'agent';
  content: string;
  timestamp: string | null;
  index: number;
  _containerIdx?: number;
}

export interface Checkpoint {
  timestamp: string | null;
  description: string;
  cost: string | null;
  durationSeconds: number | null;
  index: number;
  _containerIdx?: number;
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
  index: number;
  _containerIdx?: number;
}

export interface GitCommit {
  message: string;
  timestamp: string | null;
  hash: string | null;
}

export interface ReplExport {
  replName: string;
  replUrl: string;
  exportedAt: string;
  messages: ChatMessage[];
  checkpoints: Checkpoint[];
  workEntries: WorkEntry[];
  gitCommits: GitCommit[];
}

export interface ExporterConfig {
  dryRun: boolean;
  sessionFile: string;
  outputDir: string;
}

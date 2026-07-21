export interface AgentTask {
  name: string;
  goal: string;
  context: string;
  mode: 'explore' | 'research';
  parentCwd: string;
  maxSteps?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface AgentResult {
  summary: string;
  filesExamined: string[];
  toolCallsMade: number;
  error?: string;
}

export interface AgentProgress {
  text: string;
  tool?: string;
}

export interface AgentTask {
  name: string;
  goal: string;
  context: string;
  mode: 'explore' | 'research';
  parentCwd: string;
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

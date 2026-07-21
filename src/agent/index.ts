import { AIProvider, Message } from '../providers/types.js';
import { Config, loadConfig } from '../config/index.js';
import { ProviderFactory } from '../providers/index.js';
import { ToolDefinition, ToolExecutionContext, ToolOutputChunk } from '../tools/index.js';
import { TurnExecutionIO, executeHarnessTurn } from '../cli/core/turn-executor.js';
import { HarnessMemory, TaskContinuityTracker } from '../cli/core/intelligence.js';
import { getAgentToolset } from './tools.js';
import { buildAgentSystemPrompt } from './prompt.js';
import { AgentTask, AgentResult, AgentProgress } from './types.js';

// ─── Headless Turn IO ────────────────────────────────────────────────────
// Captures all AI output and tool activity into memory instead of rendering
// to the terminal. The final assistant response becomes the agent's summary.
class HeadlessTurnIO implements TurnExecutionIO {
  collectedText = '';
  toolCallCount = 0;
  filesRead: string[] = [];
  progressCallback: ((p: AgentProgress) => void) | undefined;

  constructor(onProgress?: (p: AgentProgress) => void) {
    this.progressCallback = onProgress;
  }

  startSpinner(_label: string): () => void {
    return () => {}; // no-op in headless mode
  }

  async renderAssistant(text: string) {
    this.collectedText += text;
  }

  beginAssistantStream() {}

  pushAssistantChunk(text: string) {
    this.collectedText += text;
  }

  endAssistantStream() {}

  async showPlan(_plan: string) {}

  showNotice(message: string, _tone?: 'dim' | 'warn' | 'error') {
    this.progressCallback?.({ text: message });
  }

  showNoResponse() {}

  showToolStart(tool: ToolDefinition, label: string) {
    this.toolCallCount++;
    if (tool.name === 'read_file' || tool.name === 'read_codebase') {
      this.filesRead.push(label);
    }
    this.progressCallback?.({ text: `${tool.displayName || tool.name}: ${label}`, tool: tool.name });
  }

  showToolOutput(_chunk: ToolOutputChunk) {}

  showToolResult(_result: string) {}

  showToolError(_message: string) {}
}

// ─── Agent Runner ────────────────────────────────────────────────────────
// Runs an agent in-process using the existing executeHarnessTurn loop.
// The agent gets a stripped-down system prompt, restricted tools, and
// headless IO. The final assistant message becomes the summary result.
export async function runAgent(
  config: Config,
  provider: AIProvider,
  task: AgentTask,
  onProgress?: (p: AgentProgress) => void
): Promise<AgentResult> {
  const systemPrompt = buildAgentSystemPrompt(task);
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.goal },
  ];

  const agentTools = getAgentToolset();
  const io = new HeadlessTurnIO(onProgress);
  const memory = new HarnessMemory();
  const continuity = new TaskContinuityTracker();
  continuity.onUserInput(task.goal);
  const toolResultCache = new Map<string, string>();

  const controller = new AbortController();
  let timeoutTimer: NodeJS.Timeout | undefined;
  if (task.timeoutMs && task.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      controller.abort();
    }, task.timeoutMs);
  }

  try {
    await executeHarnessTurn({
      provider,
      taskInput: task.goal,
      messages,
      memory,
      continuity,
      tools: agentTools,
      toolResultCache,
      io,
    });
  } catch (err: any) {
    return {
      summary: io.collectedText || '(no output)',
      filesExamined: io.filesRead,
      toolCallsMade: io.toolCallCount,
      error: err.message || String(err),
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  // The summary is the accumulated assistant text (stripped of duplicate content)
  const summary = io.collectedText.trim() || '(agent produced no text output)';

  return {
    summary,
    filesExamined: [...new Set(io.filesRead)],
    toolCallsMade: io.toolCallCount,
  };
}

// ─── Convenience: create provider from current config ────────────────────
export function createAgentProvider(config?: Config): {
  provider: AIProvider;
  config: Config;
} {
  const cfg = config ?? loadConfig();
  const provider = ProviderFactory.getProvider(
    cfg.DEFAULT_PROVIDER,
    cfg,
  );
  return { provider, config: cfg };
}

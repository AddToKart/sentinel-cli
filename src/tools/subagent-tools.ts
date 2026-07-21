import readline from 'readline';
import { ToolDefinition } from './security.js';

// ─── Interactive Question Tool ───────────────────────────────────────────────
export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  displayName: 'Asking User',
  description: 'Ask the user a clarifying question when intent is ambiguous or design feedback is needed. Returns user text answer.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional multiple-choice options to present to the user' },
    },
    required: ['question'],
  },
  requiresConfirmation: false,
  getLabel: ({ question }) => question,
  async execute({ question, options }: { question: string; options?: string[] }) {
    const { Style, buildPanel } = await import('../cli/ui/theme.js');
    const lines = [Style.accent(question)];
    if (options?.length) {
      lines.push('');
      options.forEach((opt, idx) => {
        lines.push(`  ${Style.accent(`[${idx + 1}]`)} ${opt}`);
      });
    }
    const panel = buildPanel('AI Question', lines);
    process.stdout.write('\n');
    for (const l of panel) process.stdout.write(`  ${l}\n`);
    process.stdout.write('\n  ' + Style.accent('Your answer: '));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve) => {
      rl.question('', (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (options?.length) {
          const choiceNum = parseInt(trimmed, 10);
          if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= options.length) {
            const chosen = options[choiceNum - 1]!;
            process.stdout.write(`  ${Style.dim('Selected:')} ${Style.accent(chosen)}\n\n`);
            resolve(chosen);
            return;
          }
        }
        process.stdout.write('\n');
        resolve(trimmed || '(no response provided)');
      });
    });
  },
};

// ─── Subagent Delegate Task Tool ─────────────────────────────────────────────
export const delegateTaskTool: ToolDefinition = {
  name: 'delegate_task',
  displayName: 'Delegating Subagent',
  description: 'Spawn a focused background subagent to execute sub-tasks (researching, exploring codebase, running tests) autonomously.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Detailed objective for the subagent' },
      context: { type: 'string', description: 'Relevant background details, paths, or constraints' },
      mode: { type: 'string', description: 'Agent mode: "explore" (read-only) or "research" (search/read/execute)', enum: ['explore', 'research'] },
      name: { type: 'string', description: 'Short descriptive label for this subagent task (e.g. "Auth Module Analyzer")' },
      max_steps: { type: 'number', description: 'Maximum tool steps before stopping subagent execution (default: 15)' },
      timeout_ms: { type: 'number', description: 'Timeout bound in milliseconds (default: 60000)' },
    },
    required: ['goal'],
  },
  requiresConfirmation: true,
  getLabel: ({ goal, name }) => `${name || 'Codebase Explorer'}: ${String(goal).slice(0, 50)}`,
  getRiskSummary: ({ goal, mode, name }) => `${name || 'Codebase Explorer'} (${mode || 'explore'}) — "${String(goal).slice(0, 70)}"`,
  async execute({ goal, context = '', mode = 'explore', name = 'Codebase Explorer', max_steps, timeout_ms }: {
    goal: string; context?: string; mode?: string; name?: string; max_steps?: number; timeout_ms?: number;
  }) {
    const { runAgent, createAgentProvider } = await import('../agent/index.js');
    const { provider, config } = createAgentProvider();

    const result = await runAgent(config, provider, {
      name,
      goal: String(goal),
      context: String(context),
      mode: mode === 'research' ? 'research' : 'explore',
      parentCwd: process.cwd(),
      ...(typeof max_steps === 'number' ? { maxSteps: max_steps } : {}),
      ...(typeof timeout_ms === 'number' ? { timeoutMs: timeout_ms } : {}),
    });

    const header = result.error ? `${name} completed with error` : `${name} complete`;
    const stats = `${result.toolCallsMade} tool calls, ${result.filesExamined.length} files examined`;
    return `${header} (${stats})\n\n${result.summary}`;
  },
};

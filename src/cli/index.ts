import { Command } from 'commander';
import chalk from 'chalk';
import { search, Separator, input } from '@inquirer/prompts';
import readline from 'readline';
import figures from 'figures';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig } from '../config/index.js';
import { ProviderFactory } from '../providers/index.js';
import { AIProvider, Message } from '../providers/types.js';
import { tools } from '../tools/index.js';
import { AVAILABLE_MODELS } from './core/models.js';
import { safePrompt, ensureApiKey } from './core/auth.js';
import { confirmTool, confirmYesNo } from './core/tool-confirmation.js';
import { composeSystemPrompt, readProjectContext } from './core/context.js';
import { COLORS, THEME } from './ui/theme.js';
import { buildStatusBar, renderWelcome } from './ui/rendering.js';
import { smartInput } from './ui/smart-input.js';
import {
  HarnessMemory,
  TaskContinuityTracker,
  isHeavyTask,
} from './core/intelligence.js';
import {
  createTerminalTurnIO,
  executeHarnessTurn,
  prepareExecutionTurn,
  runPlanningPass,
} from './core/turn-executor.js';

export const program = new Command();

type PlanningMode = 'auto' | 'on' | 'off';
const RUNTIME_IDENTITY_PREFIX = '[RUNTIME_IDENTITY]';

function buildRuntimeIdentityMessage(currentProvider: string, currentModel: string): Message {
  return {
    role: 'system',
    content: `${RUNTIME_IDENTITY_PREFIX}
You are operating inside Sentinel CLI (a harness, not a standalone chatbot).
Current provider: ${currentProvider}
Current model: ${currentModel}
If asked about your model, provider, or identity, answer with this runtime info first, then mention Sentinel CLI as the harness.`,
  };
}

function upsertRuntimeIdentityContext(messages: Message[], currentProvider: string, currentModel: string): Message[] {
  const runtimeMessage = buildRuntimeIdentityMessage(currentProvider, currentModel);
  const filtered = messages.filter(m => !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(RUNTIME_IDENTITY_PREFIX)));
  const firstSystemIndex = filtered.findIndex(m => m.role === 'system');
  if (firstSystemIndex === -1) {
    return [runtimeMessage, ...filtered];
  }
  const next = [...filtered];
  next.splice(firstSystemIndex + 1, 0, runtimeMessage);
  return next;
}

function isPureGreeting(input: string): boolean {
  const normalized = input.toLowerCase().trim();
  return /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)([!.?,\s]*)$/.test(normalized);
}

function isModelOrIdentityQuestion(input: string): boolean {
  const normalized = input.toLowerCase();
  return /(what|which)\s+(model|provider)\b/.test(normalized)
    || /\bwhat model are you\b/.test(normalized)
    || /\bwhich model are you\b/.test(normalized)
    || /\bwho are you\b/.test(normalized)
    || /\bwhat are you\b/.test(normalized);
}

function buildDeterministicQuickReply(input: string, currentProvider: string, currentModel: string): string | null {
  if (isModelOrIdentityQuestion(input)) {
    return `I'm running via **Sentinel CLI** (the harness) on **${currentProvider} / ${currentModel}**.`;
  }
  if (isPureGreeting(input)) {
    return 'Hey — share the coding task and target file(s), and I\'ll execute it directly.';
  }
  return null;
}

function withInteractiveStdin() {
  readline.emitKeypressEvents(process.stdin);
  let enabled = false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    enabled = true;
  }

  return () => {
    if (enabled && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };
}

function saveSession(messages: Message[], currentProvider: string, currentModel: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `sentinel-session-${timestamp}.md`;
  const filePath = path.join(process.cwd(), filename);
  const content = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const role = m.role === 'user' ? '**User**' : m.role === 'assistant' ? '**Sentinel**' : `**[Tool: ${m.name}]**`;
      return `### ${role}\n${m.content}\n`;
    })
    .join('\n---\n\n');
  const header = `# Sentinel Session\n> ${currentProvider} / ${currentModel}\n> ${new Date().toLocaleString()}\n\n---\n\n`;
  fs.writeFileSync(filePath, header + content, 'utf-8');
  console.log(chalk.green(`\n ✔ Session saved to ${chalk.bold(filename)}\n`));
}

function showStats(messages: Message[], currentProvider: string, currentModel: string, planningMode: PlanningMode, continuity: TaskContinuityTracker) {
  const msgCount = messages.filter(m => m.role !== 'system').length;
  const userMsgs = messages.filter(m => m.role === 'user').length;
  const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
  const toolMsgs = messages.filter(m => m.role === 'tool').length;
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const approx = Math.round(totalChars / 4);
  console.log(THEME.border('\n  ╭─ Session Stats ─────────────────'));
  console.log(THEME.border('  │ ') + THEME.body('Provider: ') + chalk.hex(COLORS.green300)(currentProvider));
  console.log(THEME.border('  │ ') + THEME.body('Model:    ') + chalk.hex(COLORS.green300)(currentModel));
  console.log(THEME.border('  │ ') + THEME.body('Messages: ') + chalk.hex(COLORS.green400)(`${msgCount}`) + THEME.dim(` (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool)`));
  console.log(THEME.border('  │ ') + THEME.body('Context:  ') + chalk.hex(COLORS.green400)(`~${approx.toLocaleString()} tokens`) + THEME.dim(` (${(totalChars / 1024).toFixed(1)} KB)`));
  console.log(THEME.border('  │ ') + THEME.body('Planning: ') + chalk.hex(COLORS.green400)(planningMode));
  console.log(THEME.border('  │ ') + THEME.body('Mode:     ') + chalk.hex(COLORS.green400)(continuity.getMode()));
  console.log(THEME.border('  │ ') + THEME.body('Focus:    ') + chalk.hex(COLORS.green400)(String(continuity.getFocusedFiles().length)) + THEME.dim(' tracked files'));
  console.log(THEME.border('  ╰──────────────────────────────────\n'));
}

function showTools() {
  console.log(THEME.border('\n  ╭─ Available Tools ────────────────'));
  for (const tool of tools) {
    const icon = tool.requiresConfirmation ? chalk.hex(COLORS.green400)('⚠') : THEME.icon('◈');
    console.log(THEME.border('  │ ') + icon + ' ' + THEME.body(tool.name) + THEME.dim(` — ${tool.description.slice(0, 60)}...`));
  }
  console.log(THEME.border('  ╰──────────────────────────────────\n'));
}

async function chooseModel(config: ReturnType<typeof loadConfig>) {
  const selected: any = await safePrompt(() => search({
    message: 'Select Model (Inspect or type to search)',
    source: async (term) => {
      if (!term) return AVAILABLE_MODELS;
      const lowered = term.toLowerCase();
      return AVAILABLE_MODELS.filter(model =>
        !(model instanceof Separator) && ((model as any).value.model.toLowerCase().includes(lowered) || (model as any).value.provider.toLowerCase().includes(lowered))
      );
    }
  }));

  if (!selected) return null;

  let newModel = selected.model;
  let newProvider = selected.provider;
  if (newModel === 'custom') {
    const customName = await safePrompt(() => input({ message: 'Enter custom model name:' }));
    if (!customName) return null;
    newModel = customName;
    newProvider = 'openrouter';
  }

  const hasKey = await ensureApiKey(newProvider, config);
  if (!hasKey) return null;

  const providerModelKey = `${newProvider.toUpperCase()}_MODEL`;
  (config as any)[providerModelKey] = newModel;
  config.DEFAULT_PROVIDER = newProvider as any;
  saveConfig({ [providerModelKey]: newModel, DEFAULT_PROVIDER: newProvider as any } as any);
  return { provider: newProvider, model: newModel };
}

async function maybeRunPlanning(
  provider: AIProvider,
  messages: Message[],
  taskInput: string,
  planningMode: PlanningMode,
  memory: HarnessMemory,
) {
  const io = createTerminalTurnIO();
  const shouldPlan = planningMode === 'on' || (planningMode === 'auto' && isHeavyTask(taskInput));
  if (!shouldPlan) return true;

  const accepted = planningMode === 'on'
    ? true
    : await confirmYesNo('Heavy task detected. Start with a plan first?', true);

  if (!accepted) return true;

  const plan = await runPlanningPass(provider, messages, taskInput);
  if (plan.trim()) {
    await io.showPlan(plan);
    memory.addSummary('plan', plan);
  }

  return confirmYesNo('Proceed with execution now?', true);
}

async function runPromptTurn(
  provider: AIProvider,
  messages: Message[],
  taskInput: string,
  memory: HarnessMemory,
  continuity: TaskContinuityTracker,
  toolResultCache: Map<string, string>,
) {
  const prepared = await prepareExecutionTurn(taskInput, memory, continuity);
  messages.push({ role: 'user', content: prepared.executionInput });
  return executeHarnessTurn({
    provider,
    taskInput,
    messages,
    memory,
    continuity,
    tools,
    toolResultCache,
    io: createTerminalTurnIO(),
    confirmTool,
    autoLoadedPathSet: prepared.autoLoadedPathSet,
  });
}

function handleInitCommand() {
  const mdPath = path.join(process.cwd(), 'SENTINEL.md');
  if (fs.existsSync(mdPath)) {
    console.log(chalk.yellow(` ${figures.warning} SENTINEL.md already exists in this directory.\n`));
    return;
  }
  fs.writeFileSync(mdPath, `# Sentinel Context\n\nDescribe your project, coding style, and any rules Sentinel should follow.\n\n## Project\n- **Name**: \n- **Stack**: \n- **Notes**: \n`);
  console.log(chalk.green(` ${figures.tick} Generated SENTINEL.md! Add your custom context there.\n`));
}

function showHelp() {
  console.log(THEME.border('\n  ╭─ Sentinel Commands ──────────────'));
  const commands = [
    ['/models',   'Switch AI model and provider'],
    ['/tools',    'List all available agent tools'],
    ['/stats',    'Show session stats & token usage'],
    ['/compact',  'Trim old messages to free context'],
    ['/planning', 'Planning mode (auto|on|off)'],
    ['/save',     'Export session to markdown file'],
    ['/init',     'Generate a SENTINEL.md project file'],
    ['/clear',    'Clear conversation history'],
    ['/exit',     'Close Sentinel'],
  ];
  for (const [command, description] of commands) {
    console.log(THEME.border('  │ ') + THEME.accent((command ?? '').padEnd(10)) + THEME.body(description));
  }
  console.log(THEME.border('  │'));
  console.log(THEME.border('  │ ') + THEME.header('File mentions'));
  console.log(THEME.border('  │ ') + THEME.dim('Type ') + THEME.accent('@') + THEME.dim(' to browse files, or just name a file (e.g. ') + THEME.accent('calculator.html') + THEME.dim(')'));
  console.log(THEME.border('  ╰──────────────────────────────────\n'));
}

async function handleSlashCommand(
  trimmedInput: string,
  state: {
    config: ReturnType<typeof loadConfig>;
    currentProvider: string;
    currentModel: string;
    planningMode: PlanningMode;
    messages: Message[];
    continuity: TaskContinuityTracker;
    fullSystemPrompt: string;
  }
): Promise<{ handled: boolean; currentProvider: string; currentModel: string; planningMode: PlanningMode; messages: Message[]; shouldExit?: boolean }> {
  let { currentProvider, currentModel, planningMode, messages } = state;
  const parts = trimmedInput.split(' ');
  const command = (parts[0] ?? '').toLowerCase();

  if (command === '/exit' || command === '/quit') {
    return { handled: true, currentProvider, currentModel, planningMode, messages, shouldExit: true };
  }

  if (command === '/planning') {
    const next = (parts[1] ?? '').toLowerCase();
    if (next === 'on' || next === 'off' || next === 'auto') {
      planningMode = next as PlanningMode;
      console.log(chalk.green(`\n ✔ Planning mode set to ${planningMode}\n`));
    } else {
      console.log(chalk.dim(`\n Planning mode: ${planningMode} (use /planning auto|on|off)\n`));
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/clear') {
    messages = upsertRuntimeIdentityContext(
      [{ role: 'system', content: state.fullSystemPrompt }],
      currentProvider,
      currentModel
    );
    state.continuity.reset();
    renderWelcome(currentProvider, currentModel);
    console.log(chalk.dim(' Conversation history cleared.\n'));
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/compact') {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const kept = nonSystem.slice(-8);
    const removed = nonSystem.length - kept.length;
    messages = [...systemMsgs, ...kept];
    console.log(chalk.green(`\n ✔ Compacted: removed ${removed} older messages, kept ${kept.length}.\n`));
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/stats') {
    showStats(messages, currentProvider, currentModel, planningMode, state.continuity);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/tools') {
    showTools();
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/save') {
    saveSession(messages, currentProvider, currentModel);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/models') {
    const chosen = await chooseModel(state.config);
    if (!chosen) {
      return { handled: true, currentProvider, currentModel, planningMode, messages };
    }
    currentProvider = chosen.provider;
    currentModel = chosen.model;
    messages = upsertRuntimeIdentityContext(messages, currentProvider, currentModel);
    renderWelcome(currentProvider, currentModel);
    console.log(chalk.green(` ${figures.tick} Switched and saved to ${currentModel} (${currentProvider})\n`));
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/init') {
    handleInitCommand();
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/help') {
    showHelp();
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  console.log(chalk.yellow(`\n ⚠ Unknown command: ${command}. Type /help for a list.\n`));
  return { handled: true, currentProvider, currentModel, planningMode, messages };
}

export async function startChat(providerName?: string, modelName?: string) {
  const config = loadConfig();
  let currentProvider = providerName || config.DEFAULT_PROVIDER;
  const configKey = `${currentProvider.toUpperCase()}_MODEL`;
  let currentModel = modelName || (config as any)[configKey];
  let planningMode: PlanningMode = 'auto';
  const memory = new HarnessMemory();
  const continuity = new TaskContinuityTracker();

  renderWelcome(currentProvider, currentModel);
  const restoreStdin = withInteractiveStdin();
  process.once('exit', restoreStdin);

  const projectContext = readProjectContext();
  if (projectContext) {
    process.stdout.write(chalk.dim(' 📋 Loaded SENTINEL.md project context\n\n'));
  }

  const fullSystemPrompt = composeSystemPrompt(projectContext, '--- Project Context (from SENTINEL.md) ---');
  let messages: Message[] = upsertRuntimeIdentityContext(
    [{ role: 'system', content: fullSystemPrompt }],
    currentProvider,
    currentModel
  );
  const toolResultCache = new Map<string, string>();

  try {
    while (true) {
      const ctxChars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
      const approxTokens = Math.round(ctxChars / 4);
      const statusLines = buildStatusBar(currentModel, approxTokens);

      const userInput = await smartInput(statusLines);
      if (userInput === null) continue;

      const trimmedInput = userInput.trim();
      if (!trimmedInput) continue;

      if (trimmedInput.startsWith('/')) {
        const slashResult = await handleSlashCommand(trimmedInput, {
          config,
          currentProvider,
          currentModel,
          planningMode,
          messages,
          continuity,
          fullSystemPrompt,
        });
        if (slashResult.shouldExit) break;
        currentProvider = slashResult.currentProvider;
        currentModel = slashResult.currentModel;
        planningMode = slashResult.planningMode;
        messages = slashResult.messages;
        continue;
      }

      const quickReply = buildDeterministicQuickReply(trimmedInput, currentProvider, currentModel);
      if (quickReply) {
        await createTerminalTurnIO().renderAssistant(quickReply);
        messages.push({ role: 'user', content: trimmedInput }, { role: 'assistant', content: quickReply });
        memory.addSummary('assistant', quickReply);
        continue;
      }

      continuity.onUserInput(trimmedInput);
      const hasKey = await ensureApiKey(currentProvider, config);
      if (!hasKey) continue;

      let provider: AIProvider;
      try {
        provider = ProviderFactory.getProvider(currentProvider, config, currentModel);
      } catch (err: any) {
        console.log(chalk.red(`\n ${figures.cross} Provider Setup Error: ${err.message || err}`));
        continue;
      }

      const proceed = await maybeRunPlanning(provider, messages, trimmedInput, planningMode, memory);
      if (!proceed) continue;

      await runPromptTurn(provider, messages, trimmedInput, memory, continuity, toolResultCache);
    }
  } finally {
    restoreStdin();
  }
}

program
  .command('chat')
  .description('Start an interactive chat session')
  .option('-p, --provider <provider>', 'LLM provider (gemini, openrouter)')
  .option('-m, --model <model>', 'Model name to use')
  .action(async (options) => {
    await startChat(options.provider, options.model);
  });

program
  .command('run <prompt>')
  .description('Run a one-shot prompt and exit (non-interactive)')
  .option('-p, --provider <provider>', 'LLM provider')
  .option('-m, --model <model>', 'Model name')
  .action(async (prompt, options) => {
    await runOnce(prompt, options.provider, options.model);
  });

program
  .command('config')
  .description('Configure API keys and settings')
  .option('-g, --gemini <key>', 'Set Gemini API Key')
  .option('--openrouter <key>', 'Set OpenRouter API Key')
  .option('-m, --model <model>', 'Set default Gemini model')
  .action((options) => {
    const updates: any = {};
    if (options.gemini) { updates.GEMINI_API_KEY = options.gemini; console.log(chalk.green(' ✔ Gemini API key saved')); }
    if (options.openrouter) { updates.OPENROUTER_API_KEY = options.openrouter; console.log(chalk.green(' ✔ OpenRouter API key saved')); }
    if (options.model) { updates.GEMINI_MODEL = options.model; console.log(chalk.green(` ✔ Default model set to ${options.model}`)); }
    if (Object.keys(updates).length > 0) {
      saveConfig(updates);
    } else {
      console.log(chalk.dim('  No changes. Use --help to see options.'));
    }
  });

export async function runOnce(prompt: string, providerName?: string, modelName?: string) {
  const config = loadConfig();
  const currentProvider = providerName || config.DEFAULT_PROVIDER;
  const configKey = `${currentProvider.toUpperCase()}_MODEL`;
  const currentModel = modelName || (config as any)[configKey];
  const memory = new HarnessMemory();
  const continuity = new TaskContinuityTracker();
  const toolResultCache = new Map<string, string>();

  const quickReply = buildDeterministicQuickReply(prompt, currentProvider, currentModel);
  if (quickReply) {
    process.stdout.write(`${quickReply}\n`);
    return;
  }

  continuity.onUserInput(prompt);
  const projectContext = readProjectContext();
  const systemContent = composeSystemPrompt(projectContext, '--- Project Context ---');
  const hasKey = await ensureApiKey(currentProvider, config);
  if (!hasKey) process.exit(1);

  let provider: AIProvider;
  try {
    provider = ProviderFactory.getProvider(currentProvider, config, currentModel);
  } catch (err: any) {
    process.stderr.write(chalk.red(`Error: ${err.message}\n`));
    process.exit(1);
  }

  const messages: Message[] = upsertRuntimeIdentityContext(
    [{ role: 'system', content: systemContent }],
    currentProvider,
    currentModel
  );
  if (isHeavyTask(prompt)) {
    const plan = await runPlanningPass(provider, messages, prompt);
    if (plan.trim()) {
      await createTerminalTurnIO().showPlan(plan);
      memory.addSummary('plan', plan);
    }
  }

  const restoreStdin = withInteractiveStdin();
  try {
    await runPromptTurn(provider, messages, prompt, memory, continuity, toolResultCache);
  } finally {
    restoreStdin();
  }
}

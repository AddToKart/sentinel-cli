import { loadConfig, getCustomProvider } from '../config/index.js';
import { ProviderFactory } from '../providers/index.js';
import { AIProvider, Message } from '../providers/types.js';
import { tools } from '../tools/index.js';
import { ensureApiKey } from './core/auth.js';
import { confirmTool, confirmYesNo, hasAnyTrust } from './core/tool-confirmation.js';
import { composeSystemPrompt, readProjectContext } from './core/context.js';
import { Style } from './ui/theme.js';
import { buildStatusBar, renderWelcome } from './ui/rendering.js';
import { smartInput } from './ui/smart-input.js';
import { HarnessMemory, TaskContinuityTracker, isHeavyTask } from './core/intelligence.js';
import { createTerminalTurnIO, executeHarnessTurn, prepareExecutionTurn, runPlanningPass } from './core/turn-executor.js';
import { checkForUpdate } from './core/updater.js';
import { startAutoSave, stopAutoSave, isFreshInstall } from './core/session-store.js';
import { getCostSummary } from './core/tracker.js';
import { upsertRuntimeIdentityContext, withInteractiveStdin } from './runtime-identity.js';
import { PlanningMode } from './commands/index.js';
import { handleSlashCommand } from './slash-dispatcher.js';

export async function maybeRunPlanning(provider: AIProvider, messages: Message[], taskInput: string, planningMode: PlanningMode, memory: HarnessMemory) {
  const io = createTerminalTurnIO();
  const shouldPlan = planningMode === 'on' || (planningMode === 'auto' && isHeavyTask(taskInput));
  if (!shouldPlan) return true;
  const accepted = planningMode === 'on' ? true : await confirmYesNo('Heavy task detected. Start with a plan first?', true);
  if (!accepted) return true;
  const plan = await runPlanningPass(provider, messages, taskInput);
  if (plan.trim()) {
    await io.showPlan(plan);
    memory.addSummary('plan', plan);
    messages.push({ role: 'assistant', content: `[Execution Plan]:\n${plan}` });
  }
  return confirmYesNo('Proceed with execution now?', true);
}

export async function runPromptTurn(provider: AIProvider, messages: Message[], taskInput: string, memory: HarnessMemory, continuity: TaskContinuityTracker, toolResultCache: Map<string, string>) {
  const prepared = await prepareExecutionTurn(taskInput, memory, continuity);
  messages.push({ role: 'user', content: prepared.executionInput });
  return executeHarnessTurn({
    provider, taskInput, messages, memory, continuity, tools, toolResultCache,
    io: createTerminalTurnIO(), confirmTool, autoLoadedPathSet: prepared.autoLoadedPathSet,
  });
}

export async function startChat(providerName?: string, modelName?: string) {
  const config = loadConfig();
  let currentProvider = providerName || config.DEFAULT_PROVIDER;
  let currentModel: string = modelName || '';
  if (!currentModel) {
    const configKey = `${currentProvider.toUpperCase()}_MODEL`;
    currentModel = (config as any)[configKey] || '';
    if (!currentModel) {
      const custom = getCustomProvider(currentProvider);
      if (custom) currentModel = custom.model;
    }
  }
  if (!currentModel) currentModel = 'unknown';
  let planningMode: PlanningMode = 'auto';
  const memory = new HarnessMemory();
  const continuity = new TaskContinuityTracker();

  renderWelcome(currentProvider, currentModel);
  const restoreStdin = withInteractiveStdin();
  process.once('exit', restoreStdin);

  const projectContext = readProjectContext();
  if (projectContext) process.stdout.write(Style.dim(' 📋 Loaded SENTINEL.md project context\n\n'));

  if (isFreshInstall()) {
    process.stdout.write(Style.warning(' ⚠ First run detected \n'));
    process.stdout.write(`  ${Style.dim('Set up your API key with:')} ${Style.accent('sentinel config --gemini <key>')}\n`);
    process.stdout.write(`  ${Style.dim('Or use a custom provider:')} ${Style.accent('/connect')} ${Style.dim('in the chat\n\n')}`);
  }

  checkForUpdate().then(({ updateAvailable, latest }) => {
    if (updateAvailable) process.stdout.write(`${Style.warning(' ⚠')} Update available! ${Style.accent(latest ?? '')} is out. Type ${Style.accent('/update')} to install.\n\n`);
  }).catch(() => {});

  const fullSystemPrompt = composeSystemPrompt(projectContext, '--- Project Context (from SENTINEL.md) ---');
  let messages: Message[] = upsertRuntimeIdentityContext(
    [{ role: 'system', content: fullSystemPrompt }], currentProvider, currentModel
  );
  const toolResultCache = new Map<string, string>();

  startAutoSave(currentProvider, currentModel, () => messages.filter(m => m.role !== 'system'));
  process.once('exit', () => stopAutoSave());

  try {
    while (true) {
      const ctxChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
      const approxTokens = Math.round(ctxChars / 4);
      const costSummary = getCostSummary(currentModel);
      const statusLines = buildStatusBar(currentModel, approxTokens, hasAnyTrust(), costSummary);

      const userInput = await smartInput(statusLines);
      if (userInput === null) continue;

      const trimmedInput = userInput.trim();
      if (!trimmedInput) continue;

      if (trimmedInput.startsWith('/')) {
        const slashResult = await handleSlashCommand(trimmedInput, { config, currentProvider, currentModel, planningMode, messages, continuity, fullSystemPrompt });
        if (slashResult.shouldExit) break;
        currentProvider = slashResult.currentProvider;
        currentModel = slashResult.currentModel;
        planningMode = slashResult.planningMode;
        messages = slashResult.messages;
        continue;
      }

      continuity.onUserInput(trimmedInput);
      const hasKey = await ensureApiKey(currentProvider, config);
      if (!hasKey) continue;

      let provider: AIProvider;
      try { provider = ProviderFactory.getProvider(currentProvider, config, currentModel); }
      catch (err: any) { process.stdout.write(Style.error(`\n ✖ Provider Error: ${err.message || err}\n\n`)); continue; }

      const proceed = await maybeRunPlanning(provider, messages, trimmedInput, planningMode, memory);
      if (!proceed) continue;

      await runPromptTurn(provider, messages, trimmedInput, memory, continuity, toolResultCache);
    }
  } finally { restoreStdin(); }
}

export async function runOnce(prompt: string, providerName?: string, modelName?: string) {
  const config = loadConfig();
  const currentProvider = providerName || config.DEFAULT_PROVIDER;
  let currentModel: string = modelName || '';
  if (!currentModel) {
    const configKey = `${currentProvider.toUpperCase()}_MODEL`;
    currentModel = (config as any)[configKey] || '';
    if (!currentModel) {
      const custom = getCustomProvider(currentProvider);
      if (custom) currentModel = custom.model;
    }
  }
  if (!currentModel) currentModel = 'unknown';
  const memory = new HarnessMemory();
  const continuity = new TaskContinuityTracker();
  const toolResultCache = new Map<string, string>();

  continuity.onUserInput(prompt);
  const projectContext = readProjectContext();
  const systemContent = composeSystemPrompt(projectContext, '--- Project Context ---');
  const hasKey = await ensureApiKey(currentProvider, config);
  if (!hasKey) process.exit(1);

  let provider: AIProvider;
  try { provider = ProviderFactory.getProvider(currentProvider, config, currentModel); }
  catch (err: any) { process.stderr.write(Style.error(`Error: ${err.message}\n`)); process.exit(1); }

  const messages: Message[] = upsertRuntimeIdentityContext([{ role: 'system', content: systemContent }], currentProvider, currentModel);
  if (isHeavyTask(prompt)) {
    const plan = await runPlanningPass(provider, messages, prompt);
    if (plan.trim()) { await createTerminalTurnIO().showPlan(plan); memory.addSummary('plan', plan); }
  }

  const restoreStdin = withInteractiveStdin();
  try { await runPromptTurn(provider, messages, prompt, memory, continuity, toolResultCache); }
  finally { restoreStdin(); }
}

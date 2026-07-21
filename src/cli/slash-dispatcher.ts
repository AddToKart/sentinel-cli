import readline from 'readline';
import { loadConfig, removeCustomProvider, getCustomProvider, addCustomProvider } from '../config/index.js';
import { Message } from '../providers/types.js';
import { Style, buildPanel } from './ui/theme.js';
import { renderWelcome, startSpinner } from './ui/rendering.js';
import { TaskContinuityTracker, compressMessageHistory } from './core/intelligence.js';
import { setSandboxEnabled, isSandboxEnabled } from './core/sandbox.js';
import { trustDirectory, untrustDirectory, clearAllTrust, confirmYesNo } from './core/tool-confirmation.js';
import { undoLastFileOp, getUndoCount, getLastUndoLabel } from './core/undo.js';
import { safePrompt } from './core/auth.js';
import { checkForUpdate, performUpdate } from './core/updater.js';
import { remember, forget, listMemories, getMemoryStats, MemoryType } from './core/persistent-memory.js';
import { upsertRuntimeIdentityContext } from './runtime-identity.js';
import {
  saveSession, loadSession, listSessions, exportSessionToMarkdown,
  showStats, showTools, showHelp, chooseModel, showProviders, showConfigMenu, setModelParam, handleInitCommand, PlanningMode
} from './commands/index.js';
import { CustomProvider, CustomProviderConfig } from '../providers/custom.js';

export async function handleConnect(config: ReturnType<typeof loadConfig>, existingName?: string): Promise<{ name: string; model: string } | null> {
  const { input, password } = await import('@inquirer/prompts');

  if (existingName) {
    const existing = getCustomProvider(existingName);
    if (existing) {
      process.stdout.write(`\n${Style.icon('◈')} ${Style.accent(existing.name)} ${Style.dim('is already configured.')}\n`);
      const body = buildPanel('Provider Details', [
        `${Style.dim('Name:')}    ${Style.accent(existing.name)}`,
        `${Style.dim('URL:')}     ${Style.body(existing.baseUrl)}`,
        `${Style.dim('Model:')}   ${Style.body(existing.model)}`,
        `${Style.dim('Key:')}     ${Style.dim('•••••' + existing.apiKey.slice(-4))}`,
      ]);
      for (const l of body) process.stdout.write(`  ${l}\n`);
      process.stdout.write(`\n  ${Style.dim('Use')} ${Style.accent('/providers remove ' + existing.name)} ${Style.dim('to remove it.')}\n\n`);
      return null;
    }
  }

  process.stdout.write(`\n${Style.icon('◈')} ${Style.header('Connect Custom Provider')}\n`);
  process.stdout.write(Style.dim(' Supports any OpenAI-compatible API (Ollama, vLLM, LM Studio, TGI, etc.)\n\n'));

  const name = existingName || await safePrompt(() =>
    input({ message: 'Name for this provider (e.g. my-ollama):', validate: (v: string) => v.trim().length > 0 && v.trim().length <= 64 })
  );
  if (!name || !name.trim()) { process.stdout.write(Style.error(' ✖ Cancelled.\n\n')); return null; }

  const baseUrl = await safePrompt(() =>
    input({ message: 'Base URL (e.g. http://localhost:11434):', validate: (v: string) => {
      try { new URL(v.trim()); return true; } catch { return 'Enter a valid URL (e.g. http://localhost:11434)'; }
    }})
  );
  if (!baseUrl) { process.stdout.write(Style.error(' ✖ Cancelled.\n\n')); return null; }

  const model = await safePrompt(() =>
    input({ message: 'Model name (e.g. llama3.2):', validate: (v: string) => v.trim().length > 0 })
  );
  if (!model) { process.stdout.write(Style.error(' ✖ Cancelled.\n\n')); return null; }

  const apiKey = await safePrompt(() =>
    password({ message: 'API Key (leave empty if not required):', mask: true })
  );
  if (apiKey === null) { process.stdout.write(Style.error(' ✖ Cancelled.\n\n')); return null; }

  const entry: CustomProviderConfig = {
    name: name.trim(),
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    model: model.trim(),
    apiKey: apiKey || '',
  };

  process.stdout.write(`\n${Style.dim(' Testing connection...')}\n`);
  const stop = startSpinner('Connecting...');
  const provider = new CustomProvider(entry);
  const testResult = await provider.testConnection();
  stop();

  if (testResult.ok) {
    process.stdout.write(`${Style.success(' ✔')} Connection successful! ${Style.dim(testResult.message)}\n`);
    addCustomProvider({ ...entry, createdAt: new Date().toISOString() });
    process.stdout.write(`\n${Style.success(' ✔')} Provider ${Style.accent(entry.name)} saved to ${Style.dim('~/.sentinel/config.json')}\n`);
    return { name: entry.name, model: entry.model };
  } else {
    process.stdout.write(`${Style.error(' ✖')} Connection failed: ${Style.body(testResult.message)}\n\n`);
    const tryAgain = await confirmYesNo('Save anyway and try again later?', false);
    if (tryAgain) {
      addCustomProvider({ ...entry, createdAt: new Date().toISOString() });
      process.stdout.write(`${Style.success(' ✔')} Provider ${Style.accent(entry.name)} saved (untested).\n\n`);
      return { name: entry.name, model: entry.model };
    } else {
      process.stdout.write(Style.dim(' Provider not saved.\n\n'));
      return null;
    }
  }
}

export async function handleSlashCommand(trimmedInput: string, state: {
  config: ReturnType<typeof loadConfig>;
  currentProvider: string;
  currentModel: string;
  planningMode: PlanningMode;
  messages: Message[];
  continuity: TaskContinuityTracker;
  fullSystemPrompt: string;
}): Promise<{ handled: boolean; currentProvider: string; currentModel: string; planningMode: PlanningMode; messages: Message[]; shouldExit?: boolean }> {
  let { currentProvider, currentModel, planningMode, messages } = state;
  const parts = trimmedInput.split(' ');
  const command = (parts[0] ?? '').toLowerCase();

  if (['/exit', '/quit'].includes(command)) return { handled: true, currentProvider, currentModel, planningMode, messages, shouldExit: true };

  if (command === '/planning') {
    const next = (parts[1] ?? '').toLowerCase();
    if (['on', 'off', 'auto'].includes(next)) {
      planningMode = next as PlanningMode;
      process.stdout.write(`${Style.success(' ✔')} Planning mode set to ${Style.accent(planningMode)}\n\n`);
    } else { process.stdout.write(`${Style.dim(` Planning mode: ${planningMode} (use /planning auto|on|off)`)}\n\n`); }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/clear') {
    messages = upsertRuntimeIdentityContext([{ role: 'system', content: state.fullSystemPrompt }], currentProvider, currentModel);
    state.continuity.reset();
    renderWelcome(currentProvider, currentModel);
    process.stdout.write(Style.dim(' Conversation history cleared.\n\n'));
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/compact') {
    const { messages: compressedMsgs, compressedCount } = compressMessageHistory(messages, 0);
    const systemMsgs = compressedMsgs.filter(m => m.role === 'system');
    const nonSystem = compressedMsgs.filter(m => m.role !== 'system');
    const kept = nonSystem.slice(-10);
    messages = [...systemMsgs, ...kept];
    process.stdout.write(`${Style.success(' ✔')} Compacted: summarized ${Style.accent(String(compressedCount))} tool outputs, kept latest ${Style.accent(String(kept.length))} messages.\n\n`);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/stats') { showStats(messages, currentProvider, currentModel, planningMode, state.continuity); return { handled: true, currentProvider, currentModel, planningMode, messages }; }
  if (command === '/tools') { showTools(); return { handled: true, currentProvider, currentModel, planningMode, messages }; }

  if (command === '/save') {
    const targetPath = parts.slice(1).join(' ').trim();
    saveSession(messages, currentProvider, currentModel, targetPath || undefined);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/export') {
    const targetPath = parts.slice(1).join(' ').trim();
    exportSessionToMarkdown(messages, currentProvider, currentModel, targetPath || undefined);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/load') {
    const { files } = listSessions();
    if (files.length === 0) { process.stdout.write(Style.dim(' No saved sessions found.\n\n')); return { handled: true, currentProvider, currentModel, planningMode, messages }; }
    process.stdout.write(`${Style.icon('◈')} ${Style.header('Saved Sessions')}\n`);
    for (let i = 0; i < Math.min(files.length, 10); i++) {
      process.stdout.write(`  ${Style.accent(String(i + 1))}. ${Style.body(files[i] ?? '')}\n`);
    }
    process.stdout.write(Style.dim(' Type the session filename to load:\n'));
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.question(Style.body('  File: '), (answer) => {
        rl.close();
        const sessionFile = answer.trim() || files[0] || '';
        const loaded = loadSession(sessionFile);
        if (!loaded) { resolve({ handled: true, currentProvider, currentModel, planningMode, messages }); return; }
        currentProvider = loaded.provider;
        currentModel = loaded.model;
        messages = upsertRuntimeIdentityContext(loaded.messages, currentProvider, currentModel);
        process.stdout.write(`\n${Style.success(' ✔')} Loaded session with ${Style.accent(String(loaded.messages.length))} messages.\n\n`);
        resolve({ handled: true, currentProvider, currentModel, planningMode, messages });
      });
    });
  }

  if (command === '/config') {
    const param = parts[1]?.toLowerCase();
    const value = parts.slice(2).join(' ');
    if (!param) { await showConfigMenu(state.config); }
    else if (value) { await setModelParam(state.config, param, value); }
    else { await showConfigMenu(state.config); }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/models') {
    const chosen = await chooseModel(state.config);
    if (!chosen) return { handled: true, currentProvider, currentModel, planningMode, messages };
    currentProvider = chosen.provider;
    currentModel = chosen.model;
    messages = upsertRuntimeIdentityContext(messages, currentProvider, currentModel);
    renderWelcome(currentProvider, currentModel);
    process.stdout.write(`${Style.success(' ✔')} Switched to ${Style.accent(currentModel)} (${Style.accent(currentProvider)})\n\n`);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/sandbox') {
    const sub = (parts[1] ?? '').toLowerCase();
    if (sub === 'off' || sub === 'disable') { setSandboxEnabled(false); process.stdout.write(`${Style.warning(' ⚠')} Directory sandbox ${Style.error('DISABLED')}. Files outside ${Style.accent(process.cwd())} can be accessed.\n\n`); }
    else if (sub === 'on' || sub === 'enable') { setSandboxEnabled(true); process.stdout.write(`${Style.success(' ✔')} Directory sandbox ${Style.accent('ENABLED')}.\n\n`); }
    else { process.stdout.write(`${Style.dim(` Sandbox is ${isSandboxEnabled() ? Style.accent('ENABLED') : Style.error('DISABLED')}. Use /sandbox on|off`)}\n\n`); }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/trust') {
    const sub = (parts[1] ?? '').toLowerCase();
    if (sub === '.' || sub === '' || sub === 'here') {
      trustDirectory(process.cwd());
      process.stdout.write(`\n${Style.success(' 🔓')} ${Style.header('Flow Mode')} — ${Style.accent(process.cwd())} is now trusted.\n`);
      process.stdout.write(`  ${Style.dim('write_file and edit_file will skip confirmation in this directory.')}\n`);
      process.stdout.write(`  ${Style.dim('execute_shell still prompts for safety.')}\n\n`);
    } else {
      process.stdout.write(`\n${Style.warning(' ⚠')} Usage: ${Style.accent('/trust .')} to trust the current directory.\n\n`);
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/untrust') {
    const sub = (parts[1] ?? '').toLowerCase();
    if (sub === '.' || sub === '' || sub === 'here') {
      if (untrustDirectory(process.cwd())) {
        process.stdout.write(`\n${Style.icon(' 🔒')} ${Style.header('Locked')} — ${Style.dim(process.cwd())} is no longer trusted.\n\n`);
      } else {
        process.stdout.write(Style.dim('\n Directory was not trusted.\n\n'));
      }
    } else if (sub === 'all') {
      clearAllTrust();
      process.stdout.write(`\n${Style.icon(' 🔒')} ${Style.header('All trusts cleared.')}\n\n`);
    } else {
      process.stdout.write(`\n${Style.warning(' ⚠')} Usage: ${Style.accent('/untrust .')} or ${Style.accent('/untrust all')}\n\n`);
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/undo') {
    const count = getUndoCount();
    if (count === 0) { process.stdout.write(Style.dim(' Nothing to undo.\n\n')); return { handled: true, currentProvider, currentModel, planningMode, messages }; }
    const label = getLastUndoLabel();
    const ok = await confirmYesNo(`Undo last change? (${label})`, true);
    if (!ok) { process.stdout.write(Style.dim(' Undo cancelled.\n\n')); return { handled: true, currentProvider, currentModel, planningMode, messages }; }
    const result = undoLastFileOp();
    process.stdout.write(`${Style.success(' ↩')} ${Style.body(result)}\n\n`);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/connect') {
    const connectionName = parts.slice(1).join(' ').trim();
    const saved = await handleConnect(state.config, connectionName || undefined);
    if (saved) {
      currentProvider = saved.name;
      currentModel = saved.model;
      messages = upsertRuntimeIdentityContext(messages, currentProvider, currentModel);
      process.stdout.write(`${Style.success(' ✔')} Switched to ${Style.accent(saved.name)} (${Style.accent(saved.model)})\n\n`);
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/providers') {
    const sub = (parts[1] ?? '').toLowerCase();
    const providerName = parts.slice(2).join(' ').trim();
    if (sub === 'remove' && providerName) {
      if (removeCustomProvider(providerName)) process.stdout.write(`${Style.success(' ✔')} Removed provider: ${Style.accent(providerName)}\n\n`);
      else process.stdout.write(`${Style.error(' ✖')} Provider not found: ${Style.accent(providerName)}\n\n`);
    } else {
      showProviders(currentProvider, currentModel);
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/init') { await handleInitCommand(state.config, currentProvider, currentModel); return { handled: true, currentProvider, currentModel, planningMode, messages }; }
  if (command === '/help') { showHelp(); return { handled: true, currentProvider, currentModel, planningMode, messages }; }

  if (command === '/update') {
    await performUpdate();
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/remember') {
    const memoryType = (parts[1] ?? '').toLowerCase() as MemoryType;
    const validTypes: MemoryType[] = ['fact', 'preference', 'pattern', 'lesson', 'user_note'];
    if (!validTypes.includes(memoryType)) {
      process.stdout.write(`${Style.dim(` Usage: /remember <type> <content>`)}\n`);
      process.stdout.write(`${Style.dim(` Types: ${validTypes.join(', ')}`)}\n\n`);
      return { handled: true, currentProvider, currentModel, planningMode, messages };
    }
    const content = parts.slice(2).join(' ').trim();
    if (!content) {
      process.stdout.write(`${Style.error(' ✖')} Provide content to remember.\n\n`);
      return { handled: true, currentProvider, currentModel, planningMode, messages };
    }
    const id = remember(memoryType, content, 'user:/remember');
    if (id) {
      process.stdout.write(`${Style.success(' ✔')} ${Style.accent(memoryType)} memory saved ${Style.dim(`(${id.slice(0, 16)}...)`)}\n\n`);
    } else {
      process.stdout.write(`${Style.dim(' ⓘ Memory already exists (skipped duplicate).\n\n')}`);
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/forget') {
    const memoryId = parts.slice(1).join(' ').trim();
    if (!memoryId) {
      process.stdout.write(`${Style.dim(' Usage: /forget <memory-id>')}\n`);
      process.stdout.write(`${Style.dim(' Use /memories to see IDs.\n\n')}`);
      return { handled: true, currentProvider, currentModel, planningMode, messages };
    }
    if (forget(memoryId)) {
      process.stdout.write(`${Style.success(' ✔')} Memory forgotten.\n\n`);
    } else {
      process.stdout.write(`${Style.error(' ✖')} Memory not found: ${memoryId}\n\n`);
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/memories') {
    const typeFilter = (parts[1] ?? '').toLowerCase() as MemoryType;
    const validTypes: MemoryType[] = ['fact', 'preference', 'pattern', 'lesson', 'user_note'];
    const filter = validTypes.includes(typeFilter) ? [typeFilter] : undefined;
    const memories = listMemories(filter);
    const stats = getMemoryStats();

    if (memories.length === 0) {
      process.stdout.write(`${Style.dim(' No memories yet. Use /remember to add one, or they will be auto-extracted as you work.\n\n')}`);
      return { handled: true, currentProvider, currentModel, planningMode, messages };
    }

    const typeCounts = Object.entries(stats.types).filter(([_, c]) => c > 0).map(([t, c]) => `${t}:${c}`).join('  ');
    const items: string[] = [
      `${Style.dim('Total:')} ${Style.accent(String(stats.count))}  ${Style.dim(typeCounts)}`,
      '',
    ];
    for (const m of memories) {
      const icon = m.type === 'fact' ? '📌' : m.type === 'preference' ? '⭐' : m.type === 'pattern' ? '🔄' : m.type === 'lesson' ? '💡' : '📝';
      const age = new Date(m.updatedAt).toLocaleDateString();
      items.push(`  ${icon} ${Style.accent(m.id.slice(0, 12))}${Style.dim(` [${m.type}]`)} ${m.content.slice(0, 120)}`);
      items.push(`    ${Style.dim(`source: ${m.source.slice(0, 50)} · ${age}`)}`);
    }
    const body = buildPanel('Persistent Project Memories', items);
    for (const l of body) process.stdout.write(`  ${l}\n`);
    process.stdout.write(`  ${Style.dim('Use')} ${Style.accent('/remember <type> <text>')} ${Style.dim('to add,')} ${Style.accent('/forget <id>')} ${Style.dim('to remove.\n\n')}`);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/research') {
    const question = parts.slice(1).join(' ').trim();
    if (!question) {
      process.stdout.write(`${Style.dim(' Usage: /research <question or task for codebase investigation>')}\n\n`);
      return { handled: true, currentProvider, currentModel, planningMode, messages };
    }

    process.stdout.write(`\n${Style.icon('◈')} ${Style.header('Research Subagent')} — investigating: ${Style.body(question)}\n`);
    process.stdout.write(Style.dim(' Spawning read-only explorer...\n\n'));

    try {
      const { runAgent, createAgentProvider } = await import('../agent/index.js');
      const { provider, config } = createAgentProvider();

      const maxWaitMs = 120_000;
      const result = await Promise.race([
        runAgent(config, provider, {
          name: 'Research Agent',
          goal: question,
          context: `The parent agent is running in ${process.cwd()}. Current provider: ${currentProvider}, model: ${currentModel}`,
          mode: 'research',
          parentCwd: process.cwd(),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Research timed out after 120s')), maxWaitMs)
        ),
      ]);

      process.stdout.write(`\n${Style.success(' ─')} ${Style.header('Research Complete')}${Style.dim(` (${result.toolCallsMade} tool calls, ${result.filesExamined.length} files)`)}\n\n`);

      if (result.error) {
        process.stdout.write(`${Style.warning(' ⚠')} Research encountered an error: ${Style.body(result.error)}\n\n`);
      }

      process.stdout.write(result.summary + '\n\n');

      const summaryPreview = result.summary.slice(0, 300).trim();
      if (summaryPreview.length > 50 && result.toolCallsMade > 2) {
        const id = remember('lesson', summaryPreview, `auto:research:${question.slice(0, 60)}`);
        if (id) {
          process.stdout.write(Style.dim(` 💾 Key findings auto-saved as memory.\n\n`));
        }
      }
    } catch (err: any) {
      process.stdout.write(`${Style.error(' ✖')} Research failed: ${Style.body(err.message)}\n\n`);
    }

    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  process.stdout.write(`${Style.warning(' ⚠')} Unknown command: ${Style.accent(command)}. ${Style.body('Type')} ${Style.accent('/help')} ${Style.body('for a list.')}\n\n`);
  return { handled: true, currentProvider, currentModel, planningMode, messages };
}

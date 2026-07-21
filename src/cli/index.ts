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
import { confirmTool, confirmYesNo, trustDirectory, untrustDirectory, isDirectoryTrusted, hasAnyTrust, getTrustedDirectories, clearAllTrust } from './core/tool-confirmation.js';
import { composeSystemPrompt, readProjectContext } from './core/context.js';
import { COLORS, Style, THEME, buildPanel } from './ui/theme.js';
import { buildStatusBar, renderWelcome, highlightMentions, renderDiff, startSpinner } from './ui/rendering.js';
import { smartInput } from './ui/smart-input.js';
import { HarnessMemory, TaskContinuityTracker, isHeavyTask } from './core/intelligence.js';
import { createTerminalTurnIO, executeHarnessTurn, prepareExecutionTurn, runPlanningPass } from './core/turn-executor.js';
import { checkForUpdate, performUpdate } from './core/updater.js';
import { CustomProvider, CustomProviderConfig } from '../providers/custom.js';
import { getCustomProviders, addCustomProvider, removeCustomProvider, getCustomProvider, type CustomProviderEntry } from '../config/index.js';
import { setSandboxEnabled, isSandboxEnabled, resetSandboxApprovals } from './core/sandbox.js';
import { undoLastFileOp, getUndoCount, getLastUndoLabel } from './core/undo.js';
import { startAutoSave, stopAutoSave, isFreshInstall } from './core/session-store.js';
import { getCostSummary } from './core/tracker.js';

export const program = new Command();

type PlanningMode = 'auto' | 'on' | 'off';
const RUNTIME_IDENTITY_PREFIX = '[RUNTIME_IDENTITY]';

// ─── Runtime Identity ────────────────────────────────────────────────────
function buildRuntimeIdentityMessage(currentProvider: string, currentModel: string): Message {
  return {
    role: 'system',
    content: `${RUNTIME_IDENTITY_PREFIX}
You are operating inside Sentinel CLI (a harness, not a standalone chatbot).
Current provider: ${currentProvider}
Current model: ${currentModel}
Sandbox: Active — file operations restricted to the working directory.
If asked about your model, provider, or identity, answer with this runtime info first, then mention Sentinel CLI as the harness.`,
  };
}

function upsertRuntimeIdentityContext(messages: Message[], currentProvider: string, currentModel: string): Message[] {
  const runtimeMessage = buildRuntimeIdentityMessage(currentProvider, currentModel);
  const filtered = messages.filter(m => !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(RUNTIME_IDENTITY_PREFIX)));
  const firstSystemIndex = filtered.findIndex(m => m.role === 'system');
  if (firstSystemIndex === -1) return [runtimeMessage, ...filtered];
  const next = [...filtered];
  next.splice(firstSystemIndex + 1, 0, runtimeMessage);
  return next;
}

// ─── Stdin Management ────────────────────────────────────────────────────
function withInteractiveStdin() {
  readline.emitKeypressEvents(process.stdin);
  let enabled = false;
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); enabled = true; }
  return () => { if (enabled && process.stdin.isTTY) { process.stdin.setRawMode(false); process.stdin.pause(); } };
}

// ─── Session Management ─────────────────────────────────────────────────
function saveSession(messages: Message[], currentProvider: string, currentModel: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `sentinel-session-${timestamp}.json`;
  const filePath = path.join(process.cwd(), filename);
  const sessionData = JSON.stringify({
    version: 2,
    provider: currentProvider,
    model: currentModel,
    savedAt: new Date().toISOString(),
    messages: messages.filter(m => m.role !== 'system'),
  }, null, 2);
  fs.writeFileSync(filePath, sessionData, 'utf-8');
  process.stdout.write(`${Style.success(' ✔')} Session saved to ${Style.accent(filename)}\n\n`);
}

function loadSession(filePath: string): { messages: Message[]; provider: string; model: string } | null {
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) { process.stdout.write(Style.error(` ✖ File not found: ${filePath}\n`)); return null; }
    const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    if (!raw.messages || !Array.isArray(raw.messages)) { process.stdout.write(Style.error(' ✖ Invalid session file.\n')); return null; }
    return { messages: raw.messages, provider: raw.provider || 'gemini', model: raw.model || 'gemini-2.5-pro' };
  } catch (err: any) { process.stdout.write(Style.error(` ✖ Error loading session: ${err.message}\n`)); return null; }
}

function listSessions(): { files: string[]; dir: string } {
  const dir = process.cwd();
  const files = fs.readdirSync(dir).filter(f => f.startsWith('sentinel-session-') && f.endsWith('.json')).sort().reverse();
  return { files, dir };
}

function exportSessionToMarkdown(messages: Message[], currentProvider: string, currentModel: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `sentinel-session-${timestamp}.md`;
  const filePath = path.join(process.cwd(), filename);
  const content = messages.filter(m => m.role !== 'system').map(m => {
    const role = m.role === 'user' ? '**User**' : m.role === 'assistant' ? '**Sentinel**' : `**[Tool: ${m.name}]**`;
    return `### ${role}\n${m.content}\n`;
  }).join('\n---\n\n');
  const header = `# Sentinel Session\n> ${currentProvider} / ${currentModel}\n> ${new Date().toLocaleString()}\n\n---\n\n`;
  fs.writeFileSync(filePath, header + content, 'utf-8');
  process.stdout.write(`${Style.success(' ✔')} Session exported to ${Style.accent(filename)}\n\n`);
}

// ─── Stats ───────────────────────────────────────────────────────────────
function showStats(messages: Message[], currentProvider: string, currentModel: string, planningMode: PlanningMode, continuity: TaskContinuityTracker) {
  const msgCount = messages.filter(m => m.role !== 'system').length;
  const userMsgs = messages.filter(m => m.role === 'user').length;
  const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
  const toolMsgs = messages.filter(m => m.role === 'tool').length;
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const approx = Math.round(totalChars / 4);
  const costSummary = getCostSummary(currentModel);
  const undoCount = getUndoCount();
  const body = buildPanel('Session Stats', [
    `${Style.dim('Provider:')}   ${Style.accent(currentProvider)}`,
    `${Style.dim('Model:')}      ${Style.accent(currentModel)}`,
    `${Style.dim('Messages:')}   ${Style.accent(String(msgCount))}${Style.dim(` (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool)`)}`,
    `${Style.dim('Context:')}    ${Style.accent(`~${approx.toLocaleString()} tokens`)}${Style.dim(` (${(totalChars / 1024).toFixed(1)} KB)`)}`,
    `${Style.dim('Usage:')}      ${Style.accent(costSummary)}`,
    `${Style.dim('Undo:')}       ${Style.accent(String(undoCount))}${Style.dim(' operations available')}`,
    `${Style.dim('Planning:')}   ${Style.accent(planningMode)}`,
    `${Style.dim('Mode:')}       ${Style.accent(continuity.getMode())}`,
    `${Style.dim('Focus:')}      ${Style.accent(String(continuity.getFocusedFiles().length))}${Style.dim(' tracked files')}`,
  ]);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('\n');
}

function showTools() {
  const items: string[] = [];
  for (const tool of tools) {
    const icon = tool.requiresConfirmation ? Style.warning('⚠') : Style.icon('◈');
    items.push(`${icon} ${Style.accent(tool.name)}${Style.dim(` — ${tool.description.slice(0, 60)}...`)}`);
  }
  const body = buildPanel('Available Tools', items);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('\n');
}

// ─── Model Selection ─────────────────────────────────────────────────────
async function chooseModel(config: ReturnType<typeof loadConfig>) {
  const selected: any = await safePrompt(() => search({
    message: 'Select Model (type to search)',
    source: async (term) => {
      const customProviders = getCustomProviders();
      const customEntries = customProviders.map((p: CustomProviderEntry) => ({
        name: chalk.bold(p.name) + chalk.dim(` - ${p.model} @ ${p.baseUrl}`),
        value: { provider: p.name, model: p.model }
      }));
      const all: any[] = [...AVAILABLE_MODELS];
      if (customEntries.length > 0) {
        all.push(new Separator(chalk.dim('--- Custom Providers ---')));
        all.push(...customEntries);
      }
      if (!term) return all;
      const lowered = term.toLowerCase();
      return all.filter(m =>
        !(m instanceof Separator) && ((m as any).value.model.toLowerCase().includes(lowered) || (m as any).value.provider.toLowerCase().includes(lowered))
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
  config.DEFAULT_PROVIDER = newProvider as any;
  // For custom providers, the model is stored in the entry itself — save just the provider name
  const isCustom = getCustomProviders().some(p => p.name === newProvider);
  if (!isCustom) {
    const providerModelKey = `${newProvider.toUpperCase()}_MODEL`;
    (config as any)[providerModelKey] = newModel;
    saveConfig({ [providerModelKey]: newModel, DEFAULT_PROVIDER: newProvider as any } as any);
  } else {
    saveConfig({ DEFAULT_PROVIDER: newProvider as any } as any);
  }
  return { provider: newProvider, model: newModel };
}

// ─── Configure Model Parameters ──────────────────────────────────────────
interface ModelParams {
  temperature: number;
  topP: number;
  maxTokens: number;
}

const defaultParams: ModelParams = { temperature: 0.7, topP: 0.95, maxTokens: 8192 };

function getModelParams(config: any): ModelParams {
  return {
    temperature: config.TEMPERATURE ?? defaultParams.temperature,
    topP: config.TOP_P ?? defaultParams.topP,
    maxTokens: config.MAX_TOKENS ?? defaultParams.maxTokens,
  };
}

async function showConfigMenu(config: ReturnType<typeof loadConfig>) {
  const params = getModelParams(config);
  const items = [
    `${Style.dim('temperature:')} ${Style.accent(String(params.temperature))}  ${Style.dim('(/config temperature 0.7)')}`,
    `${Style.dim('top_p:')}       ${Style.accent(String(params.topP))}  ${Style.dim('(/config top_p 0.95)')}`,
    `${Style.dim('max_tokens:')}  ${Style.accent(String(params.maxTokens))}  ${Style.dim('(/config max_tokens 4096)')}`,
  ];
  const body = buildPanel('Model Configuration', items);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('\n');
}

async function setModelParam(config: ReturnType<typeof loadConfig>, key: string, value: string) {
  const update: any = {};
  const num = parseFloat(value);
  switch (key) {
    case 'temperature':
      if (isNaN(num) || num < 0 || num > 2) { process.stdout.write(Style.error(' ✖ temperature must be 0-2\n')); return; }
      update.TEMPERATURE = num;
      break;
    case 'top_p':
      if (isNaN(num) || num < 0 || num > 1) { process.stdout.write(Style.error(' ✖ top_p must be 0-1\n')); return; }
      update.TOP_P = num;
      break;
    case 'max_tokens':
      const n = parseInt(value);
      if (isNaN(n) || n < 64 || n > 100000) { process.stdout.write(Style.error(' ✖ max_tokens must be 64-100000\n')); return; }
      update.MAX_TOKENS = n;
      break;
    default: process.stdout.write(Style.error(` ✖ Unknown param: ${key}\n`)); return;
  }
  saveConfig(update);
  process.stdout.write(`${Style.success(' ✔')} Set ${Style.accent(key)} = ${Style.accent(value)}\n\n`);
}

// ─── Planning ────────────────────────────────────────────────────────────
async function maybeRunPlanning(provider: AIProvider, messages: Message[], taskInput: string, planningMode: PlanningMode, memory: HarnessMemory) {
  const io = createTerminalTurnIO();
  const shouldPlan = planningMode === 'on' || (planningMode === 'auto' && isHeavyTask(taskInput));
  if (!shouldPlan) return true;
  const accepted = planningMode === 'on' ? true : await confirmYesNo('Heavy task detected. Start with a plan first?', true);
  if (!accepted) return true;
  const plan = await runPlanningPass(provider, messages, taskInput);
  if (plan.trim()) { await io.showPlan(plan); memory.addSummary('plan', plan); }
  return confirmYesNo('Proceed with execution now?', true);
}

// ─── Turn Execution ──────────────────────────────────────────────────────
async function runPromptTurn(provider: AIProvider, messages: Message[], taskInput: string, memory: HarnessMemory, continuity: TaskContinuityTracker, toolResultCache: Map<string, string>) {
  const prepared = await prepareExecutionTurn(taskInput, memory, continuity);
  messages.push({ role: 'user', content: prepared.executionInput });
  return executeHarnessTurn({
    provider, taskInput, messages, memory, continuity, tools, toolResultCache,
    io: createTerminalTurnIO(), confirmTool, autoLoadedPathSet: prepared.autoLoadedPathSet,
  });
}

// ─── Init Command ────────────────────────────────────────────────────────
// Scans the project and has the AI generate a compact SENTINEL.md project
// memory file (like AGENTS.md). The file is injected into every prompt, so
// it's optimized to be information-dense with a strict context budget.

const INIT_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.cache', '.tmp-dist']);

function collectProjectSignals(): string {
  const parts: string[] = [];
  const cwd = process.cwd();

  // package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    parts.push(`package.json: name=${pkg.name ?? ''} version=${pkg.version ?? ''} description=${pkg.description ?? ''} type=${pkg.type ?? 'commonjs'}`);
    if (pkg.scripts) parts.push(`scripts: ${Object.entries(pkg.scripts).map(([k, v]) => `${k}="${v}"`).join(', ')}`);
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    if (deps.length) parts.push(`dependencies: ${deps.join(', ')}`);
    if (devDeps.length) parts.push(`devDependencies: ${devDeps.join(', ')}`);
  } catch { /* no package.json */ }

  // File tree (2 levels, capped)
  const entries: string[] = [];
  try {
    outer: for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (INIT_IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        entries.push(`${e.name}/`);
        try {
          for (const sub of fs.readdirSync(path.join(cwd, e.name), { withFileTypes: true }).slice(0, 15)) {
            if (INIT_IGNORE_DIRS.has(sub.name) || sub.name.startsWith('.')) continue;
            entries.push(`  ${e.name}/${sub.name}${sub.isDirectory() ? '/' : ''}`);
            if (entries.length >= 80) break outer;
          }
        } catch { /* unreadable dir */ }
      } else {
        entries.push(e.name);
      }
      if (entries.length >= 80) break;
    }
  } catch { /* unreadable cwd */ }
  if (entries.length) parts.push(`files:\n${entries.join('\n')}`);

  // README excerpt
  try {
    for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
      const rp = path.join(cwd, name);
      if (fs.existsSync(rp)) {
        parts.push(`README excerpt:\n${fs.readFileSync(rp, 'utf-8').slice(0, 1200)}`);
        break;
      }
    }
  } catch { /* no readme */ }

  // Notable config files
  const configs = ['tsconfig.json', 'Dockerfile', 'docker-compose.yml', '.env.example', 'wrangler.toml', 'vercel.json', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml'];
  const found = configs.filter(c => fs.existsSync(path.join(cwd, c)));
  if (found.length) parts.push(`config files: ${found.join(', ')}`);

  return parts.join('\n\n');
}

function buildSentinelPrompt(signals: string): string {
  return `You are generating a SENTINEL.md project memory file. This file is injected into an AI coding agent's context on EVERY message, so it MUST be extremely compact and information-dense.

HARD RULES:
- Max 50 lines total. Every line must carry information.
- Use only these sections (omit a section if nothing to say): # Project, ## Stack, ## Commands, ## Conventions, ## Architecture, ## Notes.
- Dense bullet points only. NO paragraphs, NO prose, NO badges, NO images, NO emojis.
- State ONLY facts inferable from the signals below. If unknown, omit — NO placeholders like "(fill in)".
- ## Commands: exact shell commands for dev/build/test/lint, one per bullet (e.g. \`npm run dev\` — start dev server).
- ## Conventions: coding style/rules only if clearly inferable (e.g. ESM modules, TypeScript strict).
- ## Architecture: key directories with a few-word purpose each (max 8 bullets).
- ## Notes: gotchas an agent must know (e.g. "config file is .sentinel.json in cwd").
- Output ONLY the markdown content. NO preamble, NO explanation, NO wrapping code fences.

PROJECT SIGNALS:
${signals}`;
}

function buildFallbackSentinel(signals: string): string {
  const cwdName = path.basename(process.cwd());
  const lines = [`# Project`, `- ${cwdName}`];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    if (pkg.description) lines.push(`- ${pkg.description}`);
    if (pkg.scripts) {
      lines.push('', '## Commands');
      for (const [k, v] of Object.entries(pkg.scripts)) lines.push(`- \`npm run ${k}\` — ${v}`);
    }
  } catch { /* ignore */ }
  lines.push('', '## Notes', '- Add conventions and architecture notes here as the project evolves.');
  return lines.join('\n') + '\n';
}

async function handleInitCommand(config: ReturnType<typeof loadConfig>, providerName: string, modelName: string): Promise<void> {
  const mdPath = path.join(process.cwd(), 'SENTINEL.md');
  if (fs.existsSync(mdPath)) { process.stdout.write(`${Style.warning(' ⚠')} SENTINEL.md already exists.\n\n`); return; }

  const signals = collectProjectSignals();
  let content = '';

  try {
    const provider = ProviderFactory.getProvider(providerName, config, modelName);
    const stop = startSpinner('Scanning project, generating SENTINEL.md...');
    const resp = await provider.sendMessage([{ role: 'user', content: buildSentinelPrompt(signals) }], [], { maxRetries: 1 });
    stop();
    content = (resp.content ?? '').trim();
    // Strip wrapping code fences if the model added them
    content = content.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  } catch (err: any) {
    process.stdout.write(Style.dim(` (AI generation unavailable: ${err?.message ?? 'unknown'} — writing basic file instead)\n`));
  }

  if (!content || content.length < 40) content = buildFallbackSentinel(signals);

  fs.writeFileSync(mdPath, content.endsWith('\n') ? content : content + '\n');
  const lineCount = content.split('\n').length;
  process.stdout.write(`${Style.success(' ✔')} Generated SENTINEL.md ${Style.dim(`(${lineCount} lines — loaded into every prompt as project memory)`)}\n\n`);
}

// ─── Connect Custom Provider ─────────────────────────────────────────────
async function handleConnect(config: ReturnType<typeof loadConfig>, existingName?: string): Promise<{ name: string; model: string } | null> {
  const { input, password } = await import('@inquirer/prompts');

  if (existingName) {
    // Quick-connect with inline args: /connect myname
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

  // Test connection
  process.stdout.write(`\n${Style.dim(' Testing connection...')}\n`);
  const stop = startSpinner('Connecting...');
  const provider = new CustomProvider(entry);
  const testResult = await provider.testConnection();
  stop();

  if (testResult.ok) {
    process.stdout.write(`${Style.success(' ✔')} Connection successful! ${Style.dim(testResult.message)}\n`);
    addCustomProvider({ ...entry, createdAt: new Date().toISOString() });
    process.stdout.write(`\n${Style.success(' ✔')} Provider ${Style.accent(entry.name)} saved to ${Style.dim('.sentinel.json')}\n`);
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

function showProviders() {
  const builtInProviders = [
    { name: 'gemini', desc: 'Google Gemini (requires GEMINI_API_KEY)' },
    { name: 'openrouter', desc: 'OpenRouter multi-model gateway (requires OPENROUTER_API_KEY)' },
  ];

  const items: string[] = [];
  items.push(Style.header('Built-in'));
  for (const p of builtInProviders) {
    items.push(`  ${Style.icon('◈')} ${Style.accent(p.name)} ${Style.dim(p.desc)}`);
  }

  const custom = getCustomProviders();
  if (custom.length > 0) {
    items.push('');
    items.push(Style.header('Custom'));
    for (const p of custom) {
      items.push(`  ${Style.icon('◆')} ${Style.accent(p.name)} ${Style.dim(`→ ${p.model} @ ${p.baseUrl}`)}`);
      items.push(`    ${Style.dim('Key:')} ${Style.dim('•••••' + p.apiKey.slice(-4))}`);
    }
  } else {
    items.push('');
    items.push(Style.dim('  No custom providers configured. Use /connect to add one.'));
  }

  const body = buildPanel('Providers', items);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write(`  ${Style.dim('Use')} ${Style.accent('/connect')} ${Style.dim('to add a custom provider.')}\n`);
  process.stdout.write(`  ${Style.dim('Use')} ${Style.accent('/providers remove <name>')} ${Style.dim('to remove one.')}\n\n`);
}

// ─── Help ────────────────────────────────────────────────────────────────
function showHelp() {
  const items = [
    `${Style.accent('/connect')}   ${Style.body('Connect a custom AI provider')}`,
    `${Style.accent('/providers')} ${Style.body('List and manage connected providers')}`,
    `${Style.accent('/models')}    ${Style.body('Switch AI model and provider')}`,
    `${Style.accent('/tools')}     ${Style.body('List all available agent tools')}`,
    `${Style.accent('/stats')}     ${Style.body('Show session stats & token usage')}`,
    `${Style.accent('/compact')}   ${Style.body('Trim old messages to free context')}`,
    `${Style.accent('/planning')}  ${Style.body('Planning mode (auto|on|off)')}`,
    `${Style.accent('/undo')}     ${Style.body('Undo last file write/edit')}`,
    `${Style.accent('/sandbox')}   ${Style.body('Toggle directory sandbox protection')}`,
    `${Style.accent('/trust')}     ${Style.body('Flow Mode — trust current dir (no write prompts)')}`,
    `${Style.accent('/untrust')}   ${Style.body('Revoke trust for current dir')}`,
    `${Style.accent('/save')}      ${Style.body('Export session to JSON file')}`,
    `${Style.accent('/export')}    ${Style.body('Export session to Markdown file')}`,
    `${Style.accent('/load')}      ${Style.body('Load a saved session')}`,
    `${Style.accent('/config')}    ${Style.body('View/set model parameters')}`,
    `${Style.accent('/init')}      ${Style.body('Generate a SENTINEL.md project file')}`,
    `${Style.accent('/update')}    ${Style.body('Check for and install updates')}`,
    `${Style.accent('/clear')}     ${Style.body('Clear conversation history')}`,
    `${Style.accent('/exit')}      ${Style.body('Close Sentinel')}`,
  ];
  const body = buildPanel('Sentinel Commands', items);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write(`  ${Style.dim('Type ') + Style.accent('@') + Style.dim(' to browse files, Shift+Enter for multi-line input')}\n\n`);
}

// ─── Slash Commands ──────────────────────────────────────────────────────
async function handleSlashCommand(trimmedInput: string, state: {
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
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const kept = nonSystem.slice(-8);
    const removed = nonSystem.length - kept.length;
    messages = [...systemMsgs, ...kept];
    process.stdout.write(`${Style.success(' ✔')} Compacted: removed ${Style.accent(String(removed))} older messages, kept ${Style.accent(String(kept.length))}.\n\n`);
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/stats') { showStats(messages, currentProvider, currentModel, planningMode, state.continuity); return { handled: true, currentProvider, currentModel, planningMode, messages }; }
  if (command === '/tools') { showTools(); return { handled: true, currentProvider, currentModel, planningMode, messages }; }

  if (command === '/save') { saveSession(messages, currentProvider, currentModel); return { handled: true, currentProvider, currentModel, planningMode, messages }; }

  if (command === '/export') { exportSessionToMarkdown(messages, currentProvider, currentModel); return { handled: true, currentProvider, currentModel, planningMode, messages }; }

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
      showProviders();
    }
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  if (command === '/init') { await handleInitCommand(state.config, currentProvider, currentModel); return { handled: true, currentProvider, currentModel, planningMode, messages }; }
  if (command === '/help') { showHelp(); return { handled: true, currentProvider, currentModel, planningMode, messages }; }

  if (command === '/update') {
    await performUpdate();
    return { handled: true, currentProvider, currentModel, planningMode, messages };
  }

  process.stdout.write(`${Style.warning(' ⚠')} Unknown command: ${Style.accent(command)}. ${Style.body('Type')} ${Style.accent('/help')} ${Style.body('for a list.')}\n\n`);
  return { handled: true, currentProvider, currentModel, planningMode, messages };
}

// ─── Main Chat ───────────────────────────────────────────────────────────
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

  // First-run config prompt
  if (isFreshInstall()) {
    process.stdout.write(Style.warning(' ⚠ First run detected \n'));
    process.stdout.write(`  ${Style.dim('Set up your API key with:')} ${Style.accent('sentinel config --gemini <key>')}\n`);
    process.stdout.write(`  ${Style.dim('Or use a custom provider:')} ${Style.accent('/connect')} ${Style.dim('in the chat\n\n')}`);
  }

  // Silent update check
  checkForUpdate().then(({ updateAvailable, latest }) => {
    if (updateAvailable) process.stdout.write(`${Style.warning(' ⚠')} Update available! ${Style.accent(latest ?? '')} is out. Type ${Style.accent('/update')} to install.\n\n`);
  }).catch(() => {});

  const fullSystemPrompt = composeSystemPrompt(projectContext, '--- Project Context (from SENTINEL.md) ---');
  let messages: Message[] = upsertRuntimeIdentityContext(
    [{ role: 'system', content: fullSystemPrompt }], currentProvider, currentModel
  );
  const toolResultCache = new Map<string, string>();

  // Auto-save session to ~/.sentinel/history/ (after messages is initialized)
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

// ─── Commander ───────────────────────────────────────────────────────────
program
  .command('chat')
  .description('Start an interactive chat session')
  .option('-p, --provider <provider>', 'LLM provider (gemini, openrouter)')
  .option('-m, --model <model>', 'Model name to use')
  .action(async (options) => { await startChat(options.provider, options.model); });

program
  .command('run <prompt>')
  .description('Run a one-shot prompt and exit (non-interactive)')
  .option('-p, --provider <provider>', 'LLM provider')
  .option('-m, --model <model>', 'Model name')
  .action(async (prompt, options) => { await runOnce(prompt, options.provider, options.model); });

program
  .command('config')
  .description('Configure settings and API keys (use interactive chat /models for API key setup)')
  .option('-m, --model <model>', 'Set default model')
  .option('--temperature <value>', 'Set temperature (0-2)')
  .option('--top-p <value>', 'Set top_p (0-1)')
  .option('--max-tokens <value>', 'Set max tokens')
  .action((options) => {
    const updates: any = {};
    if (options.model) { updates.GEMINI_MODEL = options.model; process.stdout.write(Style.success(` ✔ Default model set to ${options.model}\n`)); }
    if (options.temperature) {
      const t = parseFloat(options.temperature);
      if (t >= 0 && t <= 2) { updates.TEMPERATURE = t; process.stdout.write(Style.success(` ✔ Temperature set to ${t}\n`)); }
      else { process.stdout.write(Style.error(' ✖ temperature must be 0-2\n')); }
    }
    if (options.topP) {
      const p = parseFloat(options.topP);
      if (p >= 0 && p <= 1) { updates.TOP_P = p; process.stdout.write(Style.success(` ✔ Top_p set to ${p}\n`)); }
      else { process.stdout.write(Style.error(' ✖ top_p must be 0-1\n')); }
    }
    if (options.maxTokens) {
      const m = parseInt(options.maxTokens);
      if (m >= 64 && m <= 100000) { updates.MAX_TOKENS = m; process.stdout.write(Style.success(` ✔ Max tokens set to ${m}\n`)); }
      else { process.stdout.write(Style.error(' ✖ max_tokens must be 64-100000\n')); }
    }
    if (Object.keys(updates).length > 0) saveConfig(updates);
    else {
      process.stdout.write(Style.dim('\n  Security notice: API keys are now stored encrypted at rest.\n'));
      process.stdout.write(Style.dim('  Use the interactive chat (sentinel chat) and /models to set API keys securely.\n'));
      process.stdout.write(Style.dim('  Or set environment variables: GEMINI_API_KEY, OPENROUTER_API_KEY, etc.\n\n'));
    }
  });

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

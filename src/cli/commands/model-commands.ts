import search from '@inquirer/search';
import input from '@inquirer/input';
import { Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import { Style, buildPanel } from '../ui/theme.js';
import { loadConfig, saveConfig, getCustomProviders, type CustomProviderEntry } from '../../config/index.js';
import { ensureApiKey } from '../core/auth.js';

export const AVAILABLE_MODELS = [
  { name: 'Gemini 2.5 Pro (Recommended - High Reasoning)', value: { provider: 'gemini', model: 'gemini-2.5-pro' } },
  { name: 'Gemini 2.5 Flash (Fast & Cost Effective)', value: { provider: 'gemini', model: 'gemini-2.5-flash' } },
  { name: 'Gemini 2.0 Flash (General Purpose)', value: { provider: 'gemini', model: 'gemini-2.0-flash' } },
  { name: 'Claude 3.5 Sonnet (Anthropic)', value: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' } },
  { name: 'Claude 3.5 Haiku (Anthropic - Fast)', value: { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' } },
  { name: 'GPT-4o (OpenAI)', value: { provider: 'openai', model: 'gpt-4o' } },
  { name: 'GPT-4o Mini (OpenAI - Fast)', value: { provider: 'openai', model: 'gpt-4o-mini' } },
  { name: 'o3-mini (OpenAI Reasoning)', value: { provider: 'openai', model: 'o3-mini' } },
  { name: 'DeepSeek Chat (DeepSeek)', value: { provider: 'deepseek', model: 'deepseek-chat' } },
  { name: 'DeepSeek Reasoner (DeepSeek R1)', value: { provider: 'deepseek', model: 'deepseek-reasoner' } },
  { name: 'Ollama (Local LLM - localhost:11434)', value: { provider: 'ollama', model: 'llama3' } },
  { name: 'Custom Model (OpenRouter / OpenAI compatible)', value: { provider: 'openrouter', model: 'custom' } },
];

async function safePrompt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: any) {
    if (err.name === 'ExitPromptError' || err.message?.includes('force closed')) {
      return null;
    }
    throw err;
  }
}

export async function chooseModel(config: ReturnType<typeof loadConfig>) {
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

export function showProviders(currentProvider: string, currentModel: string) {
  const customList = getCustomProviders();
  const builtIn = ['gemini', 'anthropic', 'openai', 'deepseek', 'ollama', 'openrouter'];
  const items = builtIn.map(p => {
    const isCurrent = p === currentProvider;
    const tag = isCurrent ? Style.accent(` ◀ active (${currentModel})`) : '';
    return `${Style.icon('◆')} ${Style.accent(p)}${tag}`;
  });

  if (customList.length > 0) {
    items.push('');
    items.push(Style.dim('Custom Providers:'));
    for (const c of customList) {
      const isCurrent = c.name === currentProvider;
      const tag = isCurrent ? Style.accent(` ◀ active (${c.model})`) : '';
      items.push(`  ${Style.icon('◈')} ${Style.accent(c.name)} ${Style.dim(`(${c.model} @ ${c.baseUrl})`)}${tag}`);
    }
  }

  const body = buildPanel('Providers & Custom Connections', items);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('\n');
}

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

export async function showConfigMenu(config: ReturnType<typeof loadConfig>) {
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

export async function setModelParam(config: ReturnType<typeof loadConfig>, key: string, value: string) {
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

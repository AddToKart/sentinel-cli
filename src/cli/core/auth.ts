import chalk from 'chalk';
import figures from 'figures';
import { password } from '@inquirer/prompts';
import { saveConfig } from '../../config/index.js';
import { Style } from '../ui/theme.js';

export async function safePrompt<T>(promptFn: () => Promise<T>): Promise<T | null> {
  try {
    const result = await promptFn();
    // @inquirer/prompts disables raw mode on exit; re-enable for smartInput
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); }
    return result;
  }
  catch (err: any) {
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); }
    if (err.name === 'ExitPromptError') process.exit(0);
    throw err;
  }
}

export async function ensureApiKey(providerName: string, config: any): Promise<boolean> {
  const keyMap: Record<string, string> = {
    gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY'
  };
  const configKey = keyMap[providerName];
  if (!configKey) return true;
  if (config[configKey]) return true;

  process.stdout.write(Style.warning(`\n ⚠ API Key required for ${providerName.toUpperCase()}\n`));
  const key = await safePrompt(() => password({ message: `Paste your ${providerName.toUpperCase()} API Key:` }));
  if (!key || key.trim().length === 0) {
    process.stdout.write(Style.error(` ✖ No key provided. Operation cancelled.\n`));
    return false;
  }
  config[configKey] = key;
  saveConfig({ [configKey]: key });
  process.stdout.write(Style.success(` ✔ Key saved successfully for future use!\n\n`));
  return true;
}

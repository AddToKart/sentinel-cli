import { Command } from 'commander';
import { saveConfig } from '../config/index.js';
import { Style } from './ui/theme.js';
import { startChat, runOnce } from './chat-runner.js';

export const program = new Command();

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

export { startChat, runOnce };

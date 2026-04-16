import chalk from 'chalk';
import { Separator } from '@inquirer/prompts';

export const AVAILABLE_MODELS = [
  new Separator(chalk.cyan('--- Google Gemini ---')),
  { name: chalk.bold('Gemini 3.1 Pro (Preview)') + chalk.dim(' - Intelligent reasoning'), value: { provider: 'gemini', model: 'gemini-3.1-pro-preview' } },
  { name: chalk.bold('Gemini 3 Flash (Preview)') + chalk.dim(' - Fast & high-performance'), value: { provider: 'gemini', model: 'gemini-3-flash-preview' } },
  { name: chalk.bold('Gemini 3.1 Flash Lite (Preview)') + chalk.dim(' - Cost-efficient'), value: { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' } },
  { name: chalk.bold('Gemini 2.5 Pro'), value: { provider: 'gemini', model: 'gemini-2.5-pro' } },
  { name: chalk.bold('Gemini 2.5 Flash'), value: { provider: 'gemini', model: 'gemini-2.5-flash' } },
  { name: chalk.bold('Gemma 4 Pro (Preview)'), value: { provider: 'gemini', model: 'gemma-4-pro-preview' } },
  { name: chalk.bold('Gemma 2 27B'), value: { provider: 'gemini', model: 'gemma-2-27b' } },
  new Separator(chalk.hex('#1f2937')('--- OpenRouter ---')),
  { name: chalk.bold('Mistral Large 2'), value: { provider: 'openrouter', model: 'mistralai/mistral-large-2407' } },
  { name: chalk.bold('Llama 3.1 405B'), value: { provider: 'openrouter', model: 'meta-llama/llama-3.1-405b-instruct' } },
  { name: chalk.bold('Llama 3.2 90B Vision'), value: { provider: 'openrouter', model: 'meta-llama/llama-3.2-90b-vision-instruct' } },
  { name: chalk.bold('DeepSeek V2.5'), value: { provider: 'openrouter', model: 'deepseek/deepseek-chat' } },
  new Separator(chalk.dim('--- Other ---')),
  { name: chalk.bold('Custom Model') + chalk.dim(' - Enter manually'), value: { provider: 'custom', model: 'custom' } }
];

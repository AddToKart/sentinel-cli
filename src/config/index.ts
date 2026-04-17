import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_HOST: z.string().default('http://localhost:11434'),
  DEFAULT_PROVIDER: z.enum(['gemini', 'openrouter']).default('gemini'),
  GEMINI_MODEL: z.string().default('gemini-1.5-pro'),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  ANTHROPIC_MODEL: z.string().default('claude-3-5-sonnet-latest'),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),
});

export type Config = z.infer<typeof configSchema>;

const CONFIG_PATH = path.join(process.cwd(), '.sentinel.json');

export function loadConfig(): Config {
  let fileConfig: any = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      console.error('Error reading config file:', e);
    }
  }

  // Handle migration
  const oldModel = fileConfig.DEFAULT_MODEL || fileConfig.GEMINI_MODEL;
  if (oldModel && !fileConfig.OPENROUTER_MODEL && (oldModel.includes('/') || oldModel.toLowerCase().includes('free'))) {
    fileConfig.OPENROUTER_MODEL = oldModel;
    fileConfig.DEFAULT_PROVIDER = 'openrouter';
  } else if (oldModel && !fileConfig.GEMINI_MODEL) {
    fileConfig.GEMINI_MODEL = oldModel;
  }
  if (!['gemini', 'openrouter'].includes(fileConfig.DEFAULT_PROVIDER)) {
    fileConfig.DEFAULT_PROVIDER = fileConfig.OPENROUTER_API_KEY ? 'openrouter' : 'gemini';
  }

  return configSchema.parse({
    ...fileConfig,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || fileConfig.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || fileConfig.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || fileConfig.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || fileConfig.OPENROUTER_API_KEY,
  });
}

export function saveConfig(newConfig: Partial<Config>) {
  const currentConfig = loadConfig();
  const merged = { ...currentConfig, ...newConfig };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}

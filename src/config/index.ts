import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { encryptSecret, decryptSecret } from '../cli/core/crypto.js';

dotenv.config();

// ─── Custom Provider Schema ──────────────────────────────────────────────
export const customProviderSchema = z.object({
  name: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(128),
  apiKey: z.string().min(1),
  createdAt: z.string(),
});

export type CustomProviderEntry = z.infer<typeof customProviderSchema>;

const configSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_HOST: z.string().default('http://localhost:11434'),
  DEFAULT_PROVIDER: z.string().default('gemini'),
  GEMINI_MODEL: z.string().default('gemini-1.5-pro'),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  ANTHROPIC_MODEL: z.string().default('claude-3-5-sonnet-latest'),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),
}).passthrough();

export type Config = z.infer<typeof configSchema>;

const CONFIG_PATH = path.join(process.cwd(), '.sentinel.json');

// Fields that contain secrets and should be encrypted at rest
const SECRET_CONFIG_KEYS = new Set([
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
]);

interface RawConfig extends Record<string, unknown> {
  customProviders?: CustomProviderEntry[];
}

// ─── Encryption helpers ──────────────────────────────────────────────────

/**
 * Encrypt all secret fields in the raw config object in-place.
 */
function encryptConfigValues(raw: RawConfig): void {
  for (const key of SECRET_CONFIG_KEYS) {
    const val = raw[key];
    if (typeof val === 'string' && val.length > 0) {
      raw[key] = encryptSecret(val);
    }
  }
  // Encrypt custom provider API keys
  const providers = raw.customProviders;
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (p.apiKey && typeof p.apiKey === 'string' && p.apiKey.length > 0) {
        p.apiKey = encryptSecret(p.apiKey);
      }
    }
  }
}

/**
 * Decrypt all secret fields in a config-like object in-place.
 */
function decryptConfigValues(raw: RawConfig): void {
  for (const key of SECRET_CONFIG_KEYS) {
    const val = raw[key];
    if (typeof val === 'string' && val.length > 0) {
      raw[key] = decryptSecret(val);
    }
  }
  const providers = raw.customProviders;
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (p.apiKey && typeof p.apiKey === 'string' && p.apiKey.length > 0) {
        p.apiKey = decryptSecret(p.apiKey);
      }
    }
  }
}

// ─── Config Loading ──────────────────────────────────────────────────────

export function loadConfig(): Config {
  const raw = loadRawConfig();

  // Decrypt secrets after loading from disk
  decryptConfigValues(raw);

  // Handle migration: preserve custom provider DEFAULT_PROVIDER if it exists
  if (!['gemini', 'openrouter'].includes(raw.DEFAULT_PROVIDER as string)) {
    const customProviders: any[] = (raw.customProviders ?? []);
    const exists = customProviders.some((p: any) => p.name === raw.DEFAULT_PROVIDER);
    if (!exists) {
      raw.DEFAULT_PROVIDER = raw.OPENROUTER_API_KEY ? 'openrouter' : 'gemini';
    }
  }

  // Environment variables override file values (env vars are never encrypted)
  return configSchema.parse({
    ...raw,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || raw.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || raw.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || raw.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || raw.OPENROUTER_API_KEY,
  });
}

function loadRawConfig(): RawConfig {
  let raw: RawConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      console.error('Error reading config file:', e);
    }
  }
  return raw;
}

// ─── Config Saving ────────────────────────────────────────────────────────

export function saveConfig(newConfig: Partial<Config>) {
  const currentConfig = loadRawConfig();
  const merged = { ...currentConfig, ...newConfig };

  // Encrypt secrets before writing to disk
  encryptConfigValues(merged);

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  // Restrict file permissions (best-effort on Windows)
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows may not support chmod */ }
}

// ─── Custom Provider Management ──────────────────────────────────────────

export function getCustomProviders(): CustomProviderEntry[] {
  const raw = loadRawConfig();
  const providers = raw.customProviders ?? [];

  // Decrypt API keys in custom provider entries
  const decrypted = providers.map((p: any) => {
    const entry = { ...p };
    if (entry.apiKey && typeof entry.apiKey === 'string') {
      entry.apiKey = decryptSecret(entry.apiKey);
    }
    return entry;
  });

  return decrypted.filter((p: any) => {
    try { return customProviderSchema.parse(p) && true; } catch { return false; }
  });
}

export function addCustomProvider(entry: CustomProviderEntry): void {
  const providers = getCustomProviders();
  const existing = providers.findIndex(p => p.name === entry.name);
  if (existing >= 0) {
    providers[existing] = entry;
  } else {
    providers.push(entry);
  }
  saveConfig({ customProviders: providers } as any);
}

export function removeCustomProvider(name: string): boolean {
  const providers = getCustomProviders();
  const filtered = providers.filter(p => p.name !== name);
  if (filtered.length === providers.length) return false;
  saveConfig({ customProviders: filtered } as any);
  return true;
}

export function getCustomProvider(name: string): CustomProviderEntry | undefined {
  return getCustomProviders().find(p => p.name === name);
}

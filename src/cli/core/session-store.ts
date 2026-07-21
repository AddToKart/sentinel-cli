import fs from 'fs';
import path from 'path';
import os from 'os';
import { getGlobalConfigPath } from '../../config/index.js';

const SENTINEL_DIR = path.join(os.homedir(), '.sentinel');
const HISTORY_DIR = path.join(SENTINEL_DIR, 'history');

function ensureDirs(): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

export interface SessionRecord {
  id: string;
  provider: string;
  model: string;
  startedAt: string;
  lastActiveAt: string;
  messageCount: number;
  cwd: string;
}

/**
 * Auto-save the current session to ~/.sentinel/history/.
 */
export function autoSaveSession(
  provider: string,
  model: string,
  messages: any[],
  sessionId?: string
): string {
  ensureDirs();
  const id = sessionId || `session-${Date.now()}`;
  const filename = `${id}.json`;
  const filePath = path.join(HISTORY_DIR, filename);

  const record: SessionRecord = {
    id,
    provider,
    model,
    startedAt: new Date(sessionId ? 0 : Date.now()).toISOString(),
    lastActiveAt: new Date().toISOString(),
    messageCount: messages.filter((m: any) => m.role !== 'system').length,
    cwd: process.cwd(),
  };

  const data = JSON.stringify({ meta: record, messages }, null, 2);
  fs.writeFileSync(filePath, data, 'utf-8');
  return id;
}

/**
 * List all saved sessions, sorted by most recent first.
 */
export function listSessions(): SessionRecord[] {
  ensureDirs();
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const sessions: SessionRecord[] = [];
    for (const file of files.slice(0, 20)) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf-8'));
        if (raw.meta) sessions.push(raw.meta);
      } catch { /* skip corrupt */ }
    }
    return sessions;
  } catch { return []; }
}

/**
 * Resume a session by ID.
 */
export function loadSession(sessionId: string): { meta: SessionRecord; messages: any[] } | null {
  ensureDirs();
  const filePath = path.join(HISTORY_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

/**
 * Get the path to the sentinel config directory.
 */
export function getSentinelDir(): string {
  return SENTINEL_DIR;
}

/**
 * Returns true if no global or local configuration file exists.
 */
export function isFreshInstall(): boolean {
  const globalConfig = getGlobalConfigPath();
  const legacyConfig = path.join(process.cwd(), '.sentinel.json');
  return !fs.existsSync(globalConfig) && !fs.existsSync(legacyConfig);
}

/**
 * Auto-save on a timer — call this periodically.
 * Returns the session ID.
 */
let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let currentSessionId: string | null = null;

export function startAutoSave(provider: string, model: string, getMessages: () => any[], intervalMs: number = 30_000): string {
  const id = `session-${Date.now()}`;
  currentSessionId = id;
  autoSaveSession(provider, model, getMessages(), id);

  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = setInterval(() => {
    if (currentSessionId) {
      try { autoSaveSession(provider, model, getMessages(), currentSessionId); } catch { /* skip */ }
    }
  }, intervalMs);

  return id;
}

export function stopAutoSave(): void {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  currentSessionId = null;
}

export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

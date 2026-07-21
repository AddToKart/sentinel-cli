/**
 * Persistent Memory System for Sentinel CLI
 *
 * Provides disk-backed, cross-session memory that the AI agent can read from
 * and write to. Memories are stored per-project so they don't leak between
 * different codebases.
 *
 * Memory types:
 *   fact       — A factual observation about the project (stack, deps, config)
 *   preference — A user preference or coding convention
 *   pattern    — A recurring code pattern or architectural decision
 *   lesson     — Something learned from a mistake or debugging session
 *   user_note  — Explicit note the user asked the agent to remember
 *
 * Storage: ~/.sentinel/memory/<project-hash>.json
 * Max ~200 entries per project — oldest are pruned first when full.
 *
 * Integration points:
 *   - composeSystemPrompt()  → loads all memories into the system prompt
 *   - injectHarnessContext() → recalls relevant memories per-turn
 *   - After tool call batch  → optionally extract new memories
 *   - Slash commands         → /remember, /forget, /memories
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────

export type MemoryType = 'fact' | 'preference' | 'pattern' | 'lesson' | 'user_note';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  /** Where this memory came from (tool result, user, AI extraction) */
  source: string;
  keywords: string[];
  /** Hash of the project root — ties memory to a specific project */
  projectHash: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  /** Optional time-to-live in milliseconds. After this, the memory is expired. */
  ttl?: number;
}

interface MemoryStore {
  version: number;
  projectPath: string;
  projectHash: string;
  memories: MemoryEntry[];
}

// ─── Constants ────────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(os.homedir(), '.sentinel', 'memory');
const MAX_MEMORIES_PER_PROJECT = 200;
const STORE_VERSION = 1;

// ─── Project Hashing ─────────────────────────────────────────────────────

function getProjectHash(): string {
  const cwd = process.cwd();
  return crypto.createHash('sha256').update(cwd.toLowerCase()).digest('hex').slice(0, 16);
}

function getMemoryFilePath(projectHash: string): string {
  return path.join(MEMORY_DIR, `${projectHash}.json`);
}

// ─── Read / Write ────────────────────────────────────────────────────────

function ensureDir(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadStore(projectHash: string): MemoryStore {
  ensureDir();
  const filePath = getMemoryFilePath(projectHash);
  if (!fs.existsSync(filePath)) {
    return {
      version: STORE_VERSION,
      projectPath: process.cwd(),
      projectHash,
      memories: [],
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.memories)) {
      return raw as MemoryStore;
    }
  } catch {
    // Corrupt file — start fresh
  }
  return {
    version: STORE_VERSION,
    projectPath: process.cwd(),
    projectHash,
    memories: [],
  };
}

function saveStore(store: MemoryStore): void {
  ensureDir();
  const filePath = getMemoryFilePath(store.projectHash);
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort: try direct write
    try { fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8'); } catch {}
  }
}

// ─── Keywords ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'with', 'from', 'this', 'that', 'your', 'have', 'will',
  'into', 'then', 'than', 'was', 'are', 'were', 'been', 'being',
  'have', 'has', 'had', 'does', 'did', 'doing', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'just', 'about', 'because', 'before', 'after', 'while',
  'during', 'through', 'against', 'between', 'under', 'again',
  'further', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'also', 'over', 'any',
]);

const TOKEN_RE = /[a-zA-Z0-9_./\\-]{3,}/g;

function extractKeywords(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE) ?? [];
  const filtered = matches.filter(t => !STOP_WORDS.has(t) && t.length >= 3);
  return [...new Set(filtered)].slice(0, 48);
}

// ─── ID Generation ───────────────────────────────────────────────────────

let idCounter = 0;

function generateId(): string {
  idCounter++;
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `mem_${ts}_${rand}_${idCounter}`;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Allocate a new project. Loads its memory store, prunes expired entries,
 * and returns it. Call this once at startup.
 */
export function initProjectMemory(): { projectHash: string; count: number } {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);
  return { projectHash, count: store.memories.length };
}

/**
 * Remember something — add a new memory entry.
 * Returns the generated ID on success, or null if it would be a duplicate.
 */
export function remember(
  type: MemoryType,
  content: string,
  source: string,
  keywords?: string[],
  ttl?: number
): string | null {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);

  // Deduplication: skip near-identical content (simple overlap check)
  const normalized = content.toLowerCase().trim();
  const isDuplicate = store.memories.some(m => {
    const mNorm = m.content.toLowerCase().trim();
    const longer = normalized.length >= mNorm.length ? normalized : mNorm;
    const shorter = normalized.length >= mNorm.length ? mNorm : normalized;
    return longer.length > 20 && longer.includes(shorter);
  });
  if (isDuplicate) return null;

  const id = generateId();
  const entry: MemoryEntry = {
    id,
    type,
    content: content.trim(),
    source,
    keywords: keywords ?? extractKeywords(content),
    projectHash,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    ...(ttl !== undefined ? { ttl } : {}),
  };

  store.memories.push(entry);

  // Prune if over limit
  if (store.memories.length > MAX_MEMORIES_PER_PROJECT) {
    // Sort by updatedAt ascending (oldest first), remove extras
    store.memories.sort((a, b) => a.updatedAt - b.updatedAt);
    store.memories = store.memories.slice(store.memories.length - MAX_MEMORIES_PER_PROJECT);
  }

  saveStore(store);
  return id;
}

/**
 * Forget a specific memory by ID.
 */
export function forget(memoryId: string): boolean {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);
  const idx = store.memories.findIndex(m => m.id === memoryId);
  if (idx === -1) return false;
  store.memories.splice(idx, 1);
  saveStore(store);
  return true;
}

/**
 * Recall memories relevant to a query string.
 * Uses keyword overlap + recency scoring.
 */
export function recall(query: string, limit: number = 6): MemoryEntry[] {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);
  const now = Date.now();

  // Prune expired entries
  const before = store.memories.length;
  store.memories = store.memories.filter(m => !m.ttl || (now - m.createdAt) < m.ttl);
  if (store.memories.length !== before) saveStore(store);

  if (store.memories.length === 0) return [];

  const qk = extractKeywords(query);
  if (qk.length === 0) {
    // No keywords to match — return most recent
    return store.memories.slice(-limit).reverse();
  }

  const scored = store.memories.map(m => {
    let score = 0;
    // Keyword overlap
    for (const k of qk) {
      if (m.keywords.includes(k)) score += 2;
    }
    // Content substring match (weighted less)
    if (qk.some(k => m.content.toLowerCase().includes(k))) score += 1;
    // Source match
    if (qk.some(k => m.source.toLowerCase().includes(k))) score += 1;
    // Recency bonus: +3 for entries < 5 min old, decaying to 0 after ~1 hour
    const age = now - m.createdAt;
    if (age < 5 * 60 * 1000) score += 3;
    else if (age < 15 * 60 * 1000) score += 2;
    else if (age < 60 * 60 * 1000) score += 1;
    // Access count bonus (frequently accessed = important)
    score += Math.min(m.accessCount, 5);
    return { entry: m, score };
  });

  const results = scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => {
      x.entry.accessCount++;
      return x.entry;
    });

  // Persist updated access counts
  saveStore(store);

  return results;
}

/**
 * List all memories for the current project, sorted by most recent first.
 */
export function listMemories(types?: MemoryType[]): MemoryEntry[] {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);
  const now = Date.now();

  // Prune expired on list
  store.memories = store.memories.filter(m => !m.ttl || (now - m.createdAt) < m.ttl);
  saveStore(store);

  let result = store.memories;
  if (types && types.length > 0) {
    result = result.filter(m => types.includes(m.type));
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Build a compact context block for injection into system prompt.
 * Includes the most important memories (by recency and access count).
 */
export function buildMemoryContextBlock(maxMemories: number = 12): string {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);

  if (store.memories.length === 0) return '';

  // Score by (recency + accessCount) and take the top N
  const now = Date.now();
  const scored = store.memories.map(m => {
    const recencyScore = Math.max(0, 3 - (now - m.updatedAt) / (7 * 24 * 60 * 60 * 1000));
    const accessScore = Math.min(m.accessCount, 10) / 2;
    return { entry: m, score: recencyScore + accessScore };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMemories)
    .map(x => x.entry);

  if (top.length === 0) return '';

  const lines: string[] = [
    '═══ PERSISTENT PROJECT MEMORY ═══',
    '(These memories persist across sessions. They were learned or explicitly set.)',
    '',
  ];

  for (const m of top) {
    const icon = typeIcon(m.type);
    const age = formatAge(now - m.updatedAt);
    lines.push(`${icon} [${m.type}] ${m.content} ${age}`);
  }

  lines.push('', '═══ END PERSISTENT MEMORY ═══');
  return lines.join('\n');
}

/**
 * Extract potential memory from a tool result.
 * Returns null if the result doesn't seem memory-worthy.
 * Call this after significant tool operations.
 */
export function extractMemoryFromToolResult(toolName: string, args: any, result: string): { type: MemoryType; content: string; keywords: string[] } | null {
  // Only extract from operations that produced meaningful results
  if (!result || result.length < 20) return null;
  if (result.startsWith('Error:') || result.startsWith('Blocked:')) return null;

  const content = result.slice(0, 300).trim();

  // Pattern: successful build/test output
  if (toolName === 'execute_shell') {
    const command = String(args?.command ?? '');
    if (/\b(npm run build|tsc|make)\b/.test(command) && result.includes('exit 0')) {
      return {
        type: 'pattern',
        content: `Build command "${command}" completed successfully`,
        keywords: extractKeywords(`build success ${command}`),
      };
    }
    if (/\b(test|jest|vitest|mocha)\b/.test(command) && /\b(PASS|passed|Tests:.*passed)\b/i.test(result)) {
      return {
        type: 'pattern',
        content: `Test command "${command}" passed`,
        keywords: extractKeywords(`test pass ${command}`),
      };
    }
  }

  // Pattern: file creation
  if (toolName === 'write_file' && result.startsWith('Created ')) {
    const filePath = String(args?.path ?? '');
    if (!filePath.includes('node_modules') && !filePath.includes('.git')) {
      return {
        type: 'fact',
        content: `Created file: ${filePath}`,
        keywords: extractKeywords(`created file ${filePath}`),
      };
    }
  }

  return null;
}

/**
 * Check if a memory with similar content already exists.
 */
export function hasMemory(content: string): boolean {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);
  const normalized = content.toLowerCase().trim();
  return store.memories.some(m => {
    const mNorm = m.content.toLowerCase().trim();
    return mNorm.includes(normalized) || normalized.includes(mNorm);
  });
}

/**
 * Get a compact summary of memory stats.
 */
export function getMemoryStats(): { count: number; types: Record<string, number>; oldest: string; newest: string } {
  const projectHash = getProjectHash();
  const store = loadStore(projectHash);
  const types: Record<string, number> = { fact: 0, preference: 0, pattern: 0, lesson: 0, user_note: 0 };
  for (const m of store.memories) {
    types[m.type] = (types[m.type] ?? 0) + 1;
  }
  const sorted = [...store.memories].sort((a, b) => a.createdAt - b.createdAt);
  return {
    count: store.memories.length,
    types,
    oldest: sorted.length > 0 ? new Date(sorted[0]!.createdAt).toISOString() : 'never',
    newest: sorted.length > 0 ? new Date(sorted[sorted.length - 1]!.createdAt).toISOString() : 'never',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function typeIcon(type: MemoryType): string {
  switch (type) {
    case 'fact': return '📌';
    case 'preference': return '⭐';
    case 'pattern': return '🔄';
    case 'lesson': return '💡';
    case 'user_note': return '📝';
    default: return '•';
  }
}

function formatAge(ms: number): string {
  if (ms < 60_000) return '(moments ago)';
  if (ms < 3_600_000) return `(${Math.floor(ms / 60_000)}m ago)`;
  if (ms < 86_400_000) return `(${Math.floor(ms / 3_600_000)}h ago)`;
  return `(${Math.floor(ms / 86_400_000)}d ago)`;
}

import fs from 'fs';
import path from 'path';
import { ProviderResponse } from '../../providers/types.js';

type MemoryKind = 'tool' | 'summary';

interface MemoryItem {
  kind: MemoryKind;
  source: string;
  content: string;
  keywords: string[];
  ts: number;
}

const HEAVY_TASK_RE = /\b(refactor|rewrite|redesign|migrate|overhaul|implement|build|architecture|code split|codesplit|multi[- ]step|end[- ]to[- ]end|optimi[sz]e|fix all|add feature)\b/i;
const QUESTION_RE = /^\s*(what|why|how|can|is|are|do|does|did)\b/i;
const LOW_CONFIDENCE_RE = /\b(not sure|unsure|maybe|probably|i think|might|can't|cannot|unknown)\b/i;
const TOKEN_RE = /[a-zA-Z0-9_./\\-]{3,}/g;
const AT_MENTION_RE = /(?:^|\s)@([^\s]+)/g;
const BARE_FILE_RE = /(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|py|html|css|json|md|txt|sh|yaml|yml|go|rs|java|c|cpp|h|env|toml|sql))\b/gi;
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const RESIDUAL_SGR_RE = /\[[0-9;]*m/g;

const FOLLOWUP_RE = /^(yes|yeah|yep|ok|okay|sure|do it|go ahead|continue|proceed|same|that|this|please|yup|fine)\b/i;
const CREATE_RE = /\b(create|new|from scratch|start over|generate|brand new|new page|new file|new component)\b/i;
const REDESIGN_RE = /\b(redesign|revamp|improve|enhance|refactor|polish|update|modify|edit|tweak|rework)\b/i;

function extractKeywords(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE) ?? [];
  const filtered = matches.filter(t => !['the', 'and', 'with', 'from', 'this', 'that', 'your', 'have', 'will', 'into', 'then'].includes(t));
  return [...new Set(filtered)].slice(0, 48);
}

function normalizeFilePath(filePath: string): string {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return path.normalize(fullPath).toLowerCase();
}

function sanitizeMentionToken(token: string): string {
  return token
    .replace(ANSI_SGR_RE, '')
    .replace(RESIDUAL_SGR_RE, '')
    .replace(/^\d+m(?=[\w./\\-])/, '')
    .replace(/^@+/, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function extractMentionedFiles(input: string): string[] {
  const found: string[] = [];
  let atMatch;
  while ((atMatch = AT_MENTION_RE.exec(input)) !== null) {
    const raw = sanitizeMentionToken(String(atMatch[1] ?? ''));
    if (!raw) continue;
    const full = path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      found.push(raw);
    }
  }
  let bareMatch;
  while ((bareMatch = BARE_FILE_RE.exec(input)) !== null) {
    const raw = sanitizeMentionToken(String(bareMatch[1] ?? ''));
    if (!raw) continue;
    found.push(raw);
  }
  return [...new Set(found)];
}

export class HarnessMemory {
  private items: MemoryItem[] = [];
  constructor(private readonly maxItems: number = 24) {}

  addToolResult(toolName: string, args: any, result: string) {
    const argPath = args?.path ? ` ${String(args.path)}` : '';
    this.add('tool', `${toolName}${argPath}`, result);
  }

  addSummary(label: string, content: string) {
    this.add('summary', label, content);
  }

  retrieve(query: string, limit: number = 3): MemoryItem[] {
    const qk = extractKeywords(query);
    if (qk.length === 0) return this.items.slice(-limit).reverse();
    const scored = this.items.map(item => {
      let score = 0;
      for (const k of qk) if (item.keywords.includes(k)) score += 2;
      if (qk.some(k => item.source.toLowerCase().includes(k))) score += 3;
      score += Math.max(0, 3 - Math.floor((Date.now() - item.ts) / 120000));
      return { item, score };
    });
    return scored
      .filter(x => x.score > 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.item);
  }

  private add(kind: MemoryKind, source: string, content: string) {
    const trimmed = content.length > 900 ? content.slice(0, 900) + '\n...[truncated by harness memory]' : content;
    this.items.push({ kind, source, content: trimmed, keywords: extractKeywords(`${source} ${trimmed}`), ts: Date.now() });
    if (this.items.length > this.maxItems) {
      this.items = this.items.slice(this.items.length - this.maxItems);
    }
  }
}

export type ContinuityMode = 'general' | 'redesign' | 'create';

export class TaskContinuityTracker {
  private activeObjective = '';
  private mode: ContinuityMode = 'general';
  private focusedFiles: string[] = [];
  private explicitTurnFiles: string[] = [];
  private followupTurn = false;
  private turnAllowsCreate = false;
  private readonly maxFocusedFiles = 8;

  reset() {
    this.activeObjective = '';
    this.mode = 'general';
    this.focusedFiles = [];
    this.explicitTurnFiles = [];
    this.followupTurn = false;
    this.turnAllowsCreate = false;
  }

  onUserInput(input: string) {
    const text = input.trim();
    if (!text) return;

    this.explicitTurnFiles = extractMentionedFiles(text).map(p => normalizeFilePath(p));
    this.followupTurn = this.isFollowup(text);
    this.turnAllowsCreate = CREATE_RE.test(text);
    const redesignIntent = REDESIGN_RE.test(text);

    if (!this.followupTurn || !this.activeObjective) {
      this.activeObjective = text;
    }

    if (redesignIntent && !this.turnAllowsCreate) {
      this.mode = 'redesign';
    } else if (this.turnAllowsCreate && !redesignIntent) {
      this.mode = 'create';
    } else if (!this.followupTurn && /\b(fix|update|modify|edit|improve|enhance|redesign)\b/i.test(text)) {
      this.mode = 'redesign';
    } else if (!this.followupTurn && /\b(new task|different task|switch task|change task)\b/i.test(text)) {
      this.mode = 'general';
    }

    for (const filePath of extractMentionedFiles(text)) {
      this.addFocusedFile(filePath);
    }
  }

  setExplicitTurnFiles(files: string[]) {
    this.explicitTurnFiles = files.map(p => normalizeFilePath(p));
    for (const filePath of files) {
      this.addFocusedFile(filePath);
    }
  }

  onToolResult(toolName: string, args: any, result: string) {
    if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'read_file') return;
    if (typeof args?.path !== 'string') return;
    if (String(result).startsWith('Error:')) return;
    this.addFocusedFile(args.path);
  }

  getMode(): ContinuityMode {
    return this.mode;
  }

  getFocusedFiles(): string[] {
    return this.focusedFiles.slice();
  }

  getExplicitTurnFiles(): string[] {
    return this.explicitTurnFiles.slice();
  }

  buildHints(): string[] {
    const hints: string[] = [];
    if (this.followupTurn && this.activeObjective) {
      hints.push(`This is a follow-up turn. Continue the active objective unless the user explicitly changes it: ${truncate(this.activeObjective, 160)}`);
    }
    if (this.mode === 'redesign') {
      hints.push('Current work mode is redesign: modify existing files first, avoid creating unrelated new files.');
    }
    if (this.focusedFiles.length > 0) {
      const focusList = this.focusedFiles.slice(-4).join(', ');
      hints.push(`Prefer these focused files: ${focusList}`);
    }
    return hints;
  }

  buildContextBlock(): string {
    if (!this.activeObjective && this.focusedFiles.length === 0) return '';
    const focusList = this.focusedFiles.length > 0 ? this.focusedFiles.slice(-5).join(', ') : '(none yet)';
    return [
      'Task continuity lock:',
      `- Active objective: ${truncate(this.activeObjective || '(none)', 220)}`,
      `- Work mode: ${this.mode}`,
      `- Focus files: ${focusList}`,
      '- Keep working on this objective until the user explicitly changes direction.',
      '- In redesign mode, stay on focus files and avoid creating new files unless explicitly requested.',
    ].join('\n');
  }

  validateToolCall(call: { name: string; args: any }): string | null {
    if (call.name !== 'write_file' && call.name !== 'edit_file' && call.name !== 'read_file') return null;
    const filePath = call.args?.path;
    if (typeof filePath !== 'string' || !filePath.trim()) return null;
    const normalizedPath = normalizeFilePath(filePath);
    const isFocused = this.focusedFiles.includes(normalizedPath);
    const fileExists = fs.existsSync(normalizedPath);

    if (this.explicitTurnFiles.length > 0 && !this.explicitTurnFiles.includes(normalizedPath)) {
      const preferred = this.explicitTurnFiles[this.explicitTurnFiles.length - 1] ?? this.explicitTurnFiles[0];
      return `Continuity policy: this turn explicitly targets mentioned files only. Use "${preferred}" unless the user asks to switch files.`;
    }

    if (call.name === 'write_file' && this.mode === 'redesign' && !this.turnAllowsCreate && !fileExists) {
      return `Continuity policy: redesign mode is active, but "${filePath}" does not exist. Edit an existing focused file unless user explicitly asks for a new file.`;
    }

    if (this.followupTurn && this.mode === 'redesign' && this.focusedFiles.length > 0 && !isFocused) {
      const preferred = this.focusedFiles[this.focusedFiles.length - 1];
      return `Continuity policy: this follow-up should stay on focused redesign targets. Use "${preferred}" (or another focused file) unless the user asks to switch files.`;
    }

    return null;
  }

  private isFollowup(text: string): boolean {
    const short = text.length <= 100;
    if (short && FOLLOWUP_RE.test(text)) return true;
    if (short && /^\s*(and|also|plus)\b/i.test(text)) return true;
    return false;
  }

  private addFocusedFile(filePath: string) {
    const normalized = normalizeFilePath(filePath);
    this.focusedFiles = this.focusedFiles.filter(p => p !== normalized);
    this.focusedFiles.push(normalized);
    if (this.focusedFiles.length > this.maxFocusedFiles) {
      this.focusedFiles = this.focusedFiles.slice(this.focusedFiles.length - this.maxFocusedFiles);
    }
  }
}

export function isHeavyTask(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (QUESTION_RE.test(text) && text.length < 120) return false;
  const longPrompt = text.length > 240;
  const multiClause = (text.match(/\b(and|then|also|plus|after|before)\b/gi)?.length ?? 0) >= 2;
  return HEAVY_TASK_RE.test(text) || longPrompt || multiClause;
}

export function buildPlanningRequest(userInput: string): string {
  return [
    'Planning mode (harness-enforced): produce a concise execution plan before implementing.',
    'Return sections exactly as:',
    '1) Scope',
    '2) Plan',
    '3) Risks',
    '4) First action',
    'Keep it actionable and specific to the repo.',
    '',
    `Task: ${userInput}`
  ].join('\n');
}

export function buildPolicyHints(userInput: string): string[] {
  const hints: string[] = [];
  if (/\b(refactor|edit|modify|change|update|fix|redesign)\b/i.test(userInput)) {
    hints.push('Before modifying existing files, prefer read_file to gather exact current content.');
  }
  if (/\b(search|find|where|locate|grep)\b/i.test(userInput)) {
    hints.push('Use grep/glob first for discovery, then read_file for concrete edits.');
  }
  if (/https?:\/\//i.test(userInput) || /\bdocs|documentation|api\b/i.test(userInput)) {
    hints.push('Use web_fetch for external docs before implementing API-specific behavior.');
  }
  if (/\bbuild|test|compile|tsc|npm\b/i.test(userInput)) {
    hints.push('After code changes, run build/tests to verify behavior.');
  }
  return hints;
}

export function buildMemoryContext(userInput: string, memory: HarnessMemory): string {
  const hits = memory.retrieve(userInput, 3);
  if (hits.length === 0) return '';
  return hits.map((h, i) => `- [${i + 1}] ${h.kind}:${h.source}\n${h.content}`).join('\n\n');
}

export function injectHarnessContext(userInput: string, memoryContext: string, policyHints: string[]): string {
  if (!memoryContext && policyHints.length === 0) return userInput;
  const policyBlock = policyHints.length ? `Harness policy hints:\n${policyHints.map(h => `- ${h}`).join('\n')}` : '';
  const memoryBlock = memoryContext ? `Harness memory (relevant prior results):\n${memoryContext}` : '';
  return `${userInput}\n\n---\n${[policyBlock, memoryBlock].filter(Boolean).join('\n\n')}`;
}

export function shouldSelfCritique(response: ProviderResponse, userInput: string): boolean {
  if (!response?.content || response.toolCalls?.length) return false;
  if (response.content.length < 50) return true;
  if (LOW_CONFIDENCE_RE.test(response.content)) return true;
  return /\b(implement|fix|build|refactor|create|update|redesign)\b/i.test(userInput);
}

export function buildSelfCritiquePrompt(userInput: string, previousAnswer: string): string {
  return [
    'Self-critique pass required by harness.',
    'Re-evaluate your prior answer for correctness, missing steps, and concrete actionability.',
    'If uncertain, resolve uncertainty with explicit next action/tool use rather than hedging.',
    'Return only the improved final answer.',
    '',
    `Original task: ${userInput}`,
    '',
    'Previous answer:',
    previousAnswer
  ].join('\n');
}

export function validateToolCall(call: { name: string; args: any }, toolDefs: any[]): string | null {
  const tool = toolDefs.find(t => t.name === call.name);
  if (!tool) return `Tool "${call.name}" is not available.`;
  const required = tool.parameters?.required ?? [];
  for (const key of required) {
    const val = call.args?.[key];
    if (val === undefined || val === null || val === '') {
      return `Tool "${call.name}" missing required argument "${key}".`;
    }
  }
  return null;
}

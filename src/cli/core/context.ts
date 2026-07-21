import fs from 'fs';
import path from 'path';
import { Style } from '../ui/theme.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { buildGitContextBlock } from './git-context.js';
import { buildMemoryContextBlock, initProjectMemory } from './persistent-memory.js';

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const RESIDUAL_SGR_RE = /\[[0-9;]*m/g;

function sanitizeMentionToken(token: string): string {
  return token
    .replace(ANSI_SGR_RE, '')
    .replace(RESIDUAL_SGR_RE, '')
    .replace(/^\d+m(?=[\w./\\-])/, '')
    .replace(/^@+/, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim();
}

function normalizeLoadKey(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}

function stripRefDecorators(ref: string): string {
  return ref.split('#')[0]?.split('?')[0]?.trim() ?? '';
}

function isLikelyLocalRef(ref: string): boolean {
  if (!ref) return false;
  if (/^(?:[a-z]+:)?\/\//i.test(ref)) return false;
  if (ref.startsWith('#') || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('tel:')) return false;
  return true;
}

function resolveLocalReference(baseFilePath: string, ref: string): string | null {
  const cleaned = stripRefDecorators(ref);
  if (!cleaned || !isLikelyLocalRef(cleaned)) return null;
  const fullPath = path.resolve(path.dirname(baseFilePath), cleaned);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
  return fullPath;
}

function extractDirectFileReferences(baseFilePath: string, content: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\b(?:src|href)=["']([^"']+)["']/gi,
    /@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?/gi,
    /\burl\(\s*["']?([^"')\s]+)["']?\s*\)/gi,
    /\bimport\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/gi,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const candidate = resolveLocalReference(baseFilePath, String(match[1] ?? ''));
      if (candidate) refs.add(candidate);
    }
  }
  return [...refs];
}

// ─── SENTINEL.md Memory System ──────────────────────────────────────────
// SENTINEL.md serves as the project's memory and instructions file.
// It can contain:
//   - Project overview and conventions
//   - Coding style rules
//   - Architecture decisions
//   - Recurring patterns the agent should follow
//   - Any notes the user wants the agent to remember across sessions

// Hard budget: SENTINEL.md is injected into every prompt. Cap it so a
// bloated memory file can never eat the model's context window.
const MAX_PROJECT_CONTEXT_CHARS = 6000;

export function readProjectContext(): string {
  const sentinelMdPath = path.join(process.cwd(), 'SENTINEL.md');
  if (!fs.existsSync(sentinelMdPath)) return '';
  try {
    let content = fs.readFileSync(sentinelMdPath, 'utf-8');
    const stats = fs.statSync(sentinelMdPath);
    const fileSize = formatSize(stats.size);
    const lines = content.split('\n').length;

    let truncatedNote = '';
    if (content.length > MAX_PROJECT_CONTEXT_CHARS) {
      content = content.slice(0, MAX_CONTEXT_CHARS_SAFE(content));
      truncatedNote = ` (truncated to ${MAX_PROJECT_CONTEXT_CHARS} chars for context budget)`;
    }

    process.stdout.write(Style.dim(` 🧠 Loaded SENTINEL.md — project memory (${lines} lines, ${fileSize})${truncatedNote}\n`));

    // Build the context block with metadata
    return [
      '═══ PROJECT MEMORY (SENTINEL.md) ═══',
      'The content below is the user\'s persistent project memory and instructions.',
      'It defines conventions, architecture decisions, and rules to follow.',
      'Treat this as authoritative for this project.',
      '',
      content,
      '',
      '═══ END PROJECT MEMORY ═══',
    ].join('\n');
  } catch {
    return '';
  }
}

// Cut at a newline boundary so we never slice a line in half
function MAX_CONTEXT_CHARS_SAFE(content: string): number {
  const cut = content.lastIndexOf('\n', MAX_PROJECT_CONTEXT_CHARS);
  return cut > MAX_PROJECT_CONTEXT_CHARS * 0.8 ? cut : MAX_PROJECT_CONTEXT_CHARS;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Generates a default SENTINEL.md template with common sections.
 */
export function generateSentinelTemplate(): string {
  return `# Sentinel Project Memory

This file serves as persistent memory for the Sentinel CLI agent.
It defines project conventions, architecture, and rules the agent should follow.

## Project
- **Name**:
- **Stack**:
- **Description**:

## Coding Conventions
- Framework/Libraries:
- Testing approach:
- Code style preferences:
- Naming conventions:

## Architecture
- Key directories and their purposes:
- Data flow patterns:
- State management approach:

## Recurring Tasks
- Common commands (build, test, lint):
- Deployment process:
- Database migrations:

## Notes for the Agent
- Any gotchas or important context the agent should always remember.
- Preferred approaches for common modifications.
`;
}

export function composeSystemPrompt(projectContext: string, contextHeader: string): string {
  const gitBlock = buildGitContextBlock();
  const parts = [SYSTEM_PROMPT];
  if (projectContext) parts.push(`\n${contextHeader}\n${projectContext}`);

  // Persistent memory block (cross-session project memories)
  try {
    const memoryBlock = buildMemoryContextBlock(8);
    if (memoryBlock) parts.push(`\n${memoryBlock}`);
  } catch { /* memory unavailable — skip */ }

  if (gitBlock) parts.push(`\n═══ GIT WORKSPACE ═══\n${gitBlock.replace('Git workspace snapshot (auto-detected):', '').trim()}`);

  // Initialize persistent memory store (idempotent)
  try { initProjectMemory(); } catch { /* skip */ }

  return parts.join('\n\n');
}

// ─── Context Injection ──────────────────────────────────────────────────

export interface MentionContextResult {
  content: string;
  loadedFiles: string[];
  anchorFiles: string[];
  relatedFiles: string[];
  workingSetFiles: string[];
}

export async function injectMentionedContextWithMetadata(input: string): Promise<MentionContextResult> {
  const FILE_PATTERN = /(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|py|html|css|json|md|txt|sh|yaml|yml|go|rs|java|c|cpp|h|env|toml|sql))\b/gi;
  const AT_MENTION_PATTERN = /(?:^|\s)@([^\s]+)/g;
  const injections: string[] = [];
  const injected = new Set<string>();
  const loadedFiles: string[] = [];
  const anchorFiles: string[] = [];
  const relatedFiles: string[] = [];

  async function loadRelatedFiles(parentPath: string, content: string) {
    const refs = extractDirectFileReferences(parentPath, content).slice(0, 6);
    for (const refPath of refs) {
      const loadKey = normalizeLoadKey(refPath);
      if (injected.has(loadKey)) continue;
      injected.add(loadKey);
      relatedFiles.push(refPath);
      try {
        const relatedContent = fs.readFileSync(refPath, 'utf-8');
        const relativePath = path.relative(process.cwd(), refPath).replace(/\\/g, '/');
        const ext = path.extname(refPath).slice(1) || 'text';
        process.stdout.write(Style.dim(` 🔗 Linked context: ${relativePath} (${relatedContent.split('\n').length} lines)\n`));
        injections.push(`--- Related File: ${relativePath} ---\n\`\`\`${ext}\n${relatedContent}\n\`\`\`\n---`);
        loadedFiles.push(refPath);
      } catch { /* skip unreadable */ }
    }
  }

  let atMatch;
  while ((atMatch = AT_MENTION_PATTERN.exec(input)) !== null) {
    const mentionedPath = sanitizeMentionToken(String(atMatch[1] ?? ''));
    if (!mentionedPath) continue;
    const fullPath = path.isAbsolute(mentionedPath) ? mentionedPath : path.join(process.cwd(), mentionedPath);
    const loadKey = normalizeLoadKey(fullPath);
    if (injected.has(loadKey)) continue;
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      injected.add(loadKey);
      const { readCodebaseTool } = await import('../../tools/index.js');
      const contents = await readCodebaseTool.execute({ path: mentionedPath });
      process.stdout.write(Style.dim(` 📁 Loading codebase: ${mentionedPath}\n`));
      injections.push(`--- Context from @${mentionedPath} (full codebase) ---\n${contents}\n---`);
    } else if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      injected.add(loadKey);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const ext = path.extname(mentionedPath).slice(1) || 'text';
        process.stdout.write(Style.dim(` 📄 Auto-loaded: ${mentionedPath} (${content.split('\n').length} lines)\n`));
        injections.push(`--- File: ${mentionedPath} ---\n\`\`\`${ext}\n${content}\n\`\`\`\n---`);
        loadedFiles.push(fullPath);
        anchorFiles.push(fullPath);
        await loadRelatedFiles(fullPath, content);
      } catch { /* skip unreadable */ }
    }
  }

  let fileMatch;
  while ((fileMatch = FILE_PATTERN.exec(input)) !== null) {
    const mentionedPath = sanitizeMentionToken(String(fileMatch[1] ?? ''));
    if (!mentionedPath) continue;
    const fullPath = path.isAbsolute(mentionedPath) ? mentionedPath : path.join(process.cwd(), mentionedPath);
    const loadKey = normalizeLoadKey(fullPath);
    if (injected.has(loadKey)) continue;
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      injected.add(loadKey);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const ext = path.extname(mentionedPath).slice(1) || 'text';
        process.stdout.write(Style.dim(` 📄 Auto-loaded: ${mentionedPath} (${content.split('\n').length} lines)\n`));
        injections.push(`--- File: ${mentionedPath} ---\n\`\`\`${ext}\n${content}\n\`\`\`\n---`);
        loadedFiles.push(fullPath);
        anchorFiles.push(fullPath);
        await loadRelatedFiles(fullPath, content);
      } catch { /* skip unreadable */ }
    }
  }

  const workingSetFiles = [...new Set([...anchorFiles, ...relatedFiles])];
  if (injections.length === 0) return { content: input, loadedFiles, anchorFiles, relatedFiles, workingSetFiles };
  return { content: input + '\n\n' + injections.join('\n\n'), loadedFiles, anchorFiles, relatedFiles, workingSetFiles };
}

export async function injectMentionedContext(input: string): Promise<string> {
  const result = await injectMentionedContextWithMetadata(input);
  return result.content;
}

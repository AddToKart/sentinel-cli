import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { COLORS, THEME } from '../ui/theme.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

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

export function readProjectContext(): string {
  const sentinelMdPath = path.join(process.cwd(), 'SENTINEL.md');
  if (!fs.existsSync(sentinelMdPath)) return '';
  try {
    return fs.readFileSync(sentinelMdPath, 'utf-8');
  } catch {
    return '';
  }
}

export function composeSystemPrompt(projectContext: string, contextHeader: string): string {
  return projectContext
    ? `${SYSTEM_PROMPT}\n\n${contextHeader}\n${projectContext}`
    : SYSTEM_PROMPT;
}

export interface MentionContextResult {
  content: string;
  loadedFiles: string[];
}

export async function injectMentionedContextWithMetadata(input: string): Promise<MentionContextResult> {
  const FILE_PATTERN = /(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|py|html|css|json|md|txt|sh|yaml|yml|go|rs|java|c|cpp|h|env|toml|sql))\b/gi;
  const AT_MENTION_PATTERN = /(?:^|\s)@([^\s]+)/g;
  const injections: string[] = [];
  const injected = new Set<string>();
  const loadedFiles: string[] = [];

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
      process.stdout.write(chalk.dim(` 📁 Loading codebase: ${mentionedPath}\n`));
      injections.push(`--- Context from @${mentionedPath} (full codebase) ---\n${contents}\n---`);
    } else if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      injected.add(loadKey);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const ext = path.extname(mentionedPath).slice(1) || 'text';
        process.stdout.write(chalk.dim(` 📄 Auto-loaded: `) + THEME.accent(mentionedPath) + chalk.dim(` (${content.split('\n').length} lines)\n`));
        injections.push(`--- File: ${mentionedPath} ---\n\`\`\`${ext}\n${content}\n\`\`\`\n---`);
        loadedFiles.push(fullPath);
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
        process.stdout.write(chalk.dim(` 📄 Auto-loaded: `) + THEME.accent(mentionedPath) + chalk.dim(` (${content.split('\n').length} lines)\n`));
        injections.push(`--- File: ${mentionedPath} ---\n\`\`\`${ext}\n${content}\n\`\`\`\n---`);
        loadedFiles.push(fullPath);
      } catch { /* skip unreadable */ }
    }
  }

  if (injections.length === 0) return { content: input, loadedFiles };
  return { content: input + '\n\n' + injections.join('\n\n'), loadedFiles };
}

export async function injectMentionedContext(input: string): Promise<string> {
  const result = await injectMentionedContextWithMetadata(input);
  return result.content;
}

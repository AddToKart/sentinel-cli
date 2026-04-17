import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import axios from 'axios';
import chalk from 'chalk';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
  execute: (args: any, context?: ToolExecutionContext) => Promise<string>;
  displayName?: string;
  getLabel?: (args: any) => string;
  requiresConfirmation?: boolean;
  getRiskSummary?: (args: any) => string;
}

export interface ToolOutputChunk {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  onOutput?: (chunk: ToolOutputChunk) => void;
}

export interface ShellSpawnResult extends EventEmitter {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ShellSpawnFactory = (command: string, options: {
  cwd: string;
  shell: boolean;
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
}) => ShellSpawnResult;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function withEol(content: string, eol: '\r\n' | '\n'): string {
  return normalizeNewlines(content).replace(/\n/g, eol);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated at ${maxChars} chars]`;
}

function appendWithLimit(current: string, chunk: string, maxChars: number): string {
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, idx) => `${String(idx + 1).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

function formatCodeBlock(lang: string, content: string): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

function formatToolResult(title: string, sections: Array<{ label: string; content: string }>): string {
  const parts = [title];
  for (const section of sections) {
    parts.push('');
    parts.push(`${section.label}:`);
    parts.push(section.content);
  }
  return parts.join('\n');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Detects AI omission placeholders that would truncate files
const OMISSION_PATTERNS = [
  /\/\/ \.\.\. existing/i, /\/\/ \.\.\. rest/i, /\/\/ \.\.\. previous/i,
  /\[existing code\]/i, /\[rest of (the )?file\]/i, /\[previous code\]/i,
  /# \.\.\. existing/i, /# \.\.\. rest/i,
  /\/\* \.\.\. \*\//,
];
function detectOmission(content: string): string | null {
  for (const pat of OMISSION_PATTERNS) {
    const line = content.split('\n').find(l => pat.test(l));
    if (line) return line.trim();
  }
  return null;
}

function getFileIcon(ext: string): string {
  const icons: Record<string, string> = {
    '.ts': '📘', '.tsx': '📘', '.js': '📒', '.jsx': '📒',
    '.py': '🐍', '.rs': '🦀', '.go': '🐹', '.java': '☕',
    '.css': '🎨', '.html': '🌐', '.json': '📋', '.md': '📝',
    '.yaml': '⚙️', '.yml': '⚙️', '.env': '🔑', '.sh': '⚡',
    '.png': '🖼️', '.jpg': '🖼️', '.svg': '🖼️', '.gif': '🖼️',
  };
  return icons[ext.toLowerCase()] ?? '📄';
}

/** Generate a simple inline diff between old and new content */
export function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const result: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  // Simple unified diff approach
  const maxLen = Math.max(oldLines.length, newLines.length);
  let changed = false;
  let block: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const old = oldLines[i];
    const nw = newLines[i];
    if (old === undefined) {
      block.push(`+ ${nw}`);
      changed = true;
    } else if (nw === undefined) {
      block.push(`- ${old}`);
      changed = true;
    } else if (old !== nw) {
      block.push(`- ${old}`);
      block.push(`+ ${nw}`);
      changed = true;
    } else {
      block.push(`  ${old}`);
    }
  }

  if (!changed) return '(no changes)';
  return result.concat(block).join('\n');
}

// ─── Execute Shell ────────────────────────────────────────────────────────────
export const shellTool: ToolDefinition = {
  name: 'execute_shell',
  displayName: 'Shell',
  description: 'Execute a shell command on the local machine. Use for running scripts, installing packages, compiling code, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      cwd: { type: 'string', description: 'Working directory to run the command from (default: current directory)' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 120000)' },
    },
    required: ['command'],
  },
  requiresConfirmation: true,
  getLabel: ({ command, cwd }) => `${cwd ? `${cwd} ` : ''}$ ${command}`,
  getRiskSummary: ({ command, cwd, timeout_ms }) => {
    const parts = [`Run: ${command}`];
    if (cwd) parts.push(`cwd=${cwd}`);
    if (timeout_ms) parts.push(`timeout=${timeout_ms}ms`);
    return parts.join(' | ');
  },
  async execute({ command, cwd, timeout_ms }, context = {}) {
    const workingDir = cwd ? resolvePath(cwd) : process.cwd();
    if (!fs.existsSync(workingDir)) return `Error: working directory not found: ${cwd}`;
    if (!fs.statSync(workingDir).isDirectory()) return `Error: working directory is not a directory: ${cwd}`;

    const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 30000, 120000));
    return runStreamingShellCommand(command, workingDir, timeout, context);
  },
};

export function runStreamingShellCommand(
  command: string,
  workingDir: string,
  timeout: number,
  context: ToolExecutionContext = {},
  spawnFactory: ShellSpawnFactory = (cmd, options) => spawn(cmd, options)
): Promise<string> {
  const maxCapture = 1024 * 256;

  return new Promise<string>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawnFactory(command, {
      cwd: workingDir,
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (context.signal && abortHandler) {
        context.signal.removeEventListener('abort', abortHandler);
      }
      resolve(result);
    };

    const emitChunk = (stream: 'stdout' | 'stderr', raw: Buffer | string) => {
      const text = String(raw);
      if (stream === 'stdout') {
        stdout = appendWithLimit(stdout, text, maxCapture);
      } else {
        stderr = appendWithLimit(stderr, text, maxCapture);
      }
      context.onOutput?.({ stream, text });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      context.onOutput?.({ stream: 'system', text: `Process timed out after ${timeout}ms.\n` });
      child.kill('SIGTERM');
    }, timeout);

    const abortHandler = () => {
      aborted = true;
      context.onOutput?.({ stream: 'system', text: 'Process cancelled by harness.\n' });
      child.kill('SIGTERM');
    };

    if (context.signal) {
      if (context.signal.aborted) {
        abortHandler();
      } else {
        context.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    child.stdout?.on('data', (chunk) => emitChunk('stdout', chunk));
    child.stderr?.on('data', (chunk) => emitChunk('stderr', chunk));

    child.on('error', (err) => {
      finish(formatToolResult('Shell command failed to start.', [
        { label: 'Command', content: command },
        { label: 'Working directory', content: workingDir },
        { label: 'Error', content: err.message },
      ]));
    });

    child.on('close', (code, signal) => {
      const statusLabel = timedOut
        ? `Shell command timed out after ${timeout}ms.`
        : aborted
          ? 'Shell command cancelled by harness.'
          : code === 0
            ? 'Shell command completed successfully.'
            : `Shell command failed with exit code ${code ?? '?'}${signal ? ` (signal: ${signal})` : ''}.`;

      finish(formatToolResult(statusLabel, [
        { label: 'Command', content: command },
        { label: 'Working directory', content: workingDir },
        { label: 'Stdout', content: formatCodeBlock('text', truncateText(stdout || '(no stdout)', 12000)) },
        { label: 'Stderr', content: formatCodeBlock('text', truncateText(stderr || '(no stderr)', 12000)) },
      ]));
    });
  });
}

// ─── Read File ────────────────────────────────────────────────────────────────
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  displayName: 'Reading',
  description: 'Read the full contents of a file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute)' },
    },
    required: ['path'],
  },
  getLabel: ({ path: p }) => p,
  async execute({ path: filePath }) {
    try {
      const fullPath = resolvePath(filePath);
      if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`;
      const stat = fs.statSync(fullPath);
      if (stat.size > 1024 * 1024) return `File too large (${(stat.size / 1024).toFixed(0)} KB). Use read_codebase for directories.`;
      const content = fs.readFileSync(fullPath, 'utf-8');
      const numbered = addLineNumbers(content);
      return formatToolResult(`Read ${filePath}`, [
        { label: 'Metadata', content: `${content.split('\n').length} lines | ${formatBytes(stat.size)}` },
        { label: 'Contents', content: formatCodeBlock(path.extname(filePath).slice(1) || 'text', numbered) },
      ]);
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  },
};

// ─── Write File ───────────────────────────────────────────────────────────────
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  displayName: 'Writing',
  description: 'Write or overwrite a file. Prefer edit_file for targeted changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to write to' },
      content: { type: 'string', description: 'The full content to write' },
    },
    required: ['path', 'content'],
  },
  requiresConfirmation: true,
  getLabel: ({ path: p }) => p,
  getRiskSummary: ({ path: p, content }) => `Overwrite ${p} with ${content?.split('\n').length ?? 0} lines`,
  async execute({ path: filePath, content }) {
    try {
      const fullPath = resolvePath(filePath);
      // Omission guard
      const omission = detectOmission(content);
      if (omission) {
        return `⚠ Blocked: Content contains an omission placeholder ("${omission}"). Provide the COMPLETE file content without shortcuts.`;
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const existed = fs.existsSync(fullPath);
      const oldContent = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
      if (existed && normalizeNewlines(oldContent) === normalizeNewlines(content)) {
        return `Skipped write_file: ${filePath} already matches the requested content.`;
      }
      const outputContent = existed ? withEol(content, detectEol(oldContent)) : content;
      fs.writeFileSync(fullPath, outputContent, 'utf-8');
      const diff = existed ? generateDiff(oldContent, outputContent, filePath) : '(new file)';
      return `${existed ? 'Updated' : 'Created'} ${filePath}\n${diff}`;
    } catch (err: any) {
      return `Error writing to file: ${err.message}`;
    }
  },
};

// ─── Edit File (Surgical) ─────────────────────────────────────────────────────
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  displayName: 'Editing',
  description: 'Make a targeted find-and-replace edit to an existing file. Safer than write_file for modifying existing code. Use exact strings that appear in the file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique in the file.' },
      new_string: { type: 'string', description: 'The replacement string.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  requiresConfirmation: true,
  getLabel: ({ path: p }) => p,
  getRiskSummary: ({ path: p, old_string, new_string }) =>
    `Edit ${p}: replace "${String(old_string).split('\n')[0]?.slice(0, 40) ?? ''}..." → "${String(new_string).split('\n')[0]?.slice(0, 40) ?? ''}..."`,
  async execute({ path: filePath, old_string, new_string }) {
    try {
      const fullPath = resolvePath(filePath);
      if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`;
      // Omission guard on new_string
      const omission = detectOmission(new_string);
      if (omission) {
        return `⚠ Blocked: new_string contains an omission placeholder ("${omission}"). Provide the complete replacement.`;
      }
      const original = fs.readFileSync(fullPath, 'utf-8');
      const fileEol = detectEol(original);
      if (normalizeNewlines(old_string) === normalizeNewlines(new_string)) {
        return `Skipped edit_file: replacement text is identical for ${filePath}.`;
      }

      const oldCandidates = [old_string, withEol(old_string, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
      const matchedOld = oldCandidates.find(candidate => original.includes(candidate));
      if (!matchedOld) {
        const newCandidates = [new_string, withEol(new_string, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
        if (newCandidates.some(candidate => original.includes(candidate))) {
          return `Skipped edit_file: ${filePath} already has the requested content.`;
        }
        return `Error: old_string not found in ${filePath}. Ensure the string exactly matches the file contents.`;
      }

      const occurrences = original.split(matchedOld).length - 1;
      if (occurrences > 1) return `Error: old_string appears ${occurrences} times in ${filePath}. Provide a more specific string.`;

      const replacement = withEol(new_string, fileEol);
      const updated = original.replace(matchedOld, replacement);
      if (updated === original) return `Skipped edit_file: ${filePath} already has the requested content.`;
      fs.writeFileSync(fullPath, updated, 'utf-8');
      return `Edited ${filePath} successfully.\n${generateDiff(original, updated, filePath)}`;
    } catch (err: any) {
      return `Error editing file: ${err.message}`;
    }
  },
};

// ─── Grep (Search File Contents) ─────────────────────────────────────────────
export const grepTool: ToolDefinition = {
  name: 'grep',
  displayName: 'Searching',
  description: 'Search for a pattern in file contents. Like ripgrep/grep. Returns matching lines with file and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'String or regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in (default: cwd)' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
      include: { type: 'string', description: 'Only search files matching this glob (e.g. "*.ts")' },
    },
    required: ['pattern'],
  },
  getLabel: ({ pattern, path: p }) => `"${pattern}" in ${p || '.'}`,
  async execute({ pattern, path: searchPath = '.', case_insensitive = false, include }: {
    pattern: string; path?: string; case_insensitive?: boolean; include?: string;
  }) {
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);
    const fullRoot = resolvePath(searchPath);
    let regex: RegExp;
    let mode = 'regex';
    try {
      regex = new RegExp(pattern, case_insensitive ? 'gi' : 'g');
    } catch {
      regex = new RegExp(escapeRegex(pattern), case_insensitive ? 'gi' : 'g');
      mode = 'literal';
    }
    const results: string[] = [];
    let fileCount = 0;

    const includeExt = include ? include.replace('*', '').replace('**/', '') : null;

    function walk(dir: string) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
        } else if (entry.isFile()) {
          if (includeExt && !entry.name.endsWith(includeExt)) continue;
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            const relPath = path.relative(fullRoot, fullPath).replace(/\\/g, '/');
            let matched = false;
            lines.forEach((line, idx) => {
              if (regex.test(line)) {
                if (!matched) { results.push(`\n📄 ${relPath}`); matched = true; fileCount++; }
                results.push(`  ${String(idx + 1).padStart(4, ' ')} │ ${line.trim()}`);
              }
              regex.lastIndex = 0;
            });
          } catch { /* skip binary */ }
        }
      }
    }

    try {
      const stat = fs.statSync(fullRoot);
      if (stat.isFile()) {
        const content = fs.readFileSync(fullRoot, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (regex.test(line)) {
            results.push(`  ${String(idx + 1).padStart(4, ' ')} │ ${line.trim()}`);
            regex.lastIndex = 0;
          }
        });
      } else {
        walk(fullRoot);
      }
    } catch (err: any) {
      return `Error: ${err.message}`;
    }

    if (results.length === 0) return `No matches found for "${pattern}"`;
    return formatToolResult(`Found matches in ${fileCount} file(s).`, [
      { label: 'Pattern', content: `${pattern} (${mode}${case_insensitive ? ', case-insensitive' : ''})` },
      { label: 'Results', content: results.join('\n') },
    ]);
  },
};

// ─── Glob (Find Files by Pattern) ─────────────────────────────────────────────
export const globTool: ToolDefinition = {
  name: 'glob',
  displayName: 'Finding files',
  description: 'Find files matching a glob pattern. Examples: "**/*.ts", "src/**/*.test.js", "*.json"',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts")' },
      path: { type: 'string', description: 'Root directory to search from (default: cwd)' },
    },
    required: ['pattern'],
  },
  getLabel: ({ pattern, path: p }) => `${pattern} in ${p || '.'}`,
  async execute({ pattern, path: rootPath = '.' }: { pattern: string; path?: string }) {
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);
    const fullRoot = resolvePath(rootPath);
    const results: string[] = [];

    // Convert glob to regex
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '__DOUBLE__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DOUBLE__/g, '.*')
      .replace(/\?/g, '[^/]');
    const regex = new RegExp(`^${regexStr}$`);

    function walk(dir: string) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(fullRoot, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
        } else if (entry.isFile()) {
          if (regex.test(relPath) || regex.test(entry.name)) {
            const ext = path.extname(entry.name);
            results.push(`${getFileIcon(ext)} ${relPath}`);
          }
        }
      }
    }

    walk(fullRoot);
    if (results.length === 0) return `No files matched pattern: ${pattern}`;
    return `${results.length} file(s) matched:\n${results.join('\n')}`;
  },
};

// ─── Web Fetch ────────────────────────────────────────────────────────────────
export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  displayName: 'Fetching',
  description: 'Fetch the content of a URL. Use to retrieve documentation, API responses, or web pages as context.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
  getLabel: ({ url }) => url,
  async execute({ url }) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Sentinel-CLI/1.0' },
        responseType: 'text',
      });
      const text: string = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
      // Strip excessive HTML tags if it's HTML
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{3,}/g, '\n')
        .trim();
      const truncated = stripped.length > 8000 ? stripped.slice(0, 8000) + '\n\n[...truncated at 8000 chars]' : stripped;
      return truncated;
    } catch (err: any) {
      return `Error fetching ${url}: ${err.message}`;
    }
  },
};

// ─── List Directory ───────────────────────────────────────────────────────────
export const listDirTool: ToolDefinition = {
  name: 'list_directory',
  displayName: 'Listing',
  description: 'List files and directories in a given path. Use to explore project structure.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: current directory)' },
      recursive: { type: 'boolean', description: 'List recursively? Default false.' },
    },
    required: [],
  },
  getLabel: ({ path: p }) => p || '.',
  async execute({ path: dirPath = '.', recursive = false }) {
    const IGNORE = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.DS_Store']);
    const fullPath = resolvePath(dirPath);
    if (!fs.existsSync(fullPath)) return `Directory not found: ${dirPath}`;

    function listRecursive(dir: string, prefix = ''): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines: string[] = [];
      for (const entry of entries) {
        if (IGNORE.has(entry.name)) continue;
        if (entry.isDirectory()) {
          lines.push(`${prefix}📁 ${entry.name}/`);
          if (recursive) lines.push(...listRecursive(path.join(dir, entry.name), prefix + '  '));
        } else {
          lines.push(`${prefix}${getFileIcon(path.extname(entry.name))} ${entry.name}`);
        }
      }
      return lines;
    }

    try {
      const lines = listRecursive(fullPath);
      return formatToolResult(`Listed ${dirPath}`, [
        { label: 'Mode', content: recursive ? 'recursive' : 'top-level only' },
        { label: 'Entries', content: lines.join('\n') || '(empty directory)' },
      ]);
    } catch (err: any) {
      return `Error listing directory: ${err.message}`;
    }
  },
};

// ─── Read Codebase ─────────────────────────────────────────────────────────────
export const readCodebaseTool: ToolDefinition = {
  name: 'read_codebase',
  displayName: 'Loading codebase',
  description: 'Read all source files in a directory recursively. Use for understanding entire project codebases.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Root directory (default: cwd)' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to include.' },
    },
    required: [],
  },
  getLabel: ({ path: p }) => p || '.',
  async execute({ path: dirPath = '.', extensions }: { path?: string; extensions?: string[] }) {
    const DEFAULT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.css', '.html', '.json', '.md', '.yaml', '.yml', '.toml']);
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache']);
    const IGNORE_FILES = new Set(['.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
    const allowedExts = extensions ? new Set(extensions) : DEFAULT_EXTS;
    const fullRoot = resolvePath(dirPath);
    const results: string[] = [];
    let totalSize = 0;
    const MAX_SIZE = 200 * 1024;

    function walk(dir: string) {
      if (totalSize > MAX_SIZE) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (totalSize > MAX_SIZE) break;
        const fullPath2 = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) walk(fullPath2);
        } else if (entry.isFile()) {
          if (IGNORE_FILES.has(entry.name)) continue;
          if (!allowedExts.has(path.extname(entry.name).toLowerCase())) continue;
          try {
            const content = fs.readFileSync(fullPath2, 'utf-8');
            const relPath = path.relative(fullRoot, fullPath2).replace(/\\/g, '/');
            const snippet = `\n${'─'.repeat(60)}\n📄 ${relPath}\n${'─'.repeat(60)}\n${addLineNumbers(content)}`;
            results.push(snippet);
            totalSize += snippet.length;
          } catch { /* skip */ }
        }
      }
    }

    walk(fullRoot);
    if (results.length === 0) return 'No source files found in that directory.';
    return formatToolResult(`Loaded codebase from ${dirPath}`, [
      { label: 'Extensions', content: [...allowedExts].join(', ') },
      { label: 'Contents', content: results.join('\n') + (totalSize > MAX_SIZE ? '\n\n[...codebase truncated at 200KB limit]' : '') },
    ]);
  },
};

// ─── Ask User (mid-task clarification) ─────────────────────────────────────────────
export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  displayName: 'Asking',
  description: 'Ask the user a clarifying question mid-task when you need more information to proceed. Use sparingly — only when genuinely ambiguous.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
    },
    required: ['question'],
  },
  getLabel: ({ question }) => question,
  async execute({ question }) {
    // Print the question visibly
    process.stdout.write('\n' + chalk.cyan('  ? ') + chalk.white.bold(question) + '\n');
    process.stdout.write(chalk.dim('  Your answer: '));
    return new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.once('line', (answer) => { rl.close(); resolve(answer.trim() || '(no answer)'); });
    });
  },
};

export const tools: ToolDefinition[] = [
  shellTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  grepTool,
  globTool,
  webFetchTool,
  listDirTool,
  readCodebaseTool,
  askUserTool,
];

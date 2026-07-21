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

// Check if ripgrep is available on the system
let _rgAvailable: boolean | null = null;
function isRgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable;
  try { require('child_process').execSync('rg --version', { stdio: 'ignore', timeout: 2000 }); _rgAvailable = true; } catch { _rgAvailable = false; }
  return _rgAvailable;
}

// Compact result: skip echoing input params the model already knows
function compactResult(label: string, body: string): string {
  return `${label}\n${body}`;
}

function grepResultCompact(mode: string, pattern: string, body: string): string {
  return `grep(${mode}): "${pattern}"\n${body}`;
}
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

// ─── Security — Sensitive File Patterns ────────────────────────────────────
// Files that should NEVER be written to by write_file or edit_file.
export const SENSITIVE_FILE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /(^|\/|\\)\.env$/i, description: '.env file (secrets)' },
  { pattern: /(^|\/|\\)\.env\.\w+$/i, description: '.env.* file (secrets)' },
  { pattern: /(^|\/|\\)\.git[/\\]/i, description: '.git directory' },
  { pattern: /(^|\/|\\)node_modules[/\\]/i, description: 'node_modules directory' },
  { pattern: /(^|\/|\\)\.ssh[/\\]/i, description: '.ssh directory' },
  { pattern: /(^|\/|\\)\.gnupg[/\\]/i, description: '.gnupg directory' },
  { pattern: /(^|\/|\\)\.config[/\\]?$/i, description: '.config directory' },
  { pattern: /(^|\/|\\)\.aws[/\\]/i, description: '.aws directory' },
  { pattern: /(^|\/|\\)\.azure[/\\]/i, description: '.azure directory' },
  { pattern: /(^|\/|\\)\.gcloud[/\\]/i, description: '.gcloud directory' },
  { pattern: /(^|\/|\\)\.kube[/\\]/i, description: '.kube directory' },
  { pattern: /(^|\/|\\)\.docker[/\\]/i, description: '.docker directory' },
  { pattern: /(^|\/|\\)\.npmrc$/i, description: '.npmrc file' },
  { pattern: /(^|\/|\\)\.gitconfig$/i, description: '.gitconfig file' },
  { pattern: /(^|\/|\\)id_rsa$/i, description: 'SSH private key' },
  { pattern: /(^|\/|\\)id_ed25519$/i, description: 'SSH private key' },
  { pattern: /(^|\/|\\)authorized_keys$/i, description: 'authorized_keys file' },
  { pattern: /(^|\/|\\)known_hosts$/i, description: 'known_hosts file' },
  { pattern: /(^|\/|\\)\.sentinel\.json$/i, description: 'Sentinel config file' },
  { pattern: /(^|\/|\\)sentinel[-.]key$/i, description: 'Sentinel encryption key' },
  // Windows-specific sensitive paths
  { pattern: /\\Windows\\System32\\/i, description: 'Windows System32 directory' },
  { pattern: /\\Windows\\/i, description: 'Windows directory' },
];

// ─── Security — Path Traversal Detection ──────────────────────────────
// Detects attempts to escape the working directory via ../, null bytes, or
// other path manipulation techniques.
const PATH_TRAVERSAL_PATTERNS = [
  { pattern: /(?:^|[\/\\])\.\.(?:[\/\\]|$)/, description: 'directory traversal (..)' },
  { pattern: /\0/, description: 'null byte injection' },
  { pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F]/, description: 'control character in path' },
  { pattern: /^~/, description: 'home directory reference (~)' },
  { pattern: /%00/, description: 'URL-encoded null byte' },
  { pattern: /%2e%2e/i, description: 'URL-encoded directory traversal' },
  // Deep traversal: more than 3 levels of ../../
  { pattern: /(?:\.\.[\/\\]){3,}/, description: 'deep directory traversal' },
  // Device paths on Windows
  { pattern: /^\\\\\?\\/, description: 'Windows extended-length path prefix' },
];

export function isPathTraversal(filePath: string): { traversal: boolean; reason?: string } {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { pattern, description } of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { traversal: true, reason: description };
    }
  }
  return { traversal: false };
}

// ─── Security — Dangerous File Extensions ─────────────────────────────
// Files with these extensions should never be written by the AI agent.
// They represent executable binaries, system libraries, or other dangerous types.
const DANGEROUS_WRITE_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.msp', '.scr',
  '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.com', '.bat', '.cmd', '.scr', '.pif', '.scf', '.lnk', '.inf',
  '.reg', '.cer', '.crt', '.der', '.pem', '.pfx', '.p12',
  '.docm', '.xlsm', '.pptm',
]);

export function isDangerousExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return DANGEROUS_WRITE_EXTENSIONS.has(ext);
}

// Helper to check if a path matches any sensitive pattern
export function isPathSensitive(filePath: string): { sensitive: boolean; reason?: string } {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { pattern, description } of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { sensitive: true, reason: description };
    }
  }
  return { sensitive: false };
}

// ─── Security — Shell Command Blocklist ───────────────────────────────────
// Commands that are extremely dangerous and should be blocked by default.
// The AI model should never be allowed to run these.
const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+-rf\s+\/\s*$/i, description: 'rm -rf / (wipe entire filesystem)' },
  { pattern: /\brm\s+-rf\s+~\s*$/i, description: 'rm -rf ~ (wipe home directory)' },
  { pattern: /\brm\s+-rf\s+\.\s*$/i, description: 'rm -rf . (wipe current directory)' },
  { pattern: /\brm\s+-rf\s+\*$/i, description: 'rm -rf * (wipe all files)' },
  { pattern: /\brm\s+-rf\s+\/\s*\*/i, description: 'rm -rf /* (wipe everything)' },
  { pattern: /\bdd\s+if=/i, description: 'dd (disk destroyer)' },
  { pattern: /\bmkfs\./i, description: 'mkfs (format filesystem)' },
  { pattern: /\bmke2fs/i, description: 'mke2fs (format filesystem)' },
  { pattern: /\bformat\s+/i, description: 'format command' },
  { pattern: /\bfdisk\s+/i, description: 'fdisk (partition editor)' },
  { pattern: /\bchmod\s+-R\s+0{4}\s+\//i, description: 'chmod -R 000 /' },
  { pattern: /\bchown\s+-R/i, description: 'chown -R (recursive ownership change)' },
  { pattern: /\b>\s*\/dev\/sda/i, description: 'write to raw disk device' },
  { pattern: /\bmv\s+\/\s+/i, description: 'mv / (move root directory)' },
  { pattern: /\bshred\s+\/dev/i, description: 'shred (secure erase)' },
  { pattern: /:\s*\(\)\s*\{\s*:\s*\|/i, description: 'fork bomb' },
  { pattern: /\bwget\s+.+\|.*\bbash\b/i, description: 'wget pipe to bash (remote code execution)' },
  { pattern: /\bcurl\s+.+\|.*\bbash\b/i, description: 'curl pipe to bash (remote code execution)' },
];

// Dangerous shell flags
const DANGEROUS_FLAGS = ['--no-preserve-root', '--force', '-f', '--recursive', '-r'];

function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
  for (const { pattern, description } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason: description };
    }
  }
  return { dangerous: false };
}

// ─── Security — SSRF Protection ──────────────────────────────────────────
// Private and reserved IP ranges that should not be accessible via web_fetch.
const PRIVATE_IP_RANGES = [
  { ip: '127.0.0.0/8', description: 'loopback' },
  { ip: '10.0.0.0/8', description: 'private network' },
  { ip: '172.16.0.0/12', description: 'private network' },
  { ip: '192.168.0.0/16', description: 'private network' },
  { ip: '169.254.0.0/16', description: 'link-local' },
  { ip: '0.0.0.0/8', description: 'invalid address' },
  { ip: '100.64.0.0/10', description: 'carrier-grade NAT' },
  { ip: '198.18.0.0/15', description: 'benchmarking' },
];

// Cloud metadata IPs that should ALWAYS be blocked
const BLOCKED_HOSTS = [
  '169.254.169.254',  // AWS/GCP/Azure metadata
  'metadata.google.internal',
  '100.100.100.200',  // Alibaba Cloud metadata
  'metadata.tencentyun.com',
];

function ipToLong(ip: string): number {
  const parts = ip.split('.');
  return ((+parts[0]! << 24) + (+parts[1]! << 16) + (+parts[2]! << 8) + (+parts[3]!)) >>> 0;
}

function cidrToRange(cidr: string): { start: number; end: number } {
  const [ip, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - +bits!) - 1);
  const ipLong = ipToLong(ip!);
  return { start: ipLong & mask, end: ipLong | (~mask >>> 0) };
}

function isPrivateIP(hostname: string): boolean {
  // Check blocked hosts first
  if (BLOCKED_HOSTS.includes(hostname.toLowerCase())) return true;

  // Check if it's an IP address
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipMatch) return false; // hostname, not IP — allow (DNS resolution happens at network level)

  const ipLong = ipToLong(hostname);
  for (const range of PRIVATE_IP_RANGES) {
    const { start, end } = cidrToRange(range.ip);
    if (ipLong >= start && ipLong <= end) return true;
  }
  return false;
}

// ─── Security — ReDoS-Safe Regex ─────────────────────────────────────────
// Patterns known to be vulnerable to ReDoS (catastrophic backtracking)
const REDOS_PATTERNS = [
  /\(.+\)\+/,     // Nested quantifiers like (pattern)+
  /\(.+\)\*/,     // Nested quantifiers like (pattern)*
  /\(.+\)\{/,     // Nested quantifiers like (pattern){n,m}
  /\[.*\]\+/,     // Character class with quantifier
  /\+\+/,         // Double quantifier
  /\*\*/,
  /\?\+/,
  /\?\*/,
  /\+\*/,
  /\*\+/,
];

function isSafeRegex(pattern: string): boolean {
  // Check for known bad patterns
  for (const redos of REDOS_PATTERNS) {
    if (redos.test(pattern)) {
      return false;
    }
  }
  // Limit pattern length
  if (pattern.length > 500) return false;
  return true;
}

function compileSafeRegex(pattern: string, flags?: string): { regex: RegExp | null; error?: string } {
  try {
    // Check for dangerous patterns first
    if (!isSafeRegex(pattern)) {
      return { regex: null, error: 'Regex pattern too complex or potentially vulnerable to ReDoS. Simplify your search pattern.' };
    }
    return { regex: new RegExp(pattern, flags) };
  } catch (err: any) {
    return { regex: null, error: `Invalid regex: ${err.message}` };
  }
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

// Emoji-free variant — returned to the AI to save tokens
function getFileLabel(ext: string): string {
  const labels: Record<string, string> = {
    '.ts': '.ts', '.tsx': '.tsx', '.js': '.js', '.jsx': '.jsx',
    '.py': '.py', '.rs': '.rs', '.go': '.go', '.java': '.java',
    '.css': '.css', '.html': '.html', '.json': '.json', '.md': '.md',
    '.yaml': '.yaml', '.yml': '.yml', '.env': '.env', '.sh': '.sh',
    '.png': 'img', '.jpg': 'img', '.svg': 'img', '.gif': 'img',
  };
  return (labels[ext.toLowerCase()] ?? ext.slice(1)) || 'txt';
}

// Strip emojis and Unicode symbols that waste tokens in tool results
function stripEmojis(text: string): string {
  return text.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{2B00}-\u{2BFF}]/gu, '');
}

// Compress noisy shell output (npm progress, test results, build lines)
function compressOutput(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 10) return text;

  // Detect known noisy patterns
  let npmProgress = 0;
  let npmResult = '';
  const clean: string[] = [];
  const warnings: string[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const line of lines) {
    if (/^(added|removed|changed|packages|audited|found \d+)/i.test(line.trim())) {
      npmResult = line.trim();
      continue;
    }
    if (/^npm (WARN|ERR)/i.test(line) || /^\d+ warnings?/i.test(line)) {
      warnings.push(line.trim());
      continue;
    }
    if (/\bPASS\b/i.test(line) || /✓|✅|✔/.test(line)) { passCount++; continue; }
    if (/\bFAIL\b/i.test(line) || /✗|❌|✘/.test(line)) { failCount++; continue; }
    if (/\[.*\].*[█▓▒░].*\d+%/.test(line)) { npmProgress++; continue; } // progress bar
    clean.push(line);
  }

  const parts: string[] = clean;
  if (npmProgress > 0) parts.push(`[${npmProgress} progress lines skipped]`);
  if (npmResult) parts.push(`npm summary: ${npmResult}`);
  if (passCount || failCount) parts.push(`Tests: ${passCount} passed, ${failCount} failed`);
  if (warnings.length) parts.push(`Warnings (${warnings.length}):\n${warnings.slice(0, 4).join('\n')}`);
  return parts.join('\n');
}

// Strip ANSI escape sequences from shell output before sending to AI
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]0;.*?\x07/g, '');
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
  description: 'Execute a shell command. Use for scripts, package managers, build tools, git, tests.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      cwd: { type: 'string', description: 'Working directory (default: current directory)' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 30000, max 120000)' },
      log_tail: { type: 'number', description: 'Return only the last N lines of output. Use for long output.' },
      env: { type: 'object', description: 'Extra env vars (e.g. {"NODE_ENV":"test"})' },
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
  async execute({ command, cwd, timeout_ms, log_tail, env }, context = {}) {
    const workingDir = cwd ? resolvePath(cwd) : process.cwd();
    if (!fs.existsSync(workingDir)) return `Error: working directory not found: ${cwd}`;
    if (!fs.statSync(workingDir).isDirectory()) return `Error: not a directory: ${cwd}`;
    const dangerCheck = isDangerousCommand(command);
    if (dangerCheck.dangerous) return `Blocked: ${dangerCheck.reason}`;
    const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 30000, 120000));
    const extraEnv = env && typeof env === 'object' ? env : {};
    return runStreamingShellCommand(command, workingDir, timeout, context, extraEnv, log_tail ? Number(log_tail) : undefined);
  },
};

export function runStreamingShellCommand(
  command: string,
  workingDir: string,
  timeout: number,
  context: ToolExecutionContext = {},
  extraEnv: Record<string, string> = {},
  logTail?: number,
  spawnFactory: ShellSpawnFactory = (cmd, options) => spawn(cmd, options)
): Promise<string> {
  const maxCapture = 1024 * 256;

  return new Promise<string>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const childEnv = { ...process.env, ...extraEnv };
    const child = spawnFactory(command, {
      cwd: workingDir,
      shell: true,
      windowsHide: true,
      env: childEnv,
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
      finish(`Shell error: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      const status = timedOut ? `timed out (${timeout}ms)`
        : aborted ? 'cancelled'
        : code === 0 ? `exit 0`
        : `exit ${code ?? '?'}${signal ? ` (signal: ${signal})` : ''}`;

      let out = stripAnsi(stdout ? compressOutput(stdout) : '');
      let err = stripAnsi(stderr ? compressOutput(stderr) : '');

      // log_tail: return only the last N lines
      if (logTail && logTail > 0) {
        const tail = (s: string) => { const ls = s.split('\n'); return ls.slice(-logTail).join('\n'); };
        out = tail(out);
        err = tail(err);
      }

      // Compact: no "Command"/"Working directory" echo (model already knows)
      let result = `[${status}]`;
      if (out) result += `\n${out}`;
      if (err) result += `\nstderr:\n${formatCodeBlock('text', truncateText(err, 8000))}`;
      if (!out && !err) result += '\n(no output)';
      finish(result);
    });
  });
}

// ─── Security — Sensitive File Read Prompt ───────────────────────────────
function promptSensitiveFileRead(filePath: string, reason: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    process.stdout.write(`\n  ⚠ ${reason} detected: ${filePath}\n`);
    process.stdout.write(`  ${chalk.dim('?')} Read this file anyway? ${chalk.dim('[y/N]: ')}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once('line', (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
    // Timeout after 30s — default to no
    setTimeout(() => { try { rl.close(); } catch {} resolve(false); }, 30000);
  });
}

// ─── Read File ────────────────────────────────────────────────────────────────
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  displayName: 'Reading',
  description: 'Read a file. Use offset/limit to read specific sections without loading entire large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute)' },
      offset: { type: 'number', description: 'Start reading from this line number (1-indexed, default: 1)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (default: all)' },
    },
    required: ['path'],
  },
  getLabel: ({ path: p, offset, limit }) =>
    `${p}${offset ? ` L${offset}` : ''}${limit ? `+${limit}` : ''}`,
  async execute({ path: filePath, offset, limit }) {
    try {
      const fullPath = resolvePath(filePath);

      // Security: block path traversal attempts
      const traverseCheck = isPathTraversal(filePath);
      if (traverseCheck.traversal) {
        return `⚠ Blocked by security policy: Path traversal detected (${traverseCheck.reason}) in "${filePath}".`;
      }

      const sensitiveCheck = isPathSensitive(fullPath);
      if (sensitiveCheck.sensitive) {
        const allow = await promptSensitiveFileRead(filePath, sensitiveCheck.reason!);
        if (!allow) return `Skipped: ${filePath} requires approval (${sensitiveCheck.reason}).`;
      }
      if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`;
      const stat = fs.statSync(fullPath);
      if (stat.size > 1024 * 1024 * 2) return `File too large (${(stat.size / 1024).toFixed(0)} KB). Use offset/limit.`;
      const content = fs.readFileSync(fullPath, 'utf-8');
      const allLines = content.split('\n');
      const start = Math.max(0, (Number(offset) || 1) - 1);
      const end = limit ? Math.min(allLines.length, start + Number(limit)) : allLines.length;
      const sliced = allLines.slice(start, end);
      const numbered = sliced.map((line, idx) =>
        `${String(start + idx + 1).padStart(String(end).length, ' ')}|${line}`
      ).join('\n');
      const range = offset || limit
        ? ` (lines ${start + 1}-${end} of ${allLines.length})`
        : ` (${allLines.length} lines, ${formatBytes(stat.size)})`;
      return `read_file: ${filePath}${range}\n\`\`\`${path.extname(filePath).slice(1) || 'text'}\n${numbered}\n\`\`\``;
    } catch (err: any) {
      return `Error: ${err.message}`;
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

      // Security: block path traversal attempts
      const traverseCheck = isPathTraversal(filePath);
      if (traverseCheck.traversal) {
        return `⚠ Blocked by security policy: Path traversal detected (${traverseCheck.reason}) in "${filePath}".`;
      }

      // Security: block dangerous file extensions
      if (isDangerousExtension(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        return `⚠ Blocked by security policy: Writing ${ext} files is not allowed (${filePath}). This extension is blocked for security.`;
      }

      // Security: block writes to sensitive paths
      const sensitiveCheck = isPathSensitive(fullPath);
      if (sensitiveCheck.sensitive) {
        return `⚠ Blocked by security policy: Cannot write to ${sensitiveCheck.reason} (${filePath}). This path is protected.`;
      }

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
  description: 'Make targeted find-and-replace edits. For multiple edits to the same file, use `edits` array: `[{old_string, new_string}, ...]`. Each old_string must be unique in the file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'The exact string to find and replace (for single edit)' },
      new_string: { type: 'string', description: 'The replacement string (for single edit)' },
      edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['old_string', 'new_string'] }, description: 'Array of {old_string, new_string} for multiple edits to the same file' },
    },
    required: ['path'],
  },
  requiresConfirmation: true,
  getLabel: ({ path: p, edits }) => `${p} (${edits?.length ?? 1} edit(s))`,
  getRiskSummary: ({ path: p, old_string, new_string, edits }) => {
    if (edits?.length) return `Edit ${p}: ${edits.length} replacements`;
    return `Edit ${p}: replace "${String(old_string).split('\n')[0]?.slice(0, 40) ?? ''}..."`;
  },
  async execute({ path: filePath, old_string, new_string, edits }: {
    path: string; old_string?: string; new_string?: string;
    edits?: Array<{ old_string: string; new_string: string }>;
  }) {
    try {
      const fullPath = resolvePath(filePath);

      // Security: block path traversal attempts
      const traverseCheck = isPathTraversal(filePath);
      if (traverseCheck.traversal) {
        return `⚠ Blocked by security policy: Path traversal detected (${traverseCheck.reason}) in "${filePath}".`;
      }

      const sensitiveCheck = isPathSensitive(fullPath);
      if (sensitiveCheck.sensitive) return `Blocked: cannot edit ${sensitiveCheck.reason} (${filePath}).`;
      if (!fs.existsSync(fullPath)) return `File not found: ${filePath}`;

      const original = fs.readFileSync(fullPath, 'utf-8');
      const fileEol = detectEol(original);

      // Normalize: support edits array or single old/new
      const editList: Array<{ old_string: string; new_string: string }> = edits?.length
        ? edits
        : (old_string !== undefined && new_string !== undefined ? [{ old_string, new_string }] : []);
      if (editList.length === 0) return 'Error: provide either (old_string + new_string) or edits array.';

      // Validate and collect replacements
      const replacements: Array<{ old: string; nw: string }> = [];
      for (const edit of editList) {
        const omission = detectOmission(edit.new_string);
        if (omission) return `Blocked: new_string contains omission placeholder ("${omission}").`;
        if (normalizeNewlines(edit.old_string) === normalizeNewlines(edit.new_string)) continue;
        const candidates = [edit.old_string, withEol(edit.old_string, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
        const matched = candidates.find(c => original.includes(c));
        if (!matched) {
          const newCands = [edit.new_string, withEol(edit.new_string, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
          if (newCands.some(c => original.includes(c))) continue; // Already applied — skip
          return `Error: old_string not found in ${filePath}: "${edit.old_string.slice(0, 80)}..."`;
        }
        const occurrences = original.split(matched).length - 1;
        if (occurrences > 1) return `Error: old_string appears ${occurrences} times: "${edit.old_string.slice(0, 60)}...". Make it more specific.`;
        replacements.push({ old: matched, nw: withEol(edit.new_string, fileEol) });
      }
      if (replacements.length === 0) return `Skipped: ${filePath} already has the requested content.`;

      let updated = original;
      for (const { old, nw } of replacements) updated = updated.replace(old, nw);
      fs.writeFileSync(fullPath, updated, 'utf-8');
      return `Edited ${filePath} (${replacements.length} change(s)).\n${generateDiff(original, updated, filePath)}`;
    } catch (err: any) {
      return `Error editing file: ${err.message}`;
    }
  },
};

// ─── Grep (Search File Contents) ─────────────────────────────────────────────
export const grepTool: ToolDefinition = {
  name: 'grep',
  displayName: 'Searching',
  description: 'Search files for a pattern. Supports output_mode: content (default), files (filenames only), count (match counts per file). Use max_results to cap. Use context for surrounding lines.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'String or regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search (default: cwd)' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive (default: false)' },
      include: { type: 'string', description: 'Only search files matching glob (e.g. "*.ts")' },
      max_results: { type: 'number', description: 'Max matching lines to return (default: 200)' },
      context: { type: 'number', description: 'Lines of context before/after each match (like grep -C)' },
      output_mode: { type: 'string', description: 'content|files|count. files = just filenames. count = match counts per file.' },
    },
    required: ['pattern'],
  },
  getLabel: ({ pattern, path: p }) => `"${pattern}" in ${p || '.'}`,
  async execute({ pattern, path: searchPath = '.', case_insensitive = false, include, max_results = 200, context = 0, output_mode = 'content' }: {
    pattern: string; path?: string; case_insensitive?: boolean; include?: string; max_results?: number; context?: number; output_mode?: string;
  }) {
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);
    const fullRoot = resolvePath(searchPath);
    let regex: RegExp;
    let mode = 'regex';

    const compiled = compileSafeRegex(pattern, case_insensitive ? 'gi' : 'g');
    if (compiled.regex) { regex = compiled.regex; }
    else {
      const literalCompiled = compileSafeRegex(escapeRegex(pattern), case_insensitive ? 'gi' : 'g');
      if (literalCompiled.regex) { regex = literalCompiled.regex; mode = 'literal'; }
      else { return `Error: ${compiled.error || 'Invalid pattern'}`; }
    }

    // Try ripgrep first for speed
    if (isRgAvailable() && !context && output_mode === 'content') {
      try {
        const rgArgs = ['--no-heading', '--line-number', '-m', String(max_results),
          ...(case_insensitive ? ['-i'] : []),
          ...(include ? ['-g', include] : []),
          '-e', pattern, fullRoot];
        const result = require('child_process').execSync(`rg ${rgArgs.join(' ')}`, { timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        const lines = result.trim().split('\n');
        const compact = lines.map((l: string) => {
          const [file, ...rest] = l.split(':');
          return `${path.relative(fullRoot, file!).replace(/\\/g, '/')}:${rest?.join(':')?.trim() ?? ''}`;
        }).join('\n');
        return grepResultCompact(mode, pattern, compact || '(no matches)');
      } catch (e: any) {
        if (e.status === 1) return grepResultCompact(mode, pattern, '(no matches)');
        // Fall through to JS walker on error
      }
    }

    const results: string[] = [];
    const fileMatches = new Map<string, string[]>();
    let totalMatches = 0;

    const includeExt = include ? include.replace('*', '').replace('**/', '') : null;

    function walk(dir: string) {
      if (totalMatches >= (max_results ?? 200)) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (totalMatches >= (max_results ?? 200)) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!IGNORE_DIRS.has(entry.name)) walk(fullPath); }
        else if (entry.isFile()) {
          if (includeExt && !entry.name.endsWith(includeExt)) continue;
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const relPath = path.relative(fullRoot, fullPath).replace(/\\/g, '/');
            const lines = content.split('\n');
            let fileHits: string[] = [];
            for (let i = 0; i < lines.length && totalMatches < (max_results ?? 200); i++) {
              if (regex.test(lines[i] ?? '')) {
                totalMatches++;
                if (context && context > 0) {
                  const start = Math.max(0, i - context);
                  const end = Math.min(lines.length, i + context + 1);
                  for (let j = start; j < end; j++) {
                    const marker = j === i ? '>' : ' ';
                    fileHits.push(`${marker}${String(j + 1).padStart(4)} ${(lines[j] ?? '').trim()}`);
                  }
                } else {
                  fileHits.push(`${String(i + 1).padStart(5)} ${(lines[i] ?? '').trim()}`);
                }
              }
              regex.lastIndex = 0;
            }
            if (fileHits.length > 0) fileMatches.set(relPath, fileHits);
          } catch { /* skip */ }
        }
      }
    }

    try {
      const stat = fs.statSync(fullRoot);
      if (stat.isFile()) {
        const content = fs.readFileSync(fullRoot, 'utf-8');
        const lines = content.split('\n');
        let fileHits: string[] = [];
        for (let i = 0; i < lines.length && totalMatches < (max_results ?? 200); i++) {
          if (regex.test(lines[i] ?? '')) {
            totalMatches++;
            fileHits.push(`${String(i + 1).padStart(5)} ${(lines[i] ?? '').trim()}`);
            regex.lastIndex = 0;
          }
        }
        if (fileHits.length > 0) fileMatches.set(path.relative(fullRoot, fullRoot).replace(/\\/g, '/') || path.basename(fullRoot), fileHits);
      } else { walk(fullRoot); }
    } catch (err: any) { return `Error: ${err.message}`; }

    if (fileMatches.size === 0) return grepResultCompact(mode, pattern, '(no matches)');

    // Build output based on mode
    if (output_mode === 'files') {
      return grepResultCompact(mode, pattern, [...fileMatches.keys()].join('\n'));
    }
    if (output_mode === 'count') {
      const counts = [...fileMatches.entries()].map(([f, h]) => `${h.length}  ${f}`);
      return grepResultCompact(mode, pattern, counts.join('\n'));
    }
    // content mode
    const out: string[] = [];
    for (const [f, lines] of fileMatches) {
      out.push(`${f}:`);
      out.push(lines.join('\n'));
    }
    return grepResultCompact(mode, pattern, out.join('\n'));
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
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);
    const fullRoot = resolvePath(rootPath);
    const results: string[] = [];

    // Convert glob to regex
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '__DOUBLE__')
      .replace(/\*/g, '[^/]*')
      .replace(/__DOUBLE__/g, '.*')
      .replace(/\?/g, '[^/]');
    const globCompiled = compileSafeRegex(`^${regexStr}$`);
    if (!globCompiled.regex) return `Error: ${globCompiled.error || 'invalid pattern'}`;
    const regex = globCompiled.regex;

    function walk(dir: string) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(fullRoot, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) { if (!IGNORE_DIRS.has(entry.name)) walk(fullPath); }
        else if (entry.isFile()) {
          if (regex.test(relPath) || regex.test(entry.name)) results.push(relPath);
        }
      }
    }

    walk(fullRoot);
    if (results.length === 0) return `glob: no files matched "${pattern}"`;
    return `${results.length} files matched "${pattern}":\n${results.join('\n')}`;
  },
};

// ─── Web Fetch ────────────────────────────────────────────────────────────────
export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  displayName: 'Fetching',
  description: 'Fetch a URL. Auto-detects content type: strips HTML tags, preserves JSON, wraps plain text.',
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
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname;
      if (isPrivateIP(hostname)) {
        return `Blocked: ${hostname} is a private/internal address (SSRF protection).`;
      }

      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Sentinel-CLI/1.0' },
        responseType: 'text',
      });
      const text: string = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
      const contentType = String(response.headers['content-type'] || '');

      let result: string;
      if (contentType.includes('html')) {
        result = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{3,}/g, '\n')
          .trim();
      } else if (contentType.includes('json')) {
        result = text; // Already JSON — keep as-is
      } else {
        result = text; // Plain text or unknown
      }
      const truncated = result.length > 8000 ? result.slice(0, 8000) + '\n[...truncated at 8000 chars]' : result;
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
  description: 'List files and directories. Use to explore project structure.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default: current directory)' },
      recursive: { type: 'boolean', description: 'List recursively? Default false.' },
    },
    required: [],
  },
  getLabel: ({ path: p }) => p || '.',
  async execute({ path: dirPath = '.', recursive = false }) {
    const IGNORE = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.DS_Store', 'coverage', '.cache', '.tmp-dist']);
    const fullPath = resolvePath(dirPath);
    if (!fs.existsSync(fullPath)) return `Directory not found: ${dirPath}`;

    function listRecursive(dir: string, prefix = ''): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines: string[] = [];
      for (const entry of entries) {
        if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`);
          if (recursive) lines.push(...listRecursive(path.join(dir, entry.name), prefix + '  '));
        } else {
          lines.push(`${prefix}${entry.name}`);
        }
      }
      return lines;
    }

    try {
      const lines = listRecursive(fullPath);
      if (lines.length === 0) return `${dirPath}: (empty)`;
      return `${dirPath}:\n${lines.join('\n')}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
};

// ─── Read Codebase ─────────────────────────────────────────────────────────────
export const readCodebaseTool: ToolDefinition = {
  name: 'read_codebase',
  displayName: 'Loading codebase',
  description: 'Read all source files in a directory recursively. Use mode="summary" to get a file table with line counts (way fewer tokens — then use read_file for specific files).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Root directory (default: cwd)' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to include' },
      mode: { type: 'string', description: 'summary or content. summary = file table only (saves tokens). content = full files (default).' },
      max_lines_per_file: { type: 'number', description: 'Max lines per file (default: unlimited). Prevents one huge file from eating budget.' },
    },
    required: [],
  },
  getLabel: ({ path: p, mode }) => `${p || '.'}${mode === 'summary' ? ' (summary)' : ''}`,
  async execute({ path: dirPath = '.', extensions, mode, max_lines_per_file }: {
    path?: string; extensions?: string[]; mode?: string; max_lines_per_file?: number;
  }) {
    const DEFAULT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.css', '.html', '.json', '.md', '.yaml', '.yml', '.toml']);
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'coverage', '.cache', '.tmp-dist']);
    const IGNORE_FILES = new Set(['.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
    const allowedExts = extensions ? new Set(extensions) : DEFAULT_EXTS;
    const fullRoot = resolvePath(dirPath);
    const maxPerFile = max_lines_per_file ? Number(max_lines_per_file) : 0;
    const summary: Array<{ path: string; lines: number; size: number }> = [];

    if (mode === 'summary') {
      // Walk and collect file metadata only
      function walk(dir: string) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { if (!IGNORE_DIRS.has(entry.name)) walk(fullPath); }
          else if (entry.isFile()) {
            if (IGNORE_FILES.has(entry.name)) continue;
            if (!allowedExts.has(path.extname(entry.name).toLowerCase())) continue;
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const relPath = path.relative(fullRoot, fullPath).replace(/\\/g, '/');
              summary.push({ path: relPath, lines: content.split('\n').length, size: content.length });
            } catch { /* skip */ }
          }
        }
      }
      walk(fullRoot);
      if (summary.length === 0) return 'summary: no source files found';
      summary.sort((a, b) => a.path.localeCompare(b.path));
      const table = summary.map(s => `${String(s.lines).padStart(5)}L ${s.path}`);
      return `read_codebase summary (${summary.length} files):\n${table.join('\n')}\n\nTip: use read_file with offset/limit to peek at specific files.`;
    }

    // Content mode
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
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!IGNORE_DIRS.has(entry.name)) walk(fullPath); }
        else if (entry.isFile()) {
          if (IGNORE_FILES.has(entry.name)) continue;
          if (!allowedExts.has(path.extname(entry.name).toLowerCase())) continue;
          try {
            let content = fs.readFileSync(fullPath, 'utf-8');
            const relPath = path.relative(fullRoot, fullPath).replace(/\\/g, '/');
            const lines = content.split('\n');
            if (maxPerFile > 0 && lines.length > maxPerFile) {
              content = lines.slice(0, maxPerFile).join('\n') + `\n... [${lines.length - maxPerFile} more lines]`;
            }
            const ext = path.extname(relPath).slice(1) || 'text';
            const snippet = `\n${'='.repeat(50)}\n${relPath}  (${lines.length} lines)\n${'='.repeat(50)}\n\`\`\`${ext}\n${addLineNumbers(content)}\n\`\`\``;
            results.push(snippet);
            totalSize += snippet.length;
          } catch { /* skip */ }
        }
      }
    }

    walk(fullRoot);
    if (results.length === 0) return 'No source files found.';
    return `read_codebase: ${dirPath}\n${results.join('\n')}${totalSize > MAX_SIZE ? '\n\n[...truncated at 200KB]' : ''}`;
  },
};

// ─── Ask User (mid-task clarification) ────────────────────────────────────────
export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  displayName: 'Asking',
  description: 'Ask the user a question when you need more information. Use sparingly.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      timeout_seconds: { type: 'number', description: 'Seconds to wait before using default (default: no timeout)' },
      default_response: { type: 'string', description: 'Default answer if user does not respond in time' },
    },
    required: ['question'],
  },
  getLabel: ({ question }) => question,
  async execute({ question, timeout_seconds, default_response }) {
    process.stdout.write('\n' + chalk.cyan('  ? ') + chalk.white.bold(question) + '\n');
    if (default_response) process.stdout.write(chalk.dim(`  [default: ${default_response}]\n`));
    process.stdout.write(chalk.dim('  Your answer: '));
    return new Promise<string>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.once('line', (answer) => {
        if (timer) clearTimeout(timer);
        rl.close();
        const trimmed = answer.trim();
        resolve(trimmed || default_response || '(no answer)');
      });
      if (timeout_seconds && Number(timeout_seconds) > 0) {
        timer = setTimeout(() => {
          try { rl.close(); } catch { }
          resolve(default_response || '(timed out)');
        }, Number(timeout_seconds) * 1000);
      }
    });
  },
};

// ─── Git ─────────────────────────────────────────────────────────────────────
export const gitTool: ToolDefinition = {
  name: 'git',
  displayName: 'Git',
  description: 'Run common git operations with structured output. Faster and fewer tokens than execute_shell with raw git commands. Supports: status, diff, log, branch, add, commit.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', description: 'Operation: status, diff, log, branch, add, commit' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files to stage (for add) or commit message (for commit)' },
      message: { type: 'string', description: 'Commit message (for commit operation)' },
      max_log: { type: 'number', description: 'Max log entries (default: 10)' },
    },
    required: ['op'],
  },
  requiresConfirmation: true,
  getLabel: ({ op, files }) => `git ${op}${files?.length ? ` ${files.join(' ')}` : ''}`,
  getRiskSummary: ({ op, message }) => {
    const parts = [`git ${op}`];
    if (message) parts.push(`message="${message}"`);
    return parts.join(' | ');
  },
  async execute({ op, files, message, max_log = 10 }) {
    const cwd = process.cwd();
    const run = (args: string) => {
      try {
        return require('child_process').execSync(`git ${args}`, { cwd, timeout: 15000, encoding: 'utf-8', maxBuffer: 512 * 1024 }).trim();
      } catch (e: any) {
        return `Error: ${e.stderr?.trim() || e.message}`;
      }
    };

    switch (op) {
      case 'status': {
        const out = run('status --porcelain');
        if (!out) return 'git status: clean (no changes)';
        const lines: string[] = out.split('\n').filter(Boolean);
        const staged = lines.filter((l: string) => /^[MDRACU]/.test(l));
        const unstaged = lines.filter((l: string) => /^.[MDR]/.test(l));
        const untracked = lines.filter((l: string) => l.startsWith('??'));
        const parts = [`git status: ${lines.length} changes`];
        if (staged.length) parts.push(`Staged (${staged.length}):\n${staged.join('\n')}`);
        if (unstaged.length) parts.push(`Modified (${unstaged.length}):\n${unstaged.join('\n')}`);
        if (untracked.length) parts.push(`Untracked (${untracked.length}):\n${untracked.join('\n')}`);
        return parts.join('\n\n');
      }
      case 'diff':
        return `git diff:\n\`\`\`diff\n${run('diff --stat')}\`\`\`\n\n\`\`\`diff\n${truncateText(run('diff'), 8000)}\`\`\``;
      case 'log':
        return `git log (last ${max_log}):\n${run(`log --oneline -${max_log}`)}`;
      case 'branch':
        return `git branches:\n${run('branch -a')}`;
      case 'add': {
        const targets = files?.length ? files.join(' ') : '.';
        return `git add ${targets}:\n${run(`add ${targets}`) || 'staged'}`;
      }
      case 'commit': {
        if (!message) return 'Error: commit requires a message param.';
        return `git commit:\n${run(`commit -m "${message.replace(/"/g, '\\"')}"`) || 'committed'}`;
      }
      default:
        return `Unknown git operation: ${op}. Supported: status, diff, log, branch, add, commit.`;
    }
  },
};

// ─── Delegate Task (Subagent) ─────────────────────────────────────────────────
export const delegateTaskTool: ToolDefinition = {
  name: 'delegate_task',
  displayName: 'Delegating',
  description: 'Spawn a read-only subagent to independently explore or research a specific question in the codebase. The subagent can grep, glob, read files, and list directories — then returns a structured summary. Use for tasks that require broad exploration without polluting your main conversation context.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the subagent should investigate (e.g. "Find all places where auth middleware is used")' },
      context: { type: 'string', description: 'Background context to help the subagent understand the task' },
      mode: { type: 'string', description: 'explore = brief file summary, research = deeper analysis (default: explore)' },
      name: { type: 'string', description: 'Agent name (default: Codebase Explorer)' },
    },
    required: ['goal'],
  },
  requiresConfirmation: true,
  getLabel: ({ goal, name }) => `${name || 'Codebase Explorer'}: ${String(goal).slice(0, 50)}`,
  getRiskSummary: ({ goal, mode, name }) => `${name || 'Codebase Explorer'} (${mode || 'explore'}) — "${String(goal).slice(0, 70)}"`,
  async execute({ goal, context = '', mode = 'explore', name = 'Codebase Explorer' }) {
    // Dynamic import to avoid circular dependency at module load time
    const { runAgent, createAgentProvider } = await import('../agent/index.js');
    const { provider, config } = createAgentProvider();

    const result = await runAgent(config, provider, {
      name,
      goal: String(goal),
      context: String(context),
      mode: mode === 'research' ? 'research' : 'explore',
      parentCwd: process.cwd(),
    });

    const header = result.error ? `${name} completed with error` : `${name} complete`;
    const stats = `${result.toolCallsMade} tool calls, ${result.filesExamined.length} files examined`;
    return `${header} (${stats})\n\n${result.summary}`;
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
  gitTool,
  delegateTaskTool,
];

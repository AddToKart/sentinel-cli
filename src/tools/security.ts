import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
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

export interface ShellSpawnResult {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
}

export type ShellSpawnFactory = (command: string, options: {
  cwd: string;
  shell: boolean;
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
}) => ShellSpawnResult;

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

export function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function withEol(content: string, eol: '\r\n' | '\n'): string {
  return normalizeNewlines(content).replace(/\n/g, eol);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated at ${maxChars} chars]`;
}

export function appendWithLimit(current: string, chunk: string, maxChars: number): string {
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

export function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, idx) => `${String(idx + 1).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

export function formatCodeBlock(lang: string, content: string): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

export function formatToolResult(title: string, sections: Array<{ label: string; content: string }>): string {
  const parts = [title];
  for (const section of sections) {
    parts.push('');
    parts.push(`${section.label}:`);
    parts.push(section.content);
  }
  return parts.join('\n');
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let _rgAvailable: boolean | null = null;
export function isRgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable;
  try { execSync('rg --version', { stdio: 'ignore', timeout: 2000 }); _rgAvailable = true; } catch { _rgAvailable = false; }
  return _rgAvailable;
}

export function compactResult(label: string, body: string): string {
  return `${label}\n${body}`;
}

export function grepResultCompact(mode: string, pattern: string, body: string): string {
  return `grep(${mode}): "${pattern}"\n${body}`;
}

const OMISSION_PATTERNS = [
  /\/\/ \.\.\. existing/i, /\/\/ \.\.\. rest/i, /\/\/ \.\.\. previous/i,
  /\[existing code\]/i, /\[rest of (the )?file\]/i, /\[previous code\]/i,
  /# \.\.\. existing/i, /# \.\.\. rest/i,
  /\/\* \.\.\. \*\//,
];

export function detectOmission(content: string): string | null {
  for (const pat of OMISSION_PATTERNS) {
    const line = content.split('\n').find(l => pat.test(l));
    if (line) return line.trim();
  }
  return null;
}

// ─── Security — Sensitive File Patterns ────────────────────────────────────
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
  { pattern: /\\Windows\\System32\\/i, description: 'Windows System32 directory' },
  { pattern: /\\Windows\\/i, description: 'Windows directory' },
];

const PATH_TRAVERSAL_PATTERNS = [
  { pattern: /(?:^|[\/\\])\.\.(?:[\/\\]|$)/, description: 'directory traversal (..)' },
  { pattern: /\0/, description: 'null byte injection' },
  { pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F]/, description: 'control character in path' },
  { pattern: /^~/, description: 'home directory reference (~)' },
  { pattern: /%00/, description: 'URL-encoded null byte' },
  { pattern: /%2e%2e/i, description: 'URL-encoded directory traversal' },
  { pattern: /(?:\.\.[\/\\]){3,}/, description: 'deep directory traversal' },
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

export function isPathSensitive(filePath: string): { sensitive: boolean; reason?: string } {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { pattern, description } of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { sensitive: true, reason: description };
    }
  }
  return { sensitive: false };
}

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

export function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
  for (const { pattern, description } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason: description };
    }
  }
  return { dangerous: false };
}

const BLOCKED_HOSTS = ['metadata.google.internal', '169.254.169.254'];
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

export function isPrivateIP(hostname: string): boolean {
  if (BLOCKED_HOSTS.includes(hostname.toLowerCase())) return true;
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipMatch) return false;
  const ipLong = ipToLong(hostname);
  for (const range of PRIVATE_IP_RANGES) {
    const { start, end } = cidrToRange(range.ip);
    if (ipLong >= start && ipLong <= end) return true;
  }
  return false;
}

const REDOS_PATTERNS = [
  /\(.+\)\+/, /\(.+\)\*/, /\(.+\)\{/, /\[.*\]\+/, /\+\+/, /\*\*/, /\?\+/, /\?\*/, /\+\*/, /\*\+/,
];

export function isSafeRegex(pattern: string): boolean {
  for (const redos of REDOS_PATTERNS) {
    if (redos.test(pattern)) return false;
  }
  if (pattern.length > 500) return false;
  return true;
}

export function compileSafeRegex(pattern: string, flags?: string): { regex: RegExp | null; error?: string } {
  try {
    if (!isSafeRegex(pattern)) {
      return { regex: null, error: 'Regex pattern too complex or potentially vulnerable to ReDoS. Simplify your search pattern.' };
    }
    return { regex: new RegExp(pattern, flags) };
  } catch (err: any) {
    return { regex: null, error: `Invalid regex: ${err.message}` };
  }
}

export function getFileIcon(ext: string): string {
  const icons: Record<string, string> = {
    '.ts': '📘', '.tsx': '📘', '.js': '📒', '.jsx': '📒',
    '.py': '🐍', '.rs': '🦀', '.go': '🐹', '.java': '☕',
    '.css': '🎨', '.html': '🌐', '.json': '📋', '.md': '📝',
    '.yaml': '⚙️', '.yml': '⚙️', '.env': '🔑', '.sh': '⚡',
    '.png': '🖼️', '.jpg': '🖼️', '.svg': '🖼️', '.gif': '🖼️',
  };
  return icons[ext.toLowerCase()] ?? '📄';
}

export function getFileLabel(ext: string): string {
  const labels: Record<string, string> = {
    '.ts': '.ts', '.tsx': '.tsx', '.js': '.js', '.jsx': '.jsx',
    '.py': '.py', '.rs': '.rs', '.go': '.go', '.java': '.java',
    '.css': '.css', '.html': '.html', '.json': '.json', '.md': '.md',
    '.yaml': '.yaml', '.yml': '.yml', '.env': '.env', '.sh': '.sh',
    '.png': 'img', '.jpg': 'img', '.svg': 'img', '.gif': 'img',
  };
  return (labels[ext.toLowerCase()] ?? ext.slice(1)) || 'txt';
}

export async function promptSensitiveFileRead(filePath: string, reason: string): Promise<boolean> {
  const { Style, buildPanel } = await import('../cli/ui/theme.js');
  const body = buildPanel('Sensitive File Access', [
    `${Style.warning('⚠')} Read requested for sensitive file: ${Style.accent(filePath)}`,
    `${Style.dim('Reason:')} ${reason}`,
    '',
    `${Style.accent('[y]')}${Style.dim('es  ')}${Style.error('[n]')}${Style.dim('o')}`,
  ]);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('  ');

  return new Promise<boolean>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const handler = (_str: string, key: any) => {
      if (!key) return;
      const ch = (key.name || '').toLowerCase();
      if (['y', 'n', 'return', 'enter'].includes(ch)) {
        process.stdin.removeListener('keypress', handler);
        process.stdout.write(ch === 'n' ? `${Style.error('no')}\n\n` : `${Style.accent('yes')}\n\n`);
        resolve(ch !== 'n');
      }
      if (key.ctrl && key.name === 'c') {
        process.stdin.removeListener('keypress', handler);
        resolve(false);
      }
    };
    process.stdin.on('keypress', handler);
  });
}

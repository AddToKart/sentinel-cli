import chalk from 'chalk';
import readline from 'readline';
import path from 'path';
import { Style, buildPanel } from '../ui/theme.js';

// ─── Per-session "Always Allow" cache ────────────────────────────────────
const alwaysAllowKeys = new Set<string>();

// ─── Trusted Directories (Flow Mode) ─────────────────────────────────────
// When a directory is trusted, write_file and edit_file skip confirmation
// for any path under that directory. execute_shell always prompts.
let trustedDirectories = new Set<string>();

const SAFE_TOOLS = new Set(['write_file', 'edit_file']);
const TRUST_PREFIX = '__trusted_dir__:';

function normalizeDir(dir: string): string {
  try {
    const resolved = path.resolve(dir);
    return fs.realpathSync(resolved).toLowerCase();
  } catch {
    return path.resolve(dir).toLowerCase();
  }
}

import fs from 'fs';
import { isPathSensitive } from '../../tools/index.js';

/**
 * Trust a directory: write_file and edit_file for paths under this
 * directory will skip confirmation.
 */
export function trustDirectory(dir: string): void {
  trustedDirectories.add(normalizeDir(dir));
}

/**
 * Remove trust from a directory.
 */
export function untrustDirectory(dir: string): boolean {
  return trustedDirectories.delete(normalizeDir(dir));
}

/**
 * Check if a directory is currently trusted.
 */
export function isDirectoryTrusted(dir: string): boolean {
  return trustedDirectories.has(normalizeDir(dir));
}

/**
 * Check if any trust is active.
 */
export function hasAnyTrust(): boolean {
  return trustedDirectories.size > 0;
}

/**
 * Get the list of trusted directories.
 */
export function getTrustedDirectories(): string[] {
  return [...trustedDirectories];
}

/**
 * Clear all trusted directories.
 */
export function clearAllTrust(): void {
  trustedDirectories.clear();
}

/**
 * Check if a given file path falls under any trusted directory.
 */
function isPathInTrustedDir(filePath: string): boolean {
  if (trustedDirectories.size === 0) return false;
  if (!filePath) return false;

  let resolved: string;
  try {
    resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    resolved = fs.realpathSync(resolved).toLowerCase();
  } catch {
    resolved = path.resolve(filePath).toLowerCase();
  }

  for (const trusted of trustedDirectories) {
    if (resolved.startsWith(trusted + path.sep) || resolved === trusted) {
      return true;
    }
  }
  return false;
}

// ─── Approval Key ────────────────────────────────────────────────────────
function getApprovalKey(tool: any, args: any): string {
  const toolName = String(tool?.name ?? 'unknown');
  if (typeof args?.path === 'string' && args.path.trim()) {
    const fullPath = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
    return `${toolName}:path:${fullPath.toLowerCase()}`;
  }
  if (typeof args?.command === 'string' && args.command.trim()) {
    return `${toolName}:command:${args.command}`;
  }
  return `${toolName}:global`;
}

// ─── Confirm Tool ────────────────────────────────────────────────────────
export async function confirmTool(tool: any, args: any): Promise<boolean> {
  const toolName = String(tool?.name ?? '');

  // Flow Mode: if the directory is trusted, skip confirmation for
  // write_file and edit_file (safe tools). execute_shell always prompts.
  // EXCEPTION: sensitive files (env, .ssh, etc.) always require approval.
  if (SAFE_TOOLS.has(toolName) && isPathInTrustedDir(args?.path)) {
    const filePath = typeof args?.path === 'string' ? args.path : '';
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!isPathSensitive(fullPath).sensitive) {
      return true;
    }
  }

  const approvalKey = getApprovalKey(tool, args);
  if (alwaysAllowKeys.has(approvalKey)) return true;

  const summary = tool.getRiskSummary ? tool.getRiskSummary(args) : (tool.getLabel ? tool.getLabel(args) : tool.name);
  const isWriteTool = SAFE_TOOLS.has(toolName);
  const isTrusted = isPathInTrustedDir(args?.path);

  const body = buildPanel('Confirm Action', [
    `${Style.dim('Action:')} ${Style.body(summary)}`,
    isTrusted ? `${Style.dim('Trust:')}  ${Style.success('directory is trusted, auto-approved')}` : '',
    '',
    `${Style.accent('[y]')}${Style.dim('es  ')}${Style.error('[n]')}${Style.dim('o  ')}${Style.accent('[a]')}${Style.dim('llow always')}`,
  ].filter(Boolean));
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('  ');

  return new Promise<boolean>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const handler = (_str: string, key: any) => {
      if (!key) return;
      const ch = (key.name || '').toLowerCase();
      if (['y', 'n', 'a', 'return', 'enter'].includes(ch)) {
        process.stdin.removeListener('keypress', handler);
        if (ch === 'a') alwaysAllowKeys.add(approvalKey);
        process.stdout.write(ch === 'n' ? `${Style.error('no')}\n\n` : `${Style.accent(ch === 'a' ? 'always' : 'yes')}\n\n`);
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

// ─── Confirm Yes/No ──────────────────────────────────────────────────────
export async function confirmYesNo(prompt: string, yesDefault: boolean = true): Promise<boolean> {
  process.stdout.write(`\n  ${Style.dim('?')} ${Style.body(prompt)} ${Style.dim(yesDefault ? '[Y/n]: ' : '[y/N]: ')}`);
  return new Promise<boolean>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const handler = (_str: string, key: any) => {
      if (!key) return;
      const ch = (key.name || '').toLowerCase();
      if (ch === 'return' || ch === 'enter') {
        process.stdin.removeListener('keypress', handler);
        process.stdout.write(`${yesDefault ? Style.success('yes') : Style.error('no')}\n`);
        resolve(yesDefault);
        return;
      }
      if (ch === 'y') {
        process.stdin.removeListener('keypress', handler);
        process.stdout.write(`${Style.success('yes')}\n`);
        resolve(true);
        return;
      }
      if (ch === 'n') {
        process.stdin.removeListener('keypress', handler);
        process.stdout.write(`${Style.error('no')}\n`);
        resolve(false);
      }
    };
    process.stdin.on('keypress', handler);
  });
}

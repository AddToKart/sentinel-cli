import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import os from 'os';
import { Style, buildPanel } from '../ui/theme.js';

/**
 * Sentinel Directory Sandbox
 *
 * Restricts file-system tool operations to within the working directory
 * the CLI was launched from. Any access outside requires explicit user approval.
 *
 * Security model:
 * - All file paths are resolved and normalized
 * - Access is checked against the sandbox root (process.cwd())
 * - Cross-directory access prompts the user for approval
 * - Approved external paths are cached for the session
 * - Symlinks are resolved to their real paths before checking
 * - TOCTOU mitigation: paths are re-checked with realpath before each operation
 */

let sandboxRoot: string = process.cwd();
const approvedExternalPaths = new Set<string>();

let sandboxEnabled = true;

/**
 * Sets the sandbox root directory.
 */
export function setSandboxRoot(dir: string) {
  sandboxRoot = path.resolve(dir);
  approvedExternalPaths.clear();
}

/**
 * Gets the current sandbox root.
 */
export function getSandboxRoot(): string {
  return sandboxRoot;
}

/**
 * Enable or disable the sandbox.
 */
export function setSandboxEnabled(enabled: boolean) {
  sandboxEnabled = enabled;
  if (!enabled) approvedExternalPaths.clear();
}

export function isSandboxEnabled(): boolean {
  return sandboxEnabled;
}

/**
 * Resolves a file path relative to the sandbox root and checks if it's allowed.
 * Returns the resolved path if allowed, or throws/returns null if blocked.
 */
export function resolvePathSafe(filePath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(sandboxRoot, filePath);
  return path.normalize(resolved);
}

/**
 * Resolves symlinks to get the real filesystem path.
 * For non-existent paths, resolves the parent directory's real path and joins.
 * This avoids the unsafe fallback to path.normalize() that could miss symlink attacks.
 */
function getRealPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // Path doesn't exist yet. Resolve the parent directory to detect symlink attacks
    // on the directory structure, then join with the basename.
    try {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const realDir = fs.realpathSync(dir);
      return path.join(realDir, base);
    } catch {
      // If even the parent can't be resolved, use the original path
      return path.normalize(filePath);
    }
  }
}

// ─── Security — Windows Junction Point Detection ────────────────────────
// `fs.realpathSync()` does NOT resolve Windows junction points (reparse points),
// meaning a junction inside the sandbox tree could silently redirect file access
// to an external directory. We use `fs.realpathSync.native()` which DOES resolve
// junctions and compare results to detect them.
const junctionCache = new Map<string, boolean>();

/**
 * Check if a path traverses through any Windows junction points (reparse points).
 * Uses the native realpath implementation which resolves junctions on Windows.
 * Results are cached since junction points don't change during a session.
 */
function hasJunctionPoints(filePath: string): boolean {
  if (process.platform !== 'win32') return false;
  const normalized = path.resolve(filePath);
  if (junctionCache.has(normalized)) return junctionCache.get(normalized)!;

  try {
    // Compare standard realpath (does NOT resolve junctions) with native realpath (DOES resolve junctions)
    const standardReal = fs.realpathSync(normalized);
    const nativeReal = fs.realpathSync.native(normalized);

    // If they differ, there's a junction/reparse point in the path
    const hasJunction = path.relative(standardReal, nativeReal) !== '';
    junctionCache.set(normalized, hasJunction);
    return hasJunction;
  } catch {
    // If either fails, cannot determine — assume no junction
    junctionCache.set(normalized, false);
    return false;
  }
}

/**
 * Get the native real path that resolves through junction points.
 * Falls back to standard realpath on non-Windows or on error.
 */
function getNativeRealPath(filePath: string): string {
  try {
    if (process.platform === 'win32') {
      return fs.realpathSync.native(filePath);
    }
    return fs.realpathSync(filePath);
  } catch {
    return getRealPath(filePath);
  }
}

// ─── Security — Environment Variable Expansion Detection ────────────────
// Detects paths containing %VAR% patterns that could be used for injection.
// For example: %APPDATA%\malware.exe or %COMSPEC% /c "evil"
const ENV_VAR_PATTERN = /%[A-Za-z_][A-Za-z0-9_]*%/;

/**
 * Check if a path contains environment variable expansion references (%VAR%).
 * These could be used to inject unexpected paths at runtime.
 */
function hasEnvVarExpansion(filePath: string): boolean {
  return ENV_VAR_PATTERN.test(filePath);
}

/**
 * Strict path resolution for TOCTOU mitigation.
 * This should be called immediately before a file operation to ensure
 * the path is still valid and within the sandbox.
 * If a symlink was swapped between the initial check and the operation,
 * this re-check will catch it.
 * Also detects Windows junction points and env var expansion attacks.
 */
export function recheckPathInSandbox(filePath: string): { allowed: boolean; realPath: string; warning?: string } {
  const resolved = resolvePathSafe(filePath);

  // Use native realpath on Windows to resolve junction points
  const realPath = getNativeRealPath(resolved);

  if (!sandboxEnabled) return { allowed: true, realPath };

  // Check for env var expansion attacks
  if (hasEnvVarExpansion(filePath)) {
    return { allowed: false, realPath, warning: 'Path contains environment variable expansion references (%VAR%)' };
  }

  const allowed = isPathInSandbox(filePath) || isPathApproved(filePath);

  // Warn about junction points but still allow if within sandbox
  const junctionDetected = hasJunctionPoints(resolved);
  if (junctionDetected) {
    const nativeReal = getNativeRealPath(resolved);
    const outsideSandbox = !nativeReal.startsWith(getRealPath(sandboxRoot));
    if (outsideSandbox) {
      return { allowed: false, realPath, warning: 'Path traverses a junction point to a location outside the sandbox' };
    }
    return { allowed, realPath, ...(junctionDetected ? { warning: 'Path traverses a junction point' } : {}) };
  }

  return { allowed, realPath };
}

/**
 * Checks if a path is within the sandbox root.
 * Resolves symlinks to prevent symlink-escape attacks.
 * On Windows, uses native realpath to also resolve junction points.
 */
export function isPathInSandbox(filePath: string): boolean {
  if (!sandboxEnabled) return true;
  const resolved = resolvePathSafe(filePath);
  const realPath = getNativeRealPath(resolved);
  const realRoot = getNativeRealPath(sandboxRoot);

  // Normalize both to lowercase on Windows for case-insensitive comparison
  const normalizedPath = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  const normalizedRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;

  return normalizedPath.startsWith(normalizedRoot + path.sep) || normalizedPath === normalizedRoot;
}

/**
 * Checks if a path is in the approved external paths cache.
 * On Windows, uses native realpath for junction-aware resolution.
 */
export function isPathApproved(filePath: string): boolean {
  const resolved = resolvePathSafe(filePath);
  const realPath = getNativeRealPath(resolved);
  for (const approved of approvedExternalPaths) {
    if (realPath.startsWith(approved)) return true;
  }
  return false;
}

/**
 * Prompts the user to approve access to a path outside the sandbox.
 * Returns true if approved, false otherwise.
 */
export async function requestPathApproval(
  toolName: string,
  filePath: string,
  operation: string
): Promise<boolean> {
  const resolved = resolvePathSafe(filePath);
  const realPath = getRealPath(resolved);
  const relativeToRoot = path.relative(sandboxRoot, realPath);

  const body = buildPanel('⚠ Directory Sandbox', [
    Style.warning('This operation is outside the working directory.'),
    '',
    `${Style.dim('Tool:')}         ${Style.accent(toolName)}`,
    `${Style.dim('Operation:')}    ${Style.body(operation)}`,
    `${Style.dim('Target:')}       ${Style.body(relativeToRoot)}`,
    `${Style.dim('Full path:')}    ${Style.dim(realPath)}`,
    `${Style.dim('Sandbox:')}      ${Style.accent(sandboxRoot)}`,
    '',
    `${Style.accent('[y]')}${Style.dim('es once  ')}${Style.accent('[a]')}${Style.dim('lways for this path  ')}${Style.error('[n]')}${Style.dim('o')}`,
  ]);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('  ');

  return new Promise<boolean>((resolve) => {
    const handler = (_str: string, key: any) => {
      if (!key) return;
      const ch = (key.name || '').toLowerCase();
      if (['y', 'n', 'a', 'return', 'enter'].includes(ch)) {
        process.stdin.removeListener('keypress', handler);
        if (ch === 'a') {
          // Approve this directory for the session
          const dirToApprove = fs.existsSync(realPath) && fs.statSync(realPath).isDirectory()
            ? realPath
            : path.dirname(realPath);
          approvedExternalPaths.add(dirToApprove);
          process.stdout.write(Style.accent('always') + '\n\n');
          resolve(true);
        } else if (ch === 'y' || ch === 'return' || ch === 'enter') {
          process.stdout.write(Style.accent('yes') + '\n\n');
          resolve(true);
        } else {
          process.stdout.write(Style.error('no') + '\n\n');
          resolve(false);
        }
      }
      if (key.ctrl && key.name === 'c') {
        process.stdin.removeListener('keypress', handler);
        resolve(false);
      }
    };
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', handler);
  });
}

/**
 * Unified sandbox check: validates that an operation on a path is allowed.
 * Returns null if allowed, or an error message string if blocked.
 */
export async function checkSandbox(
  toolName: string,
  filePath: string,
  operation: string,
  autoApproveExternal: boolean = false
): Promise<string | null> {
  if (!sandboxEnabled || !filePath) return null;

  // Security: reject paths with environment variable expansion
  if (hasEnvVarExpansion(filePath)) {
    return `Sandbox blocked: "${toolName}" path contains environment variable expansion (%VAR%) which is not allowed for security reasons.`;
  }

  // Security: reject paths that use junction points to escape the sandbox
  const resolved = resolvePathSafe(filePath);
  if (hasJunctionPoints(resolved)) {
    const nativeReal = getNativeRealPath(resolved);
    const realRoot = getNativeRealPath(sandboxRoot);
    const normalizedReal = process.platform === 'win32' ? nativeReal.toLowerCase() : nativeReal;
    const normalizedRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
    const outsideSandbox = !normalizedReal.startsWith(normalizedRoot + path.sep) && normalizedReal !== normalizedRoot;
    if (outsideSandbox) {
      return `Sandbox blocked: "${toolName}" path traverses a junction/reparse point that redirects outside the working directory (${nativeReal}).`;
    }
  }

  if (isPathInSandbox(filePath) || isPathApproved(filePath)) return null;

  if (autoApproveExternal) {
    // For explicitly user-triggered operations (like /load), auto-approve
    const realPath = getNativeRealPath(resolved);
    const dirToApprove = fs.existsSync(realPath) && fs.statSync(realPath).isDirectory()
      ? realPath
      : path.dirname(realPath);
    approvedExternalPaths.add(dirToApprove);
    return null;
  }

  const approved = await requestPathApproval(toolName, filePath, operation);
  if (approved) return null;

  const relativeToRoot = path.relative(sandboxRoot, getNativeRealPath(resolvePathSafe(filePath)));
  return `Sandbox blocked: "${toolName}" tried to access "${relativeToRoot}" outside the working directory. Use "${Style.accent('[y]')}" to approve or "${Style.accent('[a]')}" to always allow this path.`;
}

/**
 * Resets all approved external paths (e.g., on /clear or session reset).
 */
export function resetSandboxApprovals() {
  approvedExternalPaths.clear();
}

/**
 * Returns a list of currently approved external paths.
 */
export function getApprovedExternalPaths(): string[] {
  return [...approvedExternalPaths];
}

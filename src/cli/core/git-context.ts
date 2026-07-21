import { execSync } from 'child_process';

let cachedContext: string | null = null;
let cachedTs = 0;
const CACHE_TTL = 10_000;

interface GitState {
  branch: string;
  hasChanges: boolean;
  changedFiles: string[];
  aheadBehind: string;
  recentCommits: string[];
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

function isGitRepo(): boolean {
  return exec('git rev-parse --is-inside-work-tree 2>nul') === 'true';
}

function getGitState(): GitState | null {
  if (!isGitRepo()) return null;
  const branch = exec('git rev-parse --abbrev-ref HEAD 2>nul') || 'unknown';
  const status = exec('git status --porcelain 2>nul');
  const changedFiles = status ? status.split('\n').filter(Boolean).map(l => l.slice(3).trim()) : [];
  const aheadBehindRaw = exec('git rev-list --count --left-right HEAD...@{upstream} 2>nul');
  const aheadBehind = aheadBehindRaw ? (() => {
    const parts = aheadBehindRaw.split('\t');
    const counts = (parts[0] ?? '').split(' ');
    return `${counts[0] || '0'} ahead, ${counts[1] || '0'} behind`;
  })() : '';
  const recentCommits = exec('git log --oneline -5 2>nul').split('\n').filter(Boolean);
  return { branch, hasChanges: status.length > 0, changedFiles, aheadBehind, recentCommits };
}

export function buildGitContextBlock(): string {
  const now = Date.now();
  if (cachedContext && now - cachedTs < CACHE_TTL) return cachedContext;

  const state = getGitState();
  if (!state) { cachedContext = ''; cachedTs = now; return ''; }

  const lines: string[] = ['Git workspace snapshot (auto-detected):'];
  lines.push(`- Branch: ${state.branch}`);
  if (state.aheadBehind) lines.push(`- Remote: ${state.aheadBehind}`);
  if (state.changedFiles.length > 0) {
    lines.push(`- ${state.changedFiles.length} uncommitted file(s):`);
    for (const f of state.changedFiles.slice(0, 15)) lines.push(`  • ${f}`);
    if (state.changedFiles.length > 15) lines.push(`  … and ${state.changedFiles.length - 15} more`);
  } else {
    lines.push('- Working tree clean');
  }
  if (state.recentCommits.length > 0) {
    lines.push('- Recent commits:');
    for (const c of state.recentCommits) lines.push(`  ${c}`);
  }
  lines.push('- Prefer making focused, atomic commits. Use conventional commit format.');

  cachedContext = lines.join('\n');
  cachedTs = now;
  return cachedContext;
}

export function getGitBranch(): string {
  return getGitState()?.branch ?? '';
}

export function getChangedFiles(): string[] {
  return getGitState()?.changedFiles ?? [];
}

export function hasGitChanges(): boolean {
  return getGitState()?.hasChanges ?? false;
}

export function injectGitContext(userInput: string): string {
  const gitBlock = buildGitContextBlock();
  if (!gitBlock) return userInput;
  return `${userInput}\n\n---\n${gitBlock}`;
}

export function clearGitCache() {
  cachedContext = null;
  cachedTs = 0;
}

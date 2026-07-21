import fs from 'fs';
import path from 'path';
import { Style } from '../ui/theme.js';
import { startSpinner } from '../ui/rendering.js';
import { loadConfig } from '../../config/index.js';
import { ProviderFactory } from '../../providers/index.js';

const INIT_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.cache', '.tmp-dist']);

export function collectProjectSignals(): string {
  const parts: string[] = [];
  const cwd = process.cwd();

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    parts.push(`package.json: name=${pkg.name ?? ''} version=${pkg.version ?? ''} description=${pkg.description ?? ''} type=${pkg.type ?? 'commonjs'}`);
    if (pkg.scripts) parts.push(`scripts: ${Object.entries(pkg.scripts).map(([k, v]) => `${k}="${v}"`).join(', ')}`);
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    if (deps.length) parts.push(`dependencies: ${deps.join(', ')}`);
    if (devDeps.length) parts.push(`devDependencies: ${devDeps.join(', ')}`);
  } catch { /* no package.json */ }

  const entries: string[] = [];
  try {
    outer: for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (INIT_IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        entries.push(`${e.name}/`);
        try {
          for (const sub of fs.readdirSync(path.join(cwd, e.name), { withFileTypes: true }).slice(0, 15)) {
            if (INIT_IGNORE_DIRS.has(sub.name) || sub.name.startsWith('.')) continue;
            entries.push(`  ${e.name}/${sub.name}${sub.isDirectory() ? '/' : ''}`);
            if (entries.length >= 80) break outer;
          }
        } catch { /* unreadable dir */ }
      } else {
        entries.push(e.name);
      }
      if (entries.length >= 80) break;
    }
  } catch { /* unreadable cwd */ }
  if (entries.length) parts.push(`files:\n${entries.join('\n')}`);

  try {
    for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
      const rp = path.join(cwd, name);
      if (fs.existsSync(rp)) {
        parts.push(`README excerpt:\n${fs.readFileSync(rp, 'utf-8').slice(0, 1200)}`);
        break;
      }
    }
  } catch { /* no readme */ }

  const configs = ['tsconfig.json', 'Dockerfile', 'docker-compose.yml', '.env.example', 'wrangler.toml', 'vercel.json', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml'];
  const found = configs.filter(c => fs.existsSync(path.join(cwd, c)));
  if (found.length) parts.push(`config files: ${found.join(', ')}`);

  return parts.join('\n\n');
}

export function buildSentinelPrompt(signals: string): string {
  return `You are generating a SENTINEL.md project memory file. This file is injected into an AI coding agent's context on EVERY message, so it MUST be extremely compact and information-dense.

HARD RULES:
- Max 50 lines total. Every line must carry information.
- Use only these sections (omit a section if nothing to say): # Project, ## Stack, ## Commands, ## Conventions, ## Architecture, ## Notes.
- Dense bullet points only. NO paragraphs, NO prose, NO badges, NO images, NO emojis.
- State ONLY facts inferable from the signals below. If unknown, omit — NO placeholders like "(fill in)".
- ## Commands: exact shell commands for dev/build/test/lint, one per bullet (e.g. \`npm run dev\` — start dev server).
- ## Conventions: coding style/rules only if clearly inferable (e.g. ESM modules, TypeScript strict).
- ## Architecture: key directories with a few-word purpose each (max 8 bullets).
- ## Notes: gotchas an agent must know (e.g. "config file is .sentinel.json in cwd").
- Output ONLY the markdown content. NO preamble, NO explanation, NO wrapping code fences.

PROJECT SIGNALS:
${signals}`;
}

export function buildFallbackSentinel(signals: string): string {
  const cwdName = path.basename(process.cwd());
  const lines = [`# Project`, `- ${cwdName}`];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    if (pkg.description) lines.push(`- ${pkg.description}`);
    if (pkg.scripts) {
      lines.push('', '## Commands');
      for (const [k, v] of Object.entries(pkg.scripts)) lines.push(`- \`npm run ${k}\` — ${v}`);
    }
  } catch { /* ignore */ }
  lines.push('', '## Notes', '- Add conventions and architecture notes here as the project evolves.');
  return lines.join('\n') + '\n';
}

export async function handleInitCommand(config: ReturnType<typeof loadConfig>, providerName: string, modelName: string): Promise<void> {
  const mdPath = path.join(process.cwd(), 'SENTINEL.md');
  if (fs.existsSync(mdPath)) { process.stdout.write(`${Style.warning(' ⚠')} SENTINEL.md already exists.\n\n`); return; }

  const signals = collectProjectSignals();
  let content = '';

  try {
    const provider = ProviderFactory.getProvider(providerName, config, modelName);
    const stop = startSpinner('Scanning project, generating SENTINEL.md...');
    const resp = await provider.sendMessage([{ role: 'user', content: buildSentinelPrompt(signals) }], [], { maxRetries: 1 });
    stop();
    content = (resp.content ?? '').trim();
    content = content.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  } catch (err: any) {
    process.stdout.write(Style.dim(` (AI generation unavailable: ${err?.message ?? 'unknown'} — writing basic file instead)\n`));
  }

  if (!content || content.length < 40) content = buildFallbackSentinel(signals);

  fs.writeFileSync(mdPath, content.endsWith('\n') ? content : content + '\n');
  const lineCount = content.split('\n').length;
  process.stdout.write(`${Style.success(' ✔')} Generated SENTINEL.md ${Style.dim(`(${lineCount} lines — loaded into every prompt as project memory)`)}\n\n`);
}

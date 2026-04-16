import os from 'os';
import chalk from 'chalk';
import gradient from 'gradient-string';
import { G, G_DARK, G_LIGHT, sentinelLogo } from './theme.js';

const greenGradient = gradient([G_DARK, G, G_LIGHT, G]);
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const AT_MENTION_RE = /@([\w./\\-]+)/g;
const FILE_EXT_RE = /\b([\w./\\-]+\.(?:ts|tsx|js|jsx|py|html|css|json|md|txt|sh|yaml|yml|go|rs|java|c|cpp|h|toml|sql|env))\b/gi;

export function renderWelcome(provider: string, model: string) {
  console.clear();
  console.log('\n' + greenGradient(sentinelLogo));
  console.log(chalk.hex(G_DARK)(`v1.0.0 | ${provider.toUpperCase()} | ${model}\n`));
  console.log(chalk.hex(G_LIGHT)('Tips for getting started:'));
  console.log(chalk.white('1. Ask questions, edit files, or run commands.'));
  console.log(chalk.white('2. Be specific for the best results.'));
  console.log(chalk.white('3. Create SENTINEL.md files to customize your interactions with Sentinel.'));
  console.log(chalk.white('4. /help for more information.'));
  console.log(chalk.hex(G_DARK)(' Try /init to generate a SENTINEL.md file.\n'));
}

export function startSpinner(label: string): () => void {
  const SPINNER_FRAMES = ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${chalk.hex(G)(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${chalk.dim(label)}  `);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write('\r\x1b[K');
  };
}

export async function streamText(text: string): Promise<void> {
  const WORD_DELAY = 18;
  const words = text.split(/(\s+)/);
  for (const word of words) {
    process.stdout.write(word);
    if (word.trim().length > 0) {
      await new Promise(r => setTimeout(r, WORD_DELAY));
    }
  }
  process.stdout.write('\n');
}

export function renderMarkdown(text: string): string {
  return text
    .replace(/```[\w]*\n([\s\S]*?)```/g, (_: string, code: string) => {
      return code.split('\n').map((l: string) => chalk.bgHex('#0d1117')(chalk.greenBright('  ' + l))).join('\n');
    })
    .replace(/^---+$/gm, chalk.dim('\u2500'.repeat(60)))
    .replace(/^# (.+)$/gm, (_: string, t: string) => chalk.bold.green('\u2593 ' + t.toUpperCase()))
    .replace(/^## (.+)$/gm, (_: string, t: string) => chalk.bold.cyan('\u25b6 ' + t))
    .replace(/^### (.+)$/gm, (_: string, t: string) => chalk.bold.white('  \u2022 ' + t))
    .replace(/\*\*(.+?)\*\*/g, (_: string, t: string) => chalk.bold.white(t))
    .replace(/\*(.+?)\*/g, (_: string, t: string) => chalk.italic(t))
    .replace(/`([^`]+)`/g, (_: string, t: string) => chalk.bgHex('#1a1a2e')(chalk.cyan(t)))
    .replace(/^\|(.+)\|$/gm, (line: string) => chalk.dim(line))
    .replace(/^\|[-| ]+\|$/gm, (line: string) => chalk.dim(line))
    .replace(/^(\s*)[-*] (.+)$/gm, (_: string, indent: string, item: string) => `${indent}${chalk.green('\u2022')} ${item}`)
    .replace(/^(\s*)(\d+)\. (.+)$/gm, (_: string, indent: string, n: string, item: string) => `${indent}${chalk.green(n + '.')} ${item}`);
}

export function highlightMentions(text: string): string {
  const mentioned = new Set<string>();
  text = text.replace(AT_MENTION_RE, (_m: string, p: string) => {
    mentioned.add(p);
    return chalk.hex(G_LIGHT)('@') + chalk.hex(G_LIGHT).underline(p);
  });
  text = text.replace(FILE_EXT_RE, (m: string) => {
    if (mentioned.has(m)) return m;
    return chalk.hex(G_LIGHT)(m);
  });
  return text;
}

export function buildStatusBar(model: string, tokens: number): string[] {
  const w = Math.max(40, process.stdout.columns || 80);
  const sep = chalk.bgHex('#0d1b2e')(chalk.hex('#1e3a5f')('─'.repeat(w)));

  const home = os.homedir();
  const rawCwd = process.cwd().replace(home, '~');
  const cwd = rawCwd.length > 38 ? '…' + rawCwd.slice(-37) : rawCwd;
  const mid = model.length > 42 ? model.slice(0, 41) + '…' : model;
  const right = tokens > 0
    ? (tokens > 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`) + ' tokens'
    : 'ready';

  const cwdLen = cwd.length + 1;
  const midLen = mid.length;
  const rightLen = right.length + 1;
  const space = Math.max(2, w - cwdLen - midLen - rightLen);
  const lGap = Math.floor(space / 2);
  const rGap = space - lGap;

  const content = ' ' + chalk.hex(G)(cwd)
    + ' '.repeat(lGap)
    + chalk.white(mid)
    + ' '.repeat(rGap)
    + chalk.dim(right) + ' ';

  const bare = content.replace(ANSI_RE, '');
  const padded = bare.length < w ? content + ' '.repeat(w - bare.length) : content;
  const info = chalk.bgHex('#0d1b2e')(padded);
  return [sep, info];
}

import os from 'os';
import chalk from 'chalk';
import figures from 'figures';
import { COLORS, THEME, sentinelLogo } from './theme.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const AT_MENTION_RE = /@([\w./\\-]+)/g;
const FILE_EXT_RE = /\b([\w./\\-]+\.(?:ts|tsx|js|jsx|py|html|css|json|md|txt|sh|yaml|yml|go|rs|java|c|cpp|h|toml|sql|env))\b/gi;

function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  if (max === 2) return `${text[0]}…`;

  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
}

export function renderWelcome(provider: string, model: string) {
  console.clear();
  process.stdout.write(THEME.icon(sentinelLogo) + '\n');
  process.stdout.write(chalk.dim(' '.repeat(2) + '─'.repeat(60) + ' v2.1\n\n'));
  
  process.stdout.write(chalk.hex(COLORS.slate400)('  ' + figures.info + ' PROTOCOL: ') + chalk.hex(COLORS.green300)(provider.toUpperCase()) + chalk.dim(' ◈ ') + chalk.hex(COLORS.green300)(model) + '\n\n');

  const tips = [
    ['Mention', 'Use ' + chalk.hex(COLORS.green400)('@filename') + ' to attach context'],
    ['Search', 'Use ' + chalk.hex(COLORS.green400)('[Tab]') + ' for file autocomplete'],
    ['Control', 'Slash commands like ' + chalk.hex(COLORS.green400)('/models') + ' or ' + chalk.hex(COLORS.green400)('/clear')],
  ];

  for (const tip of tips) {
    const label = tip[0] ?? '';
    const desc = tip[1] ?? '';
    process.stdout.write(chalk.dim('  ' + figures.pointerSmall + ' ') + chalk.hex(COLORS.slate300).bold(label.padEnd(10)) + chalk.dim('│ ') + chalk.hex(COLORS.slate400)(desc) + '\n');
  }
  process.stdout.write('\n');
}

export function startSpinner(label: string): () => void {
  const SPINNER_FRAMES = ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${THEME.icon(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${THEME.dim(label)}  `);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write('\r\x1b[K');
  };
}

export async function streamText(text: string): Promise<void> {
  const WORD_DELAY = 18;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    const words = line.split(/(\s+)/);
    for (const word of words) {
      process.stdout.write(word);
      if (word.trim().length > 0) {
        await new Promise(r => setTimeout(r, WORD_DELAY));
      }
    }
    if (i < lines.length - 1) process.stdout.write('\n');
  }
  process.stdout.write('\n');
}

export function renderMarkdown(text: string): string {
  // 1. First, format markdown elements (bold, italic, inline code)
  let formatted = text
    .replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(chalk.hex(COLORS.slate100)(t)))
    .replace(/\*(.+?)\*/g, (_, t) => chalk.italic(chalk.hex(COLORS.slate300)(t)))
    .replace(/`([^`\n]+)`/g, (_, t) => THEME.codeBg(` ${t} `))
    .replace(/^# (.+)$/gm, (_, t) => chalk.bold.hex(COLORS.green300)('⬦ ' + t.toUpperCase()))
    .replace(/^## (.+)$/gm, (_, t) => chalk.bold.hex(COLORS.green300)('⬦ ' + t))
    .replace(/^### (.+)$/gm, (_, t) => chalk.bold.hex(COLORS.green300)('  \u2022 ' + t))
    .replace(/^(\s*)[-*] (.+)$/gm, (_, indent, item) => `${indent}${chalk.hex(COLORS.green500)('⬦')} ${item}`)
    .replace(/^(\s*)(\d+)\. (.+)$/gm, (_, indent, n, item) => `${indent}${chalk.hex(COLORS.green500)(n + '.')} ${item}`);

  // 2. Parse blocks to handle code vs normal text
  const blocks = formatted.split(/(```[\s\S]*?```)/g);
  let result = '';

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] || '';
    if (block.startsWith('```')) {
      // Code block
      const lines = block.split('\n');
      const firstLine = lines[0] || '';
      const langMatch = firstLine.match(/```(\w+)?/);
      const lang = langMatch && langMatch[1] ? ` ${langMatch[1]} ` : ' code ';
      
      const width = Math.max(34, Math.min(72, (process.stdout.columns || 80) - 8));
      const topBar = `╭─${lang}${'─'.repeat(Math.max(0, width - lang.length - 2))}╮`;
      const bottomBar = `╰${'─'.repeat(width)}╯`;
      
      const codeLines = lines.slice(1, -1);
      
      result += `${THEME.icon('┃')} ${THEME.border(topBar)}\n`;
      for (const line of codeLines) {
        // Pad line to width
        const rawLine = line.replace(ANSI_RE, '');
        const padLen = Math.max(0, width - 2 - rawLine.length);
        const paddedLine = line + ' '.repeat(padLen);
        
        result += `${THEME.icon('┃')} ${THEME.border('│')} ${chalk.hex(COLORS.slate200)(paddedLine)} ${THEME.border('│')}\n`;
      }
      result += `${THEME.icon('┃')} ${THEME.border(bottomBar)}\n`;
      
    } else {
      // Normal text
      if (!block.trim()) {
        if (i > 0 && i < blocks.length - 1) result += `${THEME.icon('┃')}\n`;
        continue;
      }
      
      const lines = block.split('\n');
      for (let j = 0; j < lines.length; j++) {
        // Skip trailing empty lines
        if (j === lines.length - 1 && !lines[j]) continue;
        result += `${THEME.icon('┃')} ${THEME.body(lines[j] || '')}\n`;
      }
    }
  }

  return result;
}

export function highlightMentions(text: string): string {
  const mentioned = new Set<string>();
  text = text.replace(AT_MENTION_RE, (_, p) => {
    mentioned.add(p);
    return chalk.hex(COLORS.green300)('@') + chalk.hex(COLORS.green300).underline(p);
  });
  text = text.replace(FILE_EXT_RE, (m) => {
    if (mentioned.has(m)) return m;
    return chalk.hex(COLORS.green300)(m);
  });
  return text;
}

export function buildStatusBar(model: string, tokens: number): string[] {
  const w = Math.max(40, (process.stdout.columns || 80));
  const home = os.homedir();
  const rawCwd = process.cwd().replace(home, '~');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tokenLabel = tokens > 0
    ? `ctx ${tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}`
    : 'ctx 0';
  const right = `${tokenLabel} • ${time}`;

  const chromeWidth = 16 + right.length;
  const contentWidth = Math.max(18, w - chromeWidth);
  const cwdMax = Math.max(12, Math.min(26, Math.floor(contentWidth * 0.38)));
  const modelMax = Math.max(14, contentWidth - cwdMax);
  const cwd = truncateMiddle(rawCwd, cwdMax);
  const modelLabel = truncateMiddle(model, modelMax);

  const content = THEME.icon('◈ ')
    + THEME.header('CHAT')
    + THEME.dim(' │ ')
    + THEME.body(cwd)
    + THEME.dim(' │ ')
    + THEME.body(modelLabel)
    + THEME.dim(' │ ')
    + THEME.dim(right);

  return [content];
}

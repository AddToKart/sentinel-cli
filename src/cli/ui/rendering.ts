import os from 'os';
import chalk from 'chalk';
import figures from 'figures';
import { COLORS, THEME, sentinelLogo } from './theme.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const AT_MENTION_RE = /@([\w./\\-]+)/g;
const FILE_EXT_RE = /\b([\w./\\-]+\.(?:ts|tsx|js|jsx|py|html|css|json|md|txt|sh|yaml|yml|go|rs|java|c|cpp|h|toml|sql|env))\b/gi;
const JS_KEYWORDS = /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|interface|type|implements|public|private|protected|static)\b/g;

function formatMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(chalk.hex(COLORS.slate100)(t)))
    .replace(/\*(.+?)\*/g, (_, t) => chalk.italic(chalk.hex(COLORS.slate300)(t)))
    .replace(/`([^`\n]+)`/g, (_, t) => THEME.codeBg(` ${t} `))
    .replace(/^# (.+)$/gm, (_, t) => chalk.bold.hex(COLORS.green300)('⬦ ' + t.toUpperCase()))
    .replace(/^## (.+)$/gm, (_, t) => chalk.bold.hex(COLORS.green300)('⬦ ' + t))
    .replace(/^### (.+)$/gm, (_, t) => chalk.bold.hex(COLORS.green300)('  \u2022 ' + t))
    .replace(/^(\s*)[-*] (.+)$/gm, (_, indent, item) => `${indent}${chalk.hex(COLORS.green500)('⬦')} ${item}`)
    .replace(/^(\s*)(\d+)\. (.+)$/gm, (_, indent, n, item) => `${indent}${chalk.hex(COLORS.green500)(n + '.')} ${item}`);
}

function highlightHtmlLine(line: string): string {
  let out = line;
  out = out.replace(/<!--.*?-->/g, (m) => chalk.hex(COLORS.slate500)(m));
  out = out.replace(/<!DOCTYPE[^>]*>/gi, (m) => chalk.hex(COLORS.green500)(m));
  out = out.replace(/(<\/?)([a-zA-Z][\w:-]*)/g, (_, open, tag) => `${chalk.hex(COLORS.green500)(open)}${chalk.hex(COLORS.green300)(tag)}`);
  out = out.replace(/\b([a-zA-Z_:][\w:.-]*)(=)/g, (_, attr, eq) => `${chalk.hex(COLORS.slate100)(attr)}${chalk.hex(COLORS.green500)(eq)}`);
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => chalk.hex(COLORS.slate200)(m));
  out = out.replace(/\/?>/g, (m) => chalk.hex(COLORS.green500)(m));
  return out;
}

function highlightCssLine(line: string): string {
  let out = line;
  out = out.replace(/\/\*.*?\*\//g, (m) => chalk.hex(COLORS.slate500)(m));
  out = out.replace(/(^|\s)([#.]?[a-zA-Z][\w-]*)(?=\s*\{)/g, (_, ws, selector) => `${ws}${chalk.hex(COLORS.green300)(selector)}`);
  out = out.replace(/\b([a-z-]+)(\s*:)/gi, (_, prop, colon) => `${chalk.hex(COLORS.slate100)(prop)}${chalk.hex(COLORS.green500)(colon)}`);
  out = out.replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => chalk.hex(COLORS.green400)(m));
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => chalk.hex(COLORS.slate200)(m));
  out = out.replace(/[{};(),]/g, (m) => chalk.hex(COLORS.green500)(m));
  return out;
}

function highlightJsLine(line: string): string {
  let out = line;
  out = out.replace(/\/\/.*$/g, (m) => chalk.hex(COLORS.slate500)(m));
  out = out.replace(/\/\*.*?\*\//g, (m) => chalk.hex(COLORS.slate500)(m));
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => chalk.hex(COLORS.slate200)(m));
  out = out.replace(JS_KEYWORDS, (m) => chalk.hex(COLORS.green400)(m));
  out = out.replace(/\b(true|false|null|undefined)\b/g, (m) => chalk.hex(COLORS.green300)(m));
  out = out.replace(/\b\d+(?:\.\d+)?\b/g, (m) => chalk.hex(COLORS.green300)(m));
  return out;
}

function highlightShellLine(line: string): string {
  let out = line;
  out = out.replace(/#.*$/g, (m) => chalk.hex(COLORS.slate500)(m));
  out = out.replace(/(^\s*)([\w./-]+)/, (_, ws, cmd) => `${ws}${chalk.hex(COLORS.green400)(cmd)}`);
  out = out.replace(/\s(--?[\w-]+)/g, (_, flag) => ` ${chalk.hex(COLORS.green300)(flag)}`);
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => chalk.hex(COLORS.slate200)(m));
  return out;
}

function highlightCodeLine(line: string, languageHint: string): string {
  const lang = languageHint.toLowerCase();
  if (!line.trim()) return line;
  if (['html', 'htm', 'xml', 'svg'].includes(lang)) return highlightHtmlLine(line);
  if (['css', 'scss', 'sass'].includes(lang)) return highlightCssLine(line);
  if (['js', 'jsx', 'ts', 'tsx', 'json'].includes(lang)) return highlightJsLine(line);
  if (['sh', 'bash', 'zsh', 'shell', 'powershell', 'ps1'].includes(lang)) return highlightShellLine(line);
  return chalk.hex(COLORS.slate200)(line);
}

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
  // Parse blocks first so markdown formatting does not alter fenced code.
  const blocks = text.split(/(```[\s\S]*?```)/g);
  let result = '';

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] || '';
    if (block.startsWith('```')) {
      // Code block
      const lines = block.split('\n');
      const firstLine = lines[0] || '';
      const langMatch = firstLine.match(/```([\w#+-]+)?/);
      const languageHint = langMatch && langMatch[1] ? langMatch[1] : '';
      const lang = languageHint ? ` ${languageHint} ` : ' code ';
      
      const width = Math.max(34, Math.min(72, (process.stdout.columns || 80) - 8));
      const topBar = `╭─${lang}${'─'.repeat(Math.max(0, width - lang.length - 2))}╮`;
      const bottomBar = `╰${'─'.repeat(width)}╯`;
      
      const codeLines = lines.slice(1, -1);
      
      result += `${THEME.icon('┃')} ${THEME.border(topBar)}\n`;
      for (const rawLine of codeLines) {
        const highlightedLine = highlightCodeLine(rawLine, languageHint);
        // Pad line to width
        const visibleLine = highlightedLine.replace(ANSI_RE, '');
        const padLen = Math.max(0, width - 2 - visibleLine.length);
        const paddedLine = highlightedLine + ' '.repeat(padLen);
        
        result += `${THEME.icon('┃')} ${THEME.border('│')} ${paddedLine} ${THEME.border('│')}\n`;
      }
      result += `${THEME.icon('┃')} ${THEME.border(bottomBar)}\n`;
      
    } else {
      // Normal text
      const formatted = formatMarkdownInline(block);
      if (!formatted.trim()) {
        if (i > 0 && i < blocks.length - 1) result += `${THEME.icon('┃')}\n`;
        continue;
      }
      
      const lines = formatted.split('\n');
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

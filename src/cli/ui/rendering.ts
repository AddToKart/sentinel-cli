import os from 'os';
import path from 'path';
import chalk from 'chalk';
import figures from 'figures';
import { COLORS, Style, THEME, buildPanel } from './theme.js';

// ─── ANSI / Regex Helpers ────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }
const AT_MENTION_RE = /@([\w./\\-]+)/g;
const FILE_EXT_RE = /\b([\w./\\-]+\.(?:ts|tsx|js|jsx|py|html|css|json|md|txt|sh|yaml|yml|go|rs|java|c|cpp|h|toml|sql|env|rb|php|swift|kt|scala|ex|exs))\b/gi;

// ─── Language highlighting maps ──────────────────────────────────────────
const HTML_TAGS = /\b(html|head|body|div|span|p|a|img|ul|ol|li|table|tr|td|th|form|input|button|select|option|textarea|h[1-6]|section|article|nav|header|footer|main|aside|figure|figcaption|blockquote|code|pre|em|strong|i|b|u|s|br|hr|label|fieldset|legend|datalist|optgroup|meta|link|script|style|title|video|audio|canvas|source|picture|iframe|embed|object|param|details|summary|dialog|slot|template)\b/gi;
const JS_KW = /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|interface|type|implements|abstract|static|private|protected|public|readonly|enum|namespace|module|declare|yield|super|this|typeof|instanceof|void|delete|in|of|with)\b/g;
const TS_TYPE_KW = /\b(string|number|boolean|any|never|unknown|null|undefined|void|symbol|bigint|object|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|ConstructorParameters|InstanceType|ThisType|Uppercase|Lowercase|Capitalize|Uncapitalize)\b/g;
const RUST_KW = /\b(fn|let|mut|const|if|else|for|while|loop|match|return|pub|use|mod|struct|enum|impl|trait|where|as|in|ref|move|crate|self|super|async|await|unsafe|dyn|type|static|extern|macro_rules)\b/g;
const PY_KW = /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|and|or|not|is|in|lambda|yield|async|await|raise|global|nonlocal|assert|del|print|self|None|True|False)\b/g;

function highlightHtmlLine(line: string): string {
  let out = line;
  out = out.replace(/<!--.*?-->/g, m => chalk.hex(COLORS.comment)(m));
  out = out.replace(/<!DOCTYPE[^>]*>/gi, m => Style.accent(m));
  out = out.replace(/(<\/?)([a-zA-Z][\w:-]*)/g, (_, o, t) => `${chalk.hex(COLORS.tag)(o)}${chalk.hex(COLORS.function)(t)}`);
  out = out.replace(/\b([a-zA-Z_:][\w:.-]*)(=)/g, (_, a, e) => `${chalk.hex(COLORS.attr)(a)}${Style.accent(e)}`);
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => chalk.hex(COLORS.string)(m));
  out = out.replace(/\/?>/g, m => chalk.hex(COLORS.tag)(m));
  return out;
}

function highlightCssLine(line: string): string {
  let out = line;
  out = out.replace(/\/\*.*?\*\//g, m => chalk.hex(COLORS.comment)(m));
  out = out.replace(/(^|\s)([#.]?[a-zA-Z][\w-]*)(?=\s*\{)/g, (_, ws, s) => `${ws}${chalk.hex(COLORS.type)(s)}`);
  out = out.replace(/\b([a-z-]+)(\s*:)/gi, (_, p, c) => `${chalk.hex(COLORS.attr)(p)}${Style.accent(c)}`);
  out = out.replace(/#[0-9a-fA-F]{3,8}\b/g, m => chalk.hex(COLORS.number)(m));
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => chalk.hex(COLORS.string)(m));
  out = out.replace(/[{};(),]/g, m => chalk.hex(COLORS.operator)(m));
  return out;
}

function highlightTsLine(line: string): string {
  let out = line;
  out = out.replace(/\/\/.*$/g, m => chalk.hex(COLORS.comment)(m));
  out = out.replace(/\/\*.*?\*\//g, m => chalk.hex(COLORS.comment)(m));
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, m => chalk.hex(COLORS.string)(m));
  out = out.replace(JS_KW, m => chalk.hex(COLORS.keyword)(m));
  out = out.replace(TS_TYPE_KW, m => chalk.hex(COLORS.type)(m));
  out = out.replace(/\b(true|false|null|undefined|NaN|Infinity)\b/g, m => chalk.hex(COLORS.keyword)(m));
  out = out.replace(/\b\d+(?:\.\d+)?(?:n|f|l)?\b/g, m => chalk.hex(COLORS.number)(m));
  out = out.replace(/\b([A-Z][a-zA-Z0-9]+)(?=\s*[<(])/g, m => chalk.hex(COLORS.type)(m));
  return out;
}

function highlightRustLine(line: string): string {
  let out = line;
  out = out.replace(/\/\/.*$/g, m => chalk.hex(COLORS.comment)(m));
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, m => chalk.hex(COLORS.string)(m));
  out = out.replace(RUST_KW, m => chalk.hex(COLORS.keyword)(m));
  out = out.replace(/\b(true|false|Some|None|Ok|Err)\b/g, m => chalk.hex(COLORS.keyword)(m));
  out = out.replace(/\b\d+(?:\.\d+)?\b/g, m => chalk.hex(COLORS.number)(m));
  out = out.replace(/\b([A-Z][a-zA-Z0-9]+)\b/g, m => chalk.hex(COLORS.type)(m));
  return out;
}

function highlightPyLine(line: string): string {
  let out = line;
  out = out.replace(/#.*$/g, m => chalk.hex(COLORS.comment)(m));
  out = out.replace(/"""(?:[^"\\]|\\.)*?"""|'''(?:[^'\\]|\\.)*?'''/g, m => chalk.hex(COLORS.string)(m));
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => chalk.hex(COLORS.string)(m));
  out = out.replace(PY_KW, m => chalk.hex(COLORS.keyword)(m));
  out = out.replace(/\b\d+(?:\.\d+)?\b/g, m => chalk.hex(COLORS.number)(m));
  return out;
}

function highlightShellLine(line: string): string {
  let out = line;
  out = out.replace(/#.*$/g, m => chalk.hex(COLORS.comment)(m));
  out = out.replace(/(^\s*)([\w./-]+)/, (_, ws, cmd) => `${ws}${chalk.hex(COLORS.function)(cmd)}`);
  out = out.replace(/\s(--?[\w-]+)/g, (_, f) => ` ${chalk.hex(COLORS.attr)(f)}`);
  out = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => chalk.hex(COLORS.string)(m));
  return out;
}

function highlightCodeLine(line: string, lang: string): string {
  const l = lang.toLowerCase();
  if (!line.trim()) return '';
  if (['html', 'htm', 'xml', 'svg'].includes(l)) return highlightHtmlLine(line);
  if (['css', 'scss', 'sass', 'less'].includes(l)) return highlightCssLine(line);
  if (['js', 'jsx', 'ts', 'tsx', 'json', 'mjs', 'cjs', 'mts', 'cts'].includes(l)) return highlightTsLine(line);
  if (['rs', 'rust'].includes(l)) return highlightRustLine(line);
  if (['py', 'python'].includes(l)) return highlightPyLine(line);
  if (['sh', 'bash', 'zsh', 'shell', 'powershell', 'ps1', 'cmd'].includes(l)) return highlightShellLine(line);
  if (['diff', 'patch'].includes(l)) {
    if (line.startsWith('+')) return chalk.hex(COLORS.green400)(line);
    if (line.startsWith('-')) return chalk.hex(COLORS.slate500)(line);
    if (line.startsWith('@@')) return chalk.hex(COLORS.info)(line);
  }
  return chalk.hex(COLORS.codeLine)(line);
}

// ─── ANSI-aware word wrap ────────────────────────────────────────────────
// Wraps styled text at a visible width. ANSI sequences are never counted or
// split. Segments containing escape codes get a reset appended so styles
// can't bleed into following output.
function wrapAnsiLine(text: string, width: number): string[] {
  if (width < 10) width = 10;
  const out: string[] = [];
  let cur = '';
  let curLen = 0;

  const flush = () => {
    if (!cur) return;
    out.push(/\x1b/.test(cur) ? cur + '\x1b[0m' : cur);
    cur = '';
    curLen = 0;
  };

  for (const tok of text.split(/(\s+)/)) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) {
      if (curLen > 0 && curLen + 1 <= width) { cur += ' '; curLen += 1; }
      continue;
    }
    const wLen = stripAnsi(tok).length;
    if (wLen > width) {
      // Hard-split absurdly long words (on their visible text)
      flush();
      const plain = stripAnsi(tok);
      for (let i = 0; i < plain.length; i += width) {
        out.push(plain.slice(i, i + width));
      }
      continue;
    }
    if (curLen > 0 && curLen + wLen > width) flush();
    cur += tok;
    curLen += wLen;
  }
  flush();
  return out.length ? out : [''];
}

// ─── Markdown Inline Formatting ──────────────────────────────────────────
function formatInline(text: string): string {
  let out = text;
  // Bold
  out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(chalk.hex(COLORS.slate100)(t)));
  // Italic
  out = out.replace(/\*(.+?)\*/g, (_, t) => chalk.italic(chalk.hex(COLORS.slate300)(t)));
  // Inline code
  out = out.replace(/`([^`\n]+)`/g, (_, t) => Style.code(` ${t} `));
  // Strikethrough
  out = out.replace(/~~(.+?)~~/g, (_, t) => chalk.strikethrough(chalk.hex(COLORS.slate500)(t)));
  // Links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, url) => `${chalk.hex(COLORS.info).underline(t)}${Style.dim(` (${url})`)}`);
  // Images
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => chalk.hex(COLORS.muted)(`🖼 ${alt || ''} (${url})`));
  return out;
}

// ─── Markdown Block Rendering ────────────────────────────────────────────
function renderTableBlock(text: string): string[] {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 3) return [text];
  const headers = lines[0]!.split('|').filter(s => s.trim()).map(s => s.trim());
  const rows = lines.slice(2).map(l => l.split('|').filter(s => s.trim()).map(s => s.trim()));
  if (rows.length === 0 || headers.length === 0) return [text];

  const nCols = headers.length;
  const avail = Math.max(40, (process.stdout.columns || 80) - 4); // minus '┃ ' gutter

  // Natural column widths (capped), then shrink widest until the table fits.
  const colW = headers.map((h, i) =>
    Math.max(4, Math.min(36,
      Math.max(stripAnsi(h).length, ...rows.map(r => stripAnsi(r[i] ?? '').length))
    ))
  );
  const totalW = () => colW.reduce((a, b) => a + b, 0) + 3 * nCols + 1;
  let guard = 600;
  while (totalW() > avail && Math.max(...colW) > 6 && guard-- > 0) {
    const widest = Math.max(...colW);
    colW[colW.indexOf(widest)] = widest - 1;
  }

  const emitRow = (cells: string[], isHeader: boolean, out: string[]) => {
    while (cells.length < nCols) cells.push('');
    const wrapped = cells.slice(0, nCols).map((c, i) => wrapAnsiLine(formatInline(c), colW[i]!));
    const height = Math.max(...wrapped.map(w => w.length));
    for (let r = 0; r < height; r++) {
      const parts = wrapped.map((w, i) => {
        const seg = w[r] ?? '';
        const pad = Math.max(0, colW[i]! - stripAnsi(seg).length);
        const padded = seg + ' '.repeat(pad);
        return isHeader ? Style.accent(padded) : Style.body(padded);
      });
      out.push(`${Style.border('│')} ${parts.join(` ${Style.border('│')} `)} ${Style.border('│')}`);
    }
  };

  const top = `┌${colW.map(w => '─'.repeat(w + 2)).join('┬')}┐`;
  const mid = `├${colW.map(w => '─'.repeat(w + 2)).join('┼')}┤`;
  const bot = `└${colW.map(w => '─'.repeat(w + 2)).join('┴')}┘`;

  const result: string[] = [Style.border(top)];
  emitRow(headers, true, result);
  result.push(Style.border(mid));
  for (const row of rows) emitRow(row, false, result);
  result.push(Style.border(bot));
  return result;
}

// ─── Code Block Rendering ────────────────────────────────────────────────
function renderCodeBlock(block: string): string[] {
  const lines = block.split('\n');
  const firstLine = lines[0] ?? '';
  const langMatch = firstLine.match(/```([\w#+-]+)?/);
  const languageHint = (langMatch && langMatch[1]) ? langMatch[1] : '';
  const langLabel = languageHint ? ` ${languageHint} ` : ' code ';
  const codeLines = lines.slice(1, -1);

  const w = Math.max(34, Math.min(80, (process.stdout.columns || 80) - 6));
  const topBar = `╭─${langLabel}${'─'.repeat(Math.max(0, w - 2 - langLabel.length + 2))}╮`;
  const bottomBar = `╰${'─'.repeat(Math.max(0, w))}╯`;

  const result: string[] = [];
  result.push(`${Style.icon('┃')} ${Style.border(topBar)}`);
  for (const rawLine of codeLines) {
    const highlighted = highlightCodeLine(rawLine, languageHint);
    const visible = highlighted.replace(ANSI_RE, '');
    const padLen = Math.max(0, w - 2 - visible.length);
    const padded = highlighted + ' '.repeat(padLen);
    result.push(`${Style.icon('┃')} ${Style.border('│')} ${padded} ${Style.border('│')}`);
  }
  result.push(`${Style.icon('┃')} ${Style.border(bottomBar)}`);
  return result;
}

// ─── Single Text Line Rendering ──────────────────────────────────────────
// Returns one or more visual lines: long content is word-wrapped to the
// terminal width, with the ┃ gutter repeated on every continuation line and
// list/quote continuation lines indented to align under their text.
function renderTextLine(raw: string): string[] {
  const gutter = `${Style.icon('┃')} `;
  if (!raw.trim()) return [`${Style.icon('┃')}`];
  const width = Math.max(30, (process.stdout.columns || 80) - 4);

  let marker = '';      // e.g. ' • ', ' 1. ' — shown on the first visual line
  let contPad = 0;      // extra indent for continuation lines
  let content: string;  // styled content to wrap

  if (/^#{1,3}\s/.test(raw)) {
    const level = raw.match(/^(#+)/)?.[1]?.length ?? 1;
    const clean = formatInline(raw.replace(/^#+\s+/, ''));
    if (level === 1) content = Style.header(clean.toUpperCase());
    else if (level === 2) content = chalk.bold.hex(COLORS.green300)(clean);
    else { content = chalk.hex(COLORS.green300)(clean); marker = '  • '; contPad = 4; }
  } else if (/^#{4,6}\s/.test(raw)) {
    content = Style.dim(formatInline(raw.replace(/^#+\s+/, '')));
    marker = '    ';
    contPad = 4;
  } else if (/^\s*[-*]\s/.test(raw)) {
    content = Style.body(formatInline(raw.replace(/^\s*[-*]\s+/, '')));
    marker = `${Style.dim(' •')} `;
    contPad = 3;
  } else if (/^\s*\d+[.)]\s/.test(raw)) {
    const match = raw.match(/^\s*(\d+[.)])\s+(.*)/);
    if (match) {
      content = Style.body(formatInline(match[2] ?? ''));
      marker = `${Style.accent(` ${match[1]}`)} `;
      contPad = (match[1] ?? '').length + 2;
    } else {
      content = Style.body(formatInline(raw));
    }
  } else if (/^>\s/.test(raw)) {
    content = chalk.italic(formatInline(raw.replace(/^>\s+/, '')));
    marker = `${Style.border('│')} `;
    contPad = 2;
  } else if (/^[-*_]{3,}$/.test(raw.trim())) {
    return [`${gutter}${Style.hSep()}`];
  } else {
    content = Style.body(formatInline(raw));
  }

  const wrapped = wrapAnsiLine(content, width - contPad);
  return wrapped.map((seg, i) =>
    i === 0
      ? `${gutter}${marker}${seg}`
      : `${gutter}${' '.repeat(contPad)}${seg}`
  );
}

// ─── Render Markdown (Full) ──────────────────────────────────────────────
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const blocks = text.split(/(```[\s\S]*?```)/g);
  const result: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] ?? '';
    if (block.startsWith('```')) {
      result.push(...renderCodeBlock(block));
    } else if (block.startsWith('|')) {
      const tableLines = renderTableBlock(block);
      for (const tl of tableLines) {
        result.push(`${Style.icon('┃')} ${tl}`);
      }
    } else {
      const paras = block.split('\n');
      for (let j = 0; j < paras.length; j++) {
        const p = paras[j] ?? '';
        if (!p.trim()) {
          if (j < paras.length - 1) result.push(`${Style.icon('┃')}`);
          continue;
        }
        result.push(...renderTextLine(p));
      }
    }
  }

  return result.join('\n');
}

// ─── Streaming Markdown Renderer ─────────────────────────────────────────
// Renders markdown incrementally as chunks arrive. Buffers only what it
// must: the current partial line, code fences (until closed), and tables
// (column widths need the full table). Everything else renders per-line.
export class MarkdownStreamRenderer {
  private buffer = '';
  private codeBlock: string[] | null = null;
  private tableLines: string[] | null = null;

  write(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.processLine(line);
    }
  }

  end(): void {
    if (this.buffer.trim()) this.processLine(this.buffer);
    this.buffer = '';
    this.flushTable();
    if (this.codeBlock) {
      // Unterminated code fence — flush as a code block anyway
      for (const l of renderCodeBlock([...this.codeBlock, '```'].join('\n'))) {
        process.stdout.write(`${l}\n`);
      }
      this.codeBlock = null;
    }
  }

  private processLine(line: string): void {
    // Inside a code block: buffer until closing fence
    if (this.codeBlock) {
      if (/^```\s*$/.test(line.trim())) {
        for (const l of renderCodeBlock([...this.codeBlock, '```'].join('\n'))) {
          process.stdout.write(`${l}\n`);
        }
        this.codeBlock = null;
      } else {
        this.codeBlock.push(line);
      }
      return;
    }

    // Opening a code block
    if (/^```/.test(line.trim())) {
      this.flushTable();
      this.codeBlock = [line];
      return;
    }

    // Table row
    if (line.trim().startsWith('|')) {
      (this.tableLines ??= []).push(line);
      return;
    }

    // Regular line — flush any pending table first
    this.flushTable();
    for (const l of renderTextLine(line)) {
      process.stdout.write(`${l}\n`);
    }
  }

  private flushTable(): void {
    if (!this.tableLines) return;
    for (const tl of renderTableBlock(this.tableLines.join('\n'))) {
      process.stdout.write(`${Style.icon('┃')} ${tl}\n`);
    }
    this.tableLines = null;
  }
}

// ─── Streaming text output ───────────────────────────────────────────────
export async function streamText(text: string, speed: number = 12): Promise<void> {
  const words = text.split(/(\s+)/);
  for (const word of words) {
    process.stdout.write(word);
    if (word.trim().length > 0) {
      await new Promise(r => setTimeout(r, speed));
    }
  }
  process.stdout.write('\n');
}

// ─── Spinner ─────────────────────────────────────────────────────────────
export function startSpinner(label: string, frames?: string[]): () => void {
  const f = frames ?? Style.spinnerFrames;
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${Style.icon(f[i++ % f.length])} ${THEME.dim(label)}  `);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write('\r\x1b[K');
  };
}

// ─── Welcome Screen ──────────────────────────────────────────────────────
// ─── ANSI Escape Code Sanitization ──────────────────────────────────────
// Strips ANSI escape sequences from AI-generated text to prevent
// terminal injection attacks (hiding output, fake prompts, etc.)
const ANSI_ESCAPE_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const ANSI_OTHER_RE = /\x1b[^@-_]*[@-_]/g;  // Catch any remaining escape sequences

export function sanitizeAnsi(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, '')
    .replace(ANSI_OTHER_RE, '')
    .replace(/\x00/g, '')  // Strip null bytes
    .replace(/\x1b/g, '[ESC]');  // Replace any remaining ESC with safe marker
}

export function renderWelcome(provider: string, model: string) {
  console.clear();
  const logo = `
  ██████  ███████ ███    ██ ████████ ██ ███    ██ ███████ ██      
 ██       ██      ████   ██    ██    ██ ████   ██ ██      ██      
  ██████  █████   ██ ██  ██    ██    ██ ██ ██  ██ █████   ██      
       ██ ██      ██  ██ ██    ██    ██ ██  ██ ██ ██      ██      
  ██████  ███████ ██   ████    ██    ██ ██   ████ ███████ ███████ `;

  process.stdout.write(Style.gradient(logo) + '\n');
  process.stdout.write(Style.dim(`  ${'─'.repeat(60)}  v2.1\n\n`));

  // Connection status
  const statusPanel = buildPanel('Connection', [
    `${Style.dim('Provider:')} ${Style.accent(provider.toUpperCase())}`,
    `${Style.dim('Model:   ')} ${Style.accent(model)}`,
  ]);
  for (const l of statusPanel) process.stdout.write(`  ${l}\n`);

  // Tips
  process.stdout.write('\n');
  const tipsPanel = buildPanel('Quick Start', [
    `${Style.accent('@file')}      ${Style.body('Attach file context')}`,
    `${Style.accent('Shift⏎')}     ${Style.body('New line in input')}`,
    `${Style.accent('Tab')}        ${Style.body('Autocomplete files/commands')}`,
    `${Style.accent('↑↓')}         ${Style.body('History navigation')}`,
    `${Style.accent('Ctrl+←→')}    ${Style.body('Word jump')}`,
    `${Style.accent('/help')}      ${Style.body('Show all commands')}`,
  ]);
  for (const l of tipsPanel) process.stdout.write(`  ${l}\n`);

  process.stdout.write('\n');
}

// ─── Status Bar ──────────────────────────────────────────────────────────
function truncateMiddle(t: string, max: number): string {
  if (max <= 0) return '';
  if (t.length <= max) return t;
  if (max <= 1) return '…';
  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return `${t.slice(0, left)}…${t.slice(t.length - right)}`;
}

export function buildStatusBar(model: string, tokens: number, trusted: boolean = false, costSummary?: string): string[] {
  const w = Math.max(40, process.stdout.columns || 80);
  const home = os.homedir();
  const rawCwd = process.cwd().replace(home, '~');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tok = tokens > 0 ? `ctx ${tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}` : 'ctx 0';
  const trustIcon = trusted ? chalk.hex(COLORS.green400)('🔓') : chalk.hex(COLORS.slate500)('🔒');
  const trustLabel = trusted ? Style.success(' Trusted') : Style.dim(' Locked');
  const costPart = costSummary ? ` ~${costSummary}` : '';
  const right = `${tok}${costPart} • ${time}  ${trustIcon}${trustLabel}`;
  const chromeW = 18 + right.length;
  const contentW = Math.max(18, w - chromeW);
  const cwdMax = Math.max(12, Math.min(26, Math.floor(contentW * 0.38)));
  const modelMax = Math.max(14, contentW - cwdMax);
  const cwd = truncateMiddle(rawCwd, cwdMax);
  const modelLabel = truncateMiddle(model, modelMax);
  const content = `${Style.icon('◈')} ${Style.header('CHAT')}${Style.dim(' │ ')}${Style.body(cwd)}${Style.dim(' │ ')}${Style.body(modelLabel)}${Style.dim(' │ ')}${Style.dim(right)}`;
  return [`${Style.border('─'.repeat(w))}`, content, `${Style.border('─'.repeat(w))}`];
}

// ─── Highlight Mentions ──────────────────────────────────────────────────
export function highlightMentions(text: string): string {
  const mentioned = new Set<string>();
  text = text.replace(AT_MENTION_RE, (_, p) => {
    mentioned.add(p);
    return chalk.hex(COLORS.green300)('@') + chalk.hex(COLORS.green300).underline(p);
  });
  text = text.replace(FILE_EXT_RE, m => {
    if (mentioned.has(m)) return m;
    return chalk.hex(COLORS.green300)(m);
  });
  return text;
}

// ─── Diff Viewer ─────────────────────────────────────────────────────────
export function renderDiff(diffText: string): string {
  if (!diffText || diffText === '(no changes)' || diffText === '(new file)') {
    return diffText === '(no changes)' ? Style.dim('(no changes)') : Style.accent('(new file)');
  }
  const lines = diffText.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      result.push(Style.dim(line));
    } else if (line.startsWith('+')) {
      result.push(chalk.hex(COLORS.green400)(line));
    } else if (line.startsWith('-')) {
      result.push(chalk.hex(COLORS.slate500)(line));
    } else if (line.startsWith('@@')) {
      result.push(chalk.hex(COLORS.info)(line));
    } else {
      result.push(Style.body(line));
    }
  }
  return result.join('\n');
}

// ─── Tool Execution Timeline ─────────────────────────────────────────────
export function renderToolTimeline(tools: Array<{ name: string; label: string; status: 'running' | 'done' | 'error' | 'skipped' }>): string {
  const w = Math.min(72, process.stdout.columns || 80);
  const lines: string[] = [Style.border(`╭─ Tool Execution ${'─'.repeat(Math.max(0, w - 18))}╮`)];
  for (const t of tools) {
    const icon = t.status === 'running' ? Style.spinnerFrames[0]
      : t.status === 'done' ? chalk.hex(COLORS.green400)('✔')
      : t.status === 'error' ? chalk.hex(COLORS.error)('✖')
      : Style.dim('—');
    const status = t.status === 'running' ? Style.dim('running…')
      : t.status === 'done' ? Style.dim('done')
      : t.status === 'error' ? Style.dim('error')
      : Style.dim('skipped');
    lines.push(`${Style.border('│')} ${icon} ${Style.accent(t.name)} ${Style.dim(t.label)} ${status}`);
  }
  lines.push(Style.border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
  return lines.join('\n');
}

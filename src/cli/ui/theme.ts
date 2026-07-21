import chalk from 'chalk';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

// ─── Color System ─────────────────────────────────────────────────────────
// A refined, modern palette: emerald greens on dark slate backgrounds
export const COLORS = {
  // Emerald brand
  green500: '#10b981',
  green400: '#34d399',
  green300: '#6ee7b7',
  green200: '#a7f3d0',

  // Slate neutrals
  slate950: '#020617',
  slate900: '#0f172a',
  slate850: '#111827',
  slate800: '#1e293b',
  slate750: '#243044',
  slate700: '#334155',
  slate600: '#475569',
  slate500: '#64748b',
  slate400: '#94a3b8',
  slate300: '#cbd5e1',
  slate200: '#e2e8f0',
  slate100: '#f1f5f9',
  slate50:  '#f8fafc',

  white: '#ffffff',

  // Semantic
  error:   '#ef4444',
  errorBg: '#450a0a',
  warning: '#f59e0b',
  warnBg:  '#451a03',
  info:    '#3b82f6',
  infoBg:  '#0c1929',
  success: '#22c55e',
  muted:   '#64748b',

  // Code syntax
  keyword:   '#c084fc',
  string:    '#fbbf24',
  number:    '#34d399',
  function:  '#60a5fa',
  comment:   '#4b5563',
  type:      '#67e8f9',
  variable:  '#e2e8f0',
  operator:  '#f472b6',
  tag:       '#fb923c',
  attr:      '#a78bfa',
  codeLine:  '#cbd5e1',
} as const;

// ─── Style Helpers ────────────────────────────────────────────────────────
const c = (hex: string) => chalk.hex(hex);
const bg = (hex: string) => chalk.bgHex(hex);

export const Style = {
  // Basic text
  header:   c(COLORS.white).bold,
  body:     c(COLORS.slate300),
  dim:      c(COLORS.slate500),
  accent:   c(COLORS.green400),
  strong:   c(COLORS.green300),
  muted:    c(COLORS.muted),
  error:    c(COLORS.error).bold,
  warning:  c(COLORS.warning).bold,
  info:     c(COLORS.info).bold,
  success:  c(COLORS.success).bold,

  // User input echo
  userText: c(COLORS.slate200),

  // Borders / structural
  border:   c(COLORS.slate700),
  borderDim: c(COLORS.slate600),
  bar:      (n = 1) => c(COLORS.slate700)('│'.repeat(n)),

  // Code / inline
  code:     bg(COLORS.slate850).hex(COLORS.slate200),
  codeBg:   bg(COLORS.slate900).hex(COLORS.slate200),
  codeLine: c(COLORS.slate300),

  // Icons
  icon:     c(COLORS.green500),

  // Semantic backgrounds
  errorBg:  bg(COLORS.errorBg).hex(COLORS.error),
  warnBg:   bg(COLORS.warnBg).hex(COLORS.warning),
  infoBg:   bg(COLORS.infoBg).hex(COLORS.info),

  // Labels / badges
  badge:    (text: string, color: string = COLORS.green500) =>
    chalk.bgHex(color).hex('#000')(` ${text} `),

  // Gradient text
  gradient: (text: string) => {
    const chars = text.split('');
    const colors = [COLORS.green400, COLORS.green300, COLORS.green200];
    return chars.map((ch, i) => c(colors[i % colors.length]!)(ch)).join('');
  },

  // Box / panel markers
  hSep:     (len = 60) => c(COLORS.slate700)('─'.repeat(len)),
  vSep:     c(COLORS.slate600)('│'),
  tlc:      c(COLORS.slate700)('╭'),
  trc:      c(COLORS.slate700)('╮'),
  blc:      c(COLORS.slate700)('╰'),
  brc:      c(COLORS.slate700)('╯'),
  tee:      c(COLORS.slate700)('├'),
  btee:     c(COLORS.slate700)('┤'),

  // Progress bar
  progressBar: (current: number, total: number, width: number = 20) => {
    const pct = Math.min(1, Math.max(0, current / total));
    const filled = Math.round(pct * width);
    const empty = width - filled;
    const bar = c(COLORS.green500)('▓'.repeat(filled)) + c(COLORS.slate750)('░'.repeat(empty));
    return `${bar} ${c(COLORS.slate400)(`${Math.round(pct * 100)}%`)}`;
  },

  // Spinner frames (circle animation — works on all terminals including Windows)
  spinnerFrames: ['○', '◔', '◐', '◕', '●', '◕', '◐', '◔'],

  // Line decorator
  prefixLines: (text: string, prefix: string) =>
    text.split('\n').map(l => `${prefix}${l}`).join('\n'),
} as const;

// ─── Convenience re-exports (backward compat) ──────────────────────────────
export const THEME = {
  header:   Style.header,
  dim:      Style.dim,
  body:     Style.body,
  accent:   Style.accent,
  userText: Style.userText,
  border:   Style.border,
  codeBg:   Style.codeBg,
  icon:     Style.icon,
};

// ─── Logo ─────────────────────────────────────────────────────────────────
export const sentinelLogo = `
  ██████  ███████ ███    ██ ████████ ██ ███    ██ ███████ ██      
 ██       ██      ████   ██    ██    ██ ████   ██ ██      ██      
  ██████  █████   ██ ██  ██    ██    ██ ██ ██  ██ █████   ██      
       ██ ██      ██  ██ ██    ██    ██ ██  ██ ██ ██      ██      
  ██████  ███████ ██   ████    ██    ██ ██   ████ ███████ ███████ 
`;

// ─── Panel builder ────────────────────────────────────────────────────────
export interface PanelOptions {
  title?: string;
  width?: number;
  padding?: number;
  borderColor?: (s: string) => string;
}

export function buildPanel(title: string, body: string[], opts: PanelOptions = {}): string[] {
  const w = opts.width ?? Math.min(72, process.stdout.columns ?? 80);
  const pad = opts.padding ?? 1;
  const bc = opts.borderColor ?? Style.border;
  const inner = w - 4 - pad * 2;
  const lines: string[] = [];

  const titleText = title ? ` ${title} ` : '';
  const leftPad = pad;
  lines.push(bc(`╭─${titleText}${Style.hSep(Math.max(1, inner - titleText.length + 2))}╮`));

  for (const line of body) {
    const visible = stripAnsi(line);
    const padLeft = ' '.repeat(leftPad);
    const padRight = ' '.repeat(Math.max(0, inner - visible.length - leftPad + 2));
    lines.push(`${bc('│')} ${padLeft}${line}${padRight}${bc('│')}`);
  }

  lines.push(bc(`╰${Style.hSep(inner + 2)}╯`));
  return lines;
}

// ─── Table builder ────────────────────────────────────────────────────────
export function buildTable(headers: string[], rows: string[][], opts: { headerColor?: (s: string) => string } = {}): string[] {
  const hc = opts.headerColor ?? Style.accent;
  if (rows.length === 0) return [];

  const colW = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map(r => stripAnsi(r[i] ?? '').length))
  );
  const sep = colW.map(w => '─'.repeat(w + 2)).join('┬');
  const lines: string[] = [];

  lines.push(`┌${sep}┐`);
  lines.push(`│ ${headers.map((h, i) => hc(h.padEnd(colW[i]!))).join(' │ ')} │`);
  lines.push(`├${colW.map(w => '─'.repeat(w + 2)).join('┼')}┤`);

  for (const row of rows) {
    lines.push(`│ ${row.map((c, i) => Style.body((c ?? '').padEnd(colW[i]!))).join(' │ ')} │`);
  }

  lines.push(`└${colW.map(w => '─'.repeat(w + 2)).join('┴')}┘`);
  return lines;
}

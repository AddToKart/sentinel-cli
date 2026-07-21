import fs from 'fs';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import figures from 'figures';
import { COLORS, Style, THEME } from './theme.js';
import { highlightMentions } from './rendering.js';

// ─── History ──────────────────────────────────────────────────────────────
const MAX_HISTORY = 200;
const inputHistory: string[] = [];
let historyIdx = -1;
let historyTempBuf = '';

// ─── ANSI Helpers ─────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string { return text.replace(ANSI_RE, ''); }
function visibleLen(text: string): number { return stripAnsi(text).length; }

// ─── Ignored dirs ────────────────────────────────────────────────────────
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', '.tmp-dist']);

export const SLASH_COMMANDS = [
  '/help',
  '/connect',
  '/providers',
  '/models',
  '/tools',
  '/stats',
  '/compact',
  '/planning',
  '/sandbox',
  '/trust',
  '/untrust',
  '/undo',
  '/save',
  '/export',
  '/load',
  '/init',
  '/clear',
  '/config',
  '/update',
  '/remember',
  '/forget',
  '/memories',
  '/exit',
  '/quit',
];

// ─── Command Suggestions ─────────────────────────────────────────────────
export function getCommandSuggestions(buffer: string): string[] {
  const trimmed = buffer.trimStart().toLowerCase();
  if (!/^\/[^\s]*$/.test(trimmed)) return [];
  const directMatches = trimmed === '/'
    ? SLASH_COMMANDS.slice()
    : SLASH_COMMANDS.filter(cmd => cmd.startsWith(trimmed));
  const fallback = directMatches.length === 0 && trimmed.length > 1
    ? SLASH_COMMANDS.filter(cmd => cmd.includes(trimmed.slice(1)))
    : [];
  return (directMatches.length > 0 ? directMatches : fallback).slice(0, 8);
}

// ─── Project Files ────────────────────────────────────────────────────────
const fileCache: { files: string[]; ts: number } = { files: [], ts: 0 };
const FILE_CACHE_TTL = 5_000;

export function getProjectFiles(rootDir: string = process.cwd()): string[] {
  if (fileCache.files.length > 0 && Date.now() - fileCache.ts < FILE_CACHE_TTL) return fileCache.files;
  const results: string[] = [];
  function walk(dir: string, prefix = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        walk(path.join(dir, entry.name), rel);
      } else {
        results.push(rel);
      }
    }
  }
  walk(rootDir);
  fileCache.files = results;
  fileCache.ts = Date.now();
  return results;
}

// ─── Input Sanitization ─────────────────────────────────────────────────
// Strips real ANSI SGR escapes AND residual SGR fragments (e.g. "4m" from a
// partially-consumed "\x1b[34m") that terminals like Warp can inject into
// the keypress stream — otherwise they fuse into @mention tokens.
function cleanUserInput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/@\[?[0-9;]*m(?=[\w./\\-])/g, '@');
}

// ─── Input State ─────────────────────────────────────────────────────────
interface InputState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  mentionStart: number;
  mentionQuery: string;
  mentionFiltered: string[];
  mentionSelectedIdx: number;
  commandFiltered: string[];
  commandSelectedIdx: number;
  selecting: boolean;
  hasRendered: boolean;
  inputHistory: string[];
  historyIdx: number;
  historyTempBuf: string;
}

// ─── Frame Builder ────────────────────────────────────────────────────────
function buildFrame(state: InputState, width: number, statusLines?: string[]): {
  display: string[];
  cursorLine: number;
  cursorCol: number;
} {
  const { lines, cursorLine, cursorCol, mentionStart, mentionFiltered, mentionSelectedIdx, commandFiltered, commandSelectedIdx } = state;
  const safeW = Math.max(60, width);
  const result: string[] = [];

  // Status bar
  if (statusLines && statusLines.length > 0) result.push(...statusLines);

  // Top border
  result.push(Style.border(`╭${'─'.repeat(safeW - 2)}╮`));

  // Input lines
  const prefix = `${Style.border('│')} ${Style.icon('▸')} `;
  const prefixLen = visibleLen(prefix);
  const inputW = safeW - prefixLen - 2;

  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    result.push(`${prefix}${THEME.dim('Type a message, @file, or /command…')}`);
  } else {
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      // Split long lines visually
      if (stripAnsi(raw).length > inputW) {
        for (let j = 0; j < raw.length; j += inputW) {
          const chunk = raw.slice(j, j + inputW);
          result.push(`${i === 0 ? prefix : `${Style.border('│')} ${' '.repeat(prefixLen - 2)}`}${chunk}`);
        }
      } else {
        result.push(`${i === 0 ? prefix : `${Style.border('│')} ${' '.repeat(prefixLen - 2)}`}${raw}`);
      }
    }
  }

  // Bottom border
  result.push(Style.border(`╰${'─'.repeat(safeW - 2)}╯`));

  // Help bar
  const helpItems = [
    'Enter submit',
    'S-Enter newline',
    '↑↓ history',
    'Tab complete',
    'Esc dismiss',
  ];
  result.push(Style.dim(`  ${helpItems.map(h => `◈ ${h}`).join('  ')}`));

  // Suggestions
  const showCmds = commandFiltered.length > 0;
  const showFiles = !showCmds && mentionStart >= 0 && mentionFiltered.length > 0;

  if (showCmds) {
    for (let i = 0; i < commandFiltered.length; i++) {
      const cmd = commandFiltered[i] ?? '';
      const sel = i === commandSelectedIdx;
      const label = sel
        ? chalk.bgHex(COLORS.slate750)(`${Style.accent(` ${figures.play} `)}${chalk.hex(COLORS.slate100)(cmd)}`)
        : Style.dim(`   ${cmd}`);
      result.push(`${Style.dim(' ⌘ ')}${label}`);
    }
  } else if (showFiles) {
    for (let i = 0; i < mentionFiltered.length; i++) {
      const file = mentionFiltered[i] ?? '';
      const sel = i === mentionSelectedIdx;
      const icon = file.endsWith('/') ? chalk.yellow('📁') : Style.dim('📄');
      const label = sel
        ? chalk.bgHex(COLORS.slate750)(`${Style.accent(` ${figures.play} `)}${chalk.hex(COLORS.slate100)(file)}`)
        : Style.dim(`   ${file}`);
      result.push(` ${icon} ${label}`);
    }
  }

  // Calculate cursor position
  let absCursorLine = cursorLine;
  let absCursorCol = cursorCol + prefixLen; // prefix "│ ▸ " is prefixLen visible chars
  const visiblePrefix = stripAnsi(prefix);
  // Account for line wrapping
  let lineWraps = 0;
  for (let i = 0; i < cursorLine; i++) {
    const raw = lines[i] ?? '';
    lineWraps += Math.max(0, Math.floor(stripAnsi(raw).length / inputW));
  }
  absCursorLine += lineWraps + (statusLines?.length ?? 0) + 1; // +1 for top border

  return { display: result, cursorLine: absCursorLine, cursorCol: absCursorCol };
}

// ─── Test Helper: Frame Builder ──────────────────────────────────────────
export interface SmartInputFrameOptions {
  width: number;
  buffer: string;
  statusLines?: string[];
  mentionStart?: number;
  mentionFiltered?: string[];
  mentionSelectedIdx?: number;
  commandFiltered?: string[];
  commandSelectedIdx?: number;
}

export function buildSmartInputFrame(opts: SmartInputFrameOptions) {
  const lines = opts.buffer.split('\n');
  const state: InputState = {
    lines,
    cursorLine: lines.length - 1,
    cursorCol: (lines[lines.length - 1] ?? '').length,
    mentionStart: opts.mentionStart ?? -1,
    mentionQuery: '',
    mentionFiltered: opts.mentionFiltered ?? [],
    mentionSelectedIdx: opts.mentionSelectedIdx ?? 0,
    commandFiltered: opts.commandFiltered ?? [],
    commandSelectedIdx: opts.commandSelectedIdx ?? 0,
    selecting: false,
    hasRendered: false,
    inputHistory: [],
    historyIdx: -1,
    historyTempBuf: '',
  };

  const statusLines = opts.statusLines ?? [];
  const frame = buildFrame(state, opts.width, statusLines);
  const statusCount = statusLines.length;
  const inputRowIndex = statusCount + 1;
  const rowsBelowInput = frame.display.length - inputRowIndex - 1;

  return {
    lines: frame.display,
    inputRowIndex,
    rowsBelowInput,
    cursorColumn: frame.cursorCol,
    cursorLine: frame.cursorLine,
  };
}

// ─── Main Input Function ─────────────────────────────────────────────────
export async function smartInput(statusLines?: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const allFiles = getProjectFiles();
    let hasRendered = false;
    let lastCursorLine = 0;

    const state: InputState = {
      lines: [''],
      cursorLine: 0,
      cursorCol: 0,
      mentionStart: -1,
      mentionQuery: '',
      mentionFiltered: [],
      mentionSelectedIdx: 0,
      commandFiltered: [],
      commandSelectedIdx: 0,
      selecting: false,
      hasRendered: false,
      inputHistory: [...inputHistory],
      historyIdx: -1,
      historyTempBuf: '',
    };

    function currentLine(): string { return state.lines[state.cursorLine] ?? ''; }
    function setLine(v: string) { state.lines[state.cursorLine] = v; }
    function cursorInMention(): boolean {
      if (state.mentionStart < 0) return false;
      return state.cursorLine === 0 && state.cursorCol >= state.mentionStart;
    }

    function filterFiles() {
      const q = state.mentionQuery.toLowerCase();
      state.mentionFiltered = allFiles
        .filter(f => !q || f.toLowerCase().includes(q))
        .slice(0, 8);
      state.mentionSelectedIdx = Math.min(state.mentionSelectedIdx, Math.max(0, state.mentionFiltered.length - 1));
    }

    function updateCommandSuggestions() {
      const buf = state.lines.join('\n');
      state.commandFiltered = getCommandSuggestions(buf);
      state.commandSelectedIdx = Math.min(state.commandSelectedIdx, Math.max(0, state.commandFiltered.length - 1));
    }

    function applyCommandSuggestion(): boolean {
      const sel = state.commandFiltered[state.commandSelectedIdx];
      if (!sel) return false;
      state.lines = [sel + ' '];
      state.cursorLine = 0;
      state.cursorCol = sel.length + 1;
      state.commandFiltered = [];
      state.commandSelectedIdx = 0;
      return true;
    }

    function applyMentionSuggestion(): boolean {
      const sel = state.mentionFiltered[state.mentionSelectedIdx];
      if (!sel || state.mentionStart < 0) return false;
      const line = state.lines[0] ?? '';
      const after = sel.endsWith('/') ? '' : ' ';
      state.lines[0] = `${line.slice(0, state.mentionStart)}@${sel}${after}`;
      state.cursorCol = state.lines[0].length;
      state.mentionStart = -1;
      state.mentionQuery = '';
      state.mentionFiltered = [];
      state.mentionSelectedIdx = 0;
      return true;
    }

    function getFullBuffer(): string {
      return state.lines.join('\n');
    }

    /**
     * Calculate how many terminal lines the display array occupies.
     * Each display entry is 1 line. We add 1 for the final cursor row.
     */
    function displayHeight(display: string[]): number {
      return display.length + 1; // +1 for cursor row below display
    }

    // Track the previous frame's cursor offset from frame start for clear/rewrite
    let prevCursorOffset = 0;
    let hasFrame = false;

    function render() {
      updateCommandSuggestions();
      const w = process.stdout.columns || 80;
      const { display, cursorLine: absCursorLine, cursorCol: absCursorCol } = buildFrame(state, w, statusLines);

      process.stdout.write('\x1b[?25l');

      if (hasFrame) {
        // Move up from current cursor position to the start of the previous frame,
        // then clear from there to end of screen.
        process.stdout.write(`\x1b[${prevCursorOffset}A`);
        process.stdout.write('\r');
        process.stdout.write('\x1b[J');
      }

      // Save the cursor offset for next render's clear
      prevCursorOffset = absCursorLine;
      hasFrame = true;

      // Write the full frame
      for (let i = 0; i < display.length; i++) {
        if (i > 0) process.stdout.write('\n');
        process.stdout.write(display[i]!);
      }

      // Position cursor inside the frame at the input line.
      // After writing the frame, cursor is at end of last display line.
      // First move up to the input line row.
      const linesUp = (display.length - 1) - absCursorLine;
      if (linesUp > 0) {
        process.stdout.write(`\x1b[${linesUp}A`);
      }
      // Cursor kept the column from the end of the last line — reset to column 1.
      process.stdout.write('\r');
      // Now move right to the text column: prefix "│ ▸ " is prefixLen visible chars
      if (absCursorCol > 0) {
        process.stdout.write(`\x1b[${absCursorCol}C`);
      }
      process.stdout.write('\x1b[?25h');
    }

    function done(value: string) {
      process.stdout.write('\x1b[?25h');
      if (hasFrame) {
        // Clear the ENTIRE frame (status bar + input area) so nothing
        // gets left behind in the conversation history.
        process.stdout.write(`\x1b[${prevCursorOffset}A`);
        process.stdout.write('\r');
        process.stdout.write('\x1b[J');
        hasFrame = false;
      }
      process.stdin.removeListener('keypress', keypressHandler);

      // Strip any ANSI residue the terminal may have injected into the buffer
      value = cleanUserInput(value);

      if (value.trim()) {
        const w = Math.max(54, process.stdout.columns || 80);
        const preview = value.length > 100 ? value.slice(0, 100) + '…' : value;
        const oneLine = preview.replace(/\n/g, '↵ ');
        process.stdout.write(
          `${Style.icon('◆ ')}${Style.header('You')}${Style.dim(' › ')}${Style.userText(highlightMentions(oneLine))}\n`
        );
        process.stdout.write(`${Style.border('─'.repeat(w))}\n`);
      }
      resolve(value);
    }

    // ─── Key Handling ─────────────────────────────────────────────────
    const keypressHandler = (_str: string, key: any) => {
      if (!key) return;

      // Ctrl+C
      if (key.ctrl && key.name === 'c') {
        done('');
        process.exit(0);
        return;
      }

      // Ctrl+D - exit if buffer is empty
      if (key.ctrl && key.name === 'd') {
        if (!getFullBuffer().trim()) {
          done('');
          process.exit(0);
        }
        return;
      }

      // Enter
      if (key.name === 'return' || key.name === 'enter') {
        // Shift+Enter = newline
        if (key.shift) {
          state.lines.splice(state.cursorLine + 1, 0, '');
          state.cursorLine += 1;
          state.cursorCol = 0;
          state.mentionStart = -1;
          render();
          return;
        }

        // Tab complete on enter if suggestions active
        if (state.commandFiltered.length > 0 && applyCommandSuggestion()) {
          render();
          return;
        }
        if (state.mentionStart >= 0 && state.mentionFiltered.length > 0 && applyMentionSuggestion()) {
          render();
          return;
        }

        const full = getFullBuffer();
        if (full.trim() && full !== inputHistory[inputHistory.length - 1]) {
          inputHistory.push(full);
          if (inputHistory.length > MAX_HISTORY) inputHistory.splice(0, inputHistory.length - MAX_HISTORY);
        }
        state.historyIdx = -1;
        state.historyTempBuf = '';
        done(full);
        return;
      }

      // Tab
      if (key.name === 'tab') {
        if (state.commandFiltered.length > 0 && applyCommandSuggestion()) { render(); return; }
        if (state.mentionStart >= 0 && state.mentionFiltered.length > 0 && applyMentionSuggestion()) { render(); return; }
        return;
      }

      // Escape
      if (key.name === 'escape') {
        state.mentionStart = -1;
        state.mentionQuery = '';
        state.mentionFiltered = [];
        state.mentionSelectedIdx = 0;
        state.commandFiltered = [];
        state.commandSelectedIdx = 0;
        render();
        return;
      }

      // Up
      if (key.name === 'up') {
        if (state.commandFiltered.length > 0) {
          state.commandSelectedIdx = state.commandSelectedIdx > 0 ? state.commandSelectedIdx - 1 : state.commandFiltered.length - 1;
        } else if (state.mentionStart >= 0 && state.mentionFiltered.length > 0) {
          state.mentionSelectedIdx = state.mentionSelectedIdx > 0 ? state.mentionSelectedIdx - 1 : state.mentionFiltered.length - 1;
        } else if (state.cursorLine > 0) {
          // Move cursor up within multi-line
          state.cursorLine -= 1;
          const aboveLen = stripAnsi(state.lines[state.cursorLine] ?? '').length;
          state.cursorCol = Math.min(state.cursorCol, aboveLen);
        } else if (state.inputHistory.length > 0) {
          // History navigation
          if (state.historyIdx === -1) {
            state.historyTempBuf = getFullBuffer();
            state.historyIdx = state.inputHistory.length - 1;
          } else if (state.historyIdx > 0) {
            state.historyIdx -= 1;
          }
          const hist = state.inputHistory[state.historyIdx];
          if (hist !== undefined) {
            state.lines = hist.split('\n');
            state.cursorLine = state.lines.length - 1;
            state.cursorCol = stripAnsi(state.lines[state.cursorLine] ?? '').length;
          }
        }
        render();
        return;
      }

      // Down
      if (key.name === 'down') {
        if (state.commandFiltered.length > 0) {
          state.commandSelectedIdx = state.commandSelectedIdx < state.commandFiltered.length - 1 ? state.commandSelectedIdx + 1 : 0;
        } else if (state.mentionStart >= 0 && state.mentionFiltered.length > 0) {
          state.mentionSelectedIdx = state.mentionSelectedIdx < state.mentionFiltered.length - 1 ? state.mentionSelectedIdx + 1 : 0;
        } else if (state.cursorLine < state.lines.length - 1) {
          state.cursorLine += 1;
          const belowLen = stripAnsi(state.lines[state.cursorLine] ?? '').length;
          state.cursorCol = Math.min(state.cursorCol, belowLen);
        } else if (state.historyIdx !== -1) {
          state.historyIdx += 1;
          if (state.historyIdx >= state.inputHistory.length) {
            state.historyIdx = -1;
            state.lines = [state.historyTempBuf];
            state.cursorLine = 0;
            state.cursorCol = state.lines[0]?.length ?? 0;
          } else {
            const hist = state.inputHistory[state.historyIdx];
            if (hist !== undefined) {
              state.lines = hist.split('\n');
              state.cursorLine = state.lines.length - 1;
              state.cursorCol = stripAnsi(state.lines[state.cursorLine] ?? '').length;
            }
          }
        }
        render();
        return;
      }

      // Left
      if (key.name === 'left') {
        if (key.ctrl) {
          // Word left
          const line = currentLine();
          let pos = state.cursorCol - 1;
          while (pos > 0 && line[pos] === ' ') pos--;
          while (pos > 0 && line[pos - 1] !== ' ') pos--;
          state.cursorCol = pos;
        } else if (state.cursorCol > 0) {
          state.cursorCol -= 1;
        } else if (state.cursorLine > 0) {
          state.cursorLine -= 1;
          state.cursorCol = stripAnsi(state.lines[state.cursorLine] ?? '').length;
        }
        // Cursor moved at/before the @ — exit mention state
        if (state.mentionStart >= 0 && state.cursorCol <= state.mentionStart) {
          state.mentionStart = -1;
          state.mentionQuery = '';
          state.mentionFiltered = [];
        }
        render();
        return;
      }

      // Right
      if (key.name === 'right') {
        const lineLen = stripAnsi(currentLine()).length;
        if (key.ctrl) {
          // Word right
          const line = currentLine();
          let pos = state.cursorCol;
          while (pos < line.length && line[pos] === ' ') pos++;
          while (pos < line.length && line[pos] !== ' ') pos++;
          state.cursorCol = pos;
        } else if (state.cursorCol < lineLen) {
          state.cursorCol += 1;
        } else if (state.cursorLine < state.lines.length - 1) {
          state.cursorLine += 1;
          state.cursorCol = 0;
        }
        render();
        return;
      }

      // Home
      if (key.name === 'home') {
        state.cursorCol = 0;
        render();
        return;
      }

      // End
      if (key.name === 'end') {
        state.cursorCol = stripAnsi(currentLine()).length;
        render();
        return;
      }

      // Delete (fn+backspace or delete key)
      if (key.name === 'delete') {
        const line = currentLine();
        if (state.cursorCol < line.length) {
          setLine(line.slice(0, state.cursorCol) + line.slice(state.cursorCol + 1));
        } else if (state.cursorLine < state.lines.length - 1) {
          // Join with next line
          const next = state.lines[state.cursorLine + 1] ?? '';
          setLine(line + next);
          state.lines.splice(state.cursorLine + 1, 1);
        }
        render();
        return;
      }

      // Backspace
      if (key.name === 'backspace') {
        if (state.cursorCol > 0) {
          const line = currentLine();
          const before = state.cursorCol - 1;
          setLine(line.slice(0, before) + line.slice(state.cursorCol));
          state.cursorCol = before;
          // Update mention tracking
          if (state.mentionStart >= 0) {
            // Cursor at or before the @ position means the @ itself was
            // deleted (or the cursor backed past it) — exit mention state.
            if (state.cursorCol <= state.mentionStart) {
              state.mentionStart = -1;
              state.mentionQuery = '';
              state.mentionFiltered = [];
            } else {
              state.mentionQuery = (state.lines[0] ?? '').slice(state.mentionStart + 1, state.cursorCol);
              filterFiles();
            }
          }
        } else if (state.cursorLine > 0) {
          // Join with previous line
          const prevLine = state.lines[state.cursorLine - 1] ?? '';
          const curLine = currentLine();
          const prevLen = stripAnsi(prevLine).length;
          state.lines[state.cursorLine - 1] = prevLine + curLine;
          state.lines.splice(state.cursorLine, 1);
          state.cursorLine -= 1;
          state.cursorCol = prevLen;
        }
        render();
        return;
      }

      // Insert character
      const ch: string = _str ?? '';
      if (!ch || ch.length !== 1 || key.ctrl || key.meta || key.alt) return;

      const line = currentLine();
      setLine(line.slice(0, state.cursorCol) + ch + line.slice(state.cursorCol));
      state.cursorCol += 1;

      // Track @mentions
      if (ch === '@' && state.cursorLine === 0) {
        state.mentionStart = state.cursorCol - 1;
        state.mentionQuery = '';
        filterFiles();
      } else if (state.mentionStart >= 0 && state.cursorLine === 0) {
        if (ch === ' ') {
          state.mentionStart = -1;
          state.mentionQuery = '';
          state.mentionFiltered = [];
        } else {
          state.mentionQuery = (state.lines[0] ?? '').slice(state.mentionStart + 1, state.cursorCol);
          filterFiles();
        }
      }

      render();
    };

    process.stdin.on('keypress', keypressHandler);
    render();
  });
}

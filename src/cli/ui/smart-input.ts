import fs from 'fs';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import figures from 'figures';
import { COLORS, THEME } from './theme.js';
import { highlightMentions } from './rendering.js';

const inputHistory: string[] = [];
let historyIdx = -1;
let historyTempBuf = '';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage']);
export const SLASH_COMMANDS = [
  '/help',
  '/models',
  '/tools',
  '/stats',
  '/compact',
  '/planning',
  '/save',
  '/init',
  '/clear',
  '/exit',
  '/quit',
];

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function truncateLeft(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return '…';
  return `…${text.slice(text.length - max + 1)}`;
}

function truncateRight(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

export function getCommandSuggestions(buffer: string, commands: string[] = SLASH_COMMANDS): string[] {
  const trimmed = buffer.trimStart().toLowerCase();
  if (!/^\/[^\s]*$/.test(trimmed)) return [];

  const directMatches = trimmed === '/'
    ? commands.slice()
    : commands.filter((cmd) => cmd.startsWith(trimmed));
  const fallbackMatches = directMatches.length === 0 && trimmed.length > 1
    ? commands.filter((cmd) => cmd.includes(trimmed.slice(1)))
    : [];

  return (directMatches.length > 0 ? directMatches : fallbackMatches).slice(0, 6);
}

export function getProjectFiles(rootDir: string = process.cwd()): string[] {
  const results: string[] = [];

  function walk(dir: string, prefix = '') {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

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
  return results;
}

export interface SmartInputFrameParams {
  width: number;
  buffer: string;
  statusLines: string[] | undefined;
  placeholder?: string;
  mentionStart: number;
  mentionFiltered: string[];
  mentionSelectedIdx: number;
  commandFiltered: string[];
  commandSelectedIdx: number;
}

export function buildSmartInputFrame(params: SmartInputFrameParams) {
  const {
    width,
    buffer,
    statusLines,
    placeholder = THEME.dim('Type your message, @path/to/file, or /command...'),
    mentionStart,
    mentionFiltered,
    mentionSelectedIdx,
    commandFiltered,
    commandSelectedIdx,
  } = params;

  const safeWidth = Math.max(54, width || 80);
  const promptPrefix = `${THEME.border('│')} ${THEME.accent(figures.pointerSmall)} `;
  const promptWidth = Math.max(12, safeWidth - visibleLength(promptPrefix) - 3);
  const preview = buffer ? truncateLeft(buffer, promptWidth) : '';
  const display = buffer ? THEME.userText(highlightMentions(preview)) : placeholder;
  const cursorColumn = visibleLength(promptPrefix) + visibleLength(preview);
  const showCommandSuggestions = commandFiltered.length > 0;
  const showMentionSuggestions = !showCommandSuggestions && mentionStart >= 0 && mentionFiltered.length > 0;
  const lines: string[] = [];

  if (statusLines && statusLines.length > 0) {
    lines.push(...statusLines);
  }

  lines.push(THEME.border(`╭${'─'.repeat(Math.max(0, safeWidth - 2))}╮`));
  lines.push(`${promptPrefix}${display}`);
  lines.push(THEME.border(`╰${'─'.repeat(Math.max(0, safeWidth - 2))}╯`));
  lines.push(THEME.dim(`  ${figures.arrowUp}/${figures.arrowDown} history  Tab autocomplete  Enter submit  Esc dismiss`));

  if (showCommandSuggestions) {
    const suggestionWidth = Math.max(16, safeWidth - 12);
    for (let i = 0; i < commandFiltered.length; i++) {
      const command = commandFiltered[i] ?? '';
      const selected = i === commandSelectedIdx;
      const label = truncateRight(command, suggestionWidth);
      const line = selected
        ? chalk.bgHex(COLORS.slate800)(`${THEME.accent(` ${figures.play} `)}${chalk.hex(COLORS.slate100)(label)}`)
        : THEME.dim(`   ${label}`);
      lines.push(`${THEME.dim(' ⌘ ')}${line}`);
    }
  } else if (showMentionSuggestions) {
    const suggestionWidth = Math.max(16, safeWidth - 14);
    for (let i = 0; i < mentionFiltered.length; i++) {
      const file = mentionFiltered[i] ?? '';
      const selected = i === mentionSelectedIdx;
      const icon = file.endsWith('/') ? chalk.yellow('dir') : THEME.dim('file');
      const label = truncateRight(file, suggestionWidth);
      const line = selected
        ? chalk.bgHex(COLORS.slate800)(`${THEME.accent(` ${figures.play} `)}${chalk.hex(COLORS.slate100)(label)}`)
        : THEME.dim(`   ${label}`);
      lines.push(` ${icon} ${line}`);
    }
  }

  const inputRowIndex = (statusLines?.length ?? 0) + 1;
  const rowsBelowInput = lines.length - 1 - inputRowIndex;
  return { lines, cursorColumn, inputRowIndex, rowsBelowInput };
}

export async function smartInput(statusLines?: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = '';
    let mentionStart = -1;
    let mentionQuery = '';
    let mentionSelectedIdx = 0;
    let mentionFiltered: string[] = [];
    let commandSelectedIdx = 0;
    let commandFiltered: string[] = [];
    let lastTopOffset = 0;
    let hasRendered = false;

    const allFiles = getProjectFiles();
    const placeholder = THEME.dim('Type your message, @path/to/file, or /command...');

    readline.emitKeypressEvents(process.stdin);

    function clearRender() {
      if (hasRendered && lastTopOffset > 0) {
        process.stdout.write(`\x1b[${lastTopOffset}A`);
      }
      process.stdout.write('\r\x1b[J');
      hasRendered = false;
      lastTopOffset = 0;
    }

    function filterFiles() {
      const query = mentionQuery.toLowerCase();
      mentionFiltered = allFiles
        .filter((file) => !query || file.toLowerCase().includes(query))
        .slice(0, 6);
      mentionSelectedIdx = Math.min(mentionSelectedIdx, Math.max(0, mentionFiltered.length - 1));
    }

    function updateCommandSuggestions() {
      commandFiltered = getCommandSuggestions(buf, SLASH_COMMANDS);
      commandSelectedIdx = Math.min(commandSelectedIdx, Math.max(0, commandFiltered.length - 1));
    }

    function applyCommandSuggestion(): boolean {
      const selected = commandFiltered[commandSelectedIdx];
      if (!selected) return false;

      const trimmed = buf.trimStart();
      const leading = buf.slice(0, buf.length - trimmed.length);
      const nextValue = `${leading}${selected}`;
      if (nextValue === buf) return false;

      buf = nextValue;
      commandFiltered = [];
      commandSelectedIdx = 0;
      return true;
    }

    function applyMentionSuggestion(): boolean {
      const selected = mentionFiltered[mentionSelectedIdx];
      if (!selected || mentionStart < 0) return false;

      buf = `${buf.slice(0, mentionStart)}@${selected}${selected.endsWith('/') ? '' : ' '}`;
      mentionStart = -1;
      mentionQuery = '';
      mentionFiltered = [];
      mentionSelectedIdx = 0;
      return true;
    }

    function render() {
      updateCommandSuggestions();
      const { lines, cursorColumn, inputRowIndex, rowsBelowInput } = buildSmartInputFrame({
        width: process.stdout.columns || 80,
        buffer: buf,
        statusLines,
        placeholder,
        mentionStart,
        mentionFiltered,
        mentionSelectedIdx,
        commandFiltered,
        commandSelectedIdx,
      });

      process.stdout.write('\x1b[?25l');
      clearRender();
      process.stdout.write(lines.join('\n\r'));

      if (rowsBelowInput > 0) {
        process.stdout.write(`\x1b[${rowsBelowInput}A`);
      }

      process.stdout.write('\r');
      if (cursorColumn > 0) {
        process.stdout.write(`\x1b[${cursorColumn}C`);
      }
      process.stdout.write('\x1b[?25h');

      hasRendered = true;
      lastTopOffset = inputRowIndex;
    }

    function done(value: string) {
      process.stdout.write('\x1b[?25h');
      clearRender();
      process.stdin.removeListener('keypress', keypressHandler);

      if (value.trim()) {
        const width = Math.max(54, process.stdout.columns || 80);
        const echoed = truncateRight(value, Math.max(12, width - 12));
        process.stdout.write(
          `${THEME.icon('◆ ')}${THEME.header('You')}${THEME.dim(' › ')}${THEME.userText(highlightMentions(echoed))}\n`
        );
        process.stdout.write(`${THEME.border('─'.repeat(width))}\n`);
      }

      resolve(value);
    }

    const keypressHandler = (_str: string, key: any) => {
      if (!key) return;

      if (key.ctrl && key.name === 'c') {
        done('');
        process.exit(0);
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (commandFiltered.length > 0 && applyCommandSuggestion()) {
          render();
          return;
        }

        if (mentionStart >= 0 && mentionFiltered.length > 0 && applyMentionSuggestion()) {
          render();
          return;
        }

        if (buf.trim() && buf !== inputHistory[inputHistory.length - 1]) {
          inputHistory.push(buf);
        }

        historyIdx = -1;
        historyTempBuf = '';
        done(buf);
        return;
      }

      if (key.name === 'tab') {
        if (commandFiltered.length > 0 && applyCommandSuggestion()) {
          render();
          return;
        }

        if (mentionStart >= 0 && mentionFiltered.length > 0 && applyMentionSuggestion()) {
          render();
        }
        return;
      }

      if (key.name === 'escape') {
        mentionStart = -1;
        mentionQuery = '';
        mentionFiltered = [];
        mentionSelectedIdx = 0;
        commandFiltered = [];
        commandSelectedIdx = 0;
        render();
        return;
      }

      if (key.name === 'up') {
        if (commandFiltered.length > 0) {
          commandSelectedIdx = commandSelectedIdx > 0 ? commandSelectedIdx - 1 : commandFiltered.length - 1;
        } else if (mentionStart >= 0 && mentionFiltered.length > 0) {
          mentionSelectedIdx = mentionSelectedIdx > 0 ? mentionSelectedIdx - 1 : mentionFiltered.length - 1;
        } else if (inputHistory.length > 0) {
          if (historyIdx === -1) {
            historyTempBuf = buf;
            historyIdx = inputHistory.length - 1;
          } else if (historyIdx > 0) {
            historyIdx -= 1;
          }
          buf = inputHistory[historyIdx] ?? buf;
        }
        render();
        return;
      }

      if (key.name === 'down') {
        if (commandFiltered.length > 0) {
          commandSelectedIdx = commandSelectedIdx < commandFiltered.length - 1 ? commandSelectedIdx + 1 : 0;
        } else if (mentionStart >= 0 && mentionFiltered.length > 0) {
          mentionSelectedIdx = mentionSelectedIdx < mentionFiltered.length - 1 ? mentionSelectedIdx + 1 : 0;
        } else if (historyIdx !== -1) {
          historyIdx += 1;
          if (historyIdx >= inputHistory.length) {
            historyIdx = -1;
            buf = historyTempBuf;
          } else {
            buf = inputHistory[historyIdx] ?? buf;
          }
        }
        render();
        return;
      }

      if (key.name === 'backspace') {
        if (buf.length === 0) return;

        buf = buf.slice(0, -1);
        if (mentionStart >= 0) {
          if (buf.length <= mentionStart || buf[mentionStart] !== '@') {
            mentionStart = -1;
            mentionQuery = '';
            mentionFiltered = [];
          } else {
            mentionQuery = buf.slice(mentionStart + 1);
            filterFiles();
          }
        }
        render();
        return;
      }

      const ch: string = _str ?? '';
      if (!ch || ch.length !== 1 || key.ctrl || key.meta) return;

      buf += ch;
      if (ch === '@') {
        mentionStart = buf.length - 1;
        mentionQuery = '';
        filterFiles();
      } else if (mentionStart >= 0) {
        if (ch === ' ') {
          mentionStart = -1;
          mentionQuery = '';
          mentionFiltered = [];
        } else {
          mentionQuery = buf.slice(mentionStart + 1);
          filterFiles();
        }
      }

      render();
    };

    process.stdin.on('keypress', keypressHandler);
    render();
  });
}

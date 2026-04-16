import fs from 'fs';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { G } from './theme.js';
import { highlightMentions } from './rendering.js';

const inputHistory: string[] = [];
let historyIdx = -1;
let historyTempBuf = '';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage']);
const SLASH_COMMANDS = [
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

function getProjectFiles(): string[] {
  const results: string[] = [];
  function walk(dir: string, prefix = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(rel + '/');
        walk(path.join(dir, entry.name), rel);
      } else {
        results.push(rel);
      }
    }
  }
  walk(process.cwd());
  return results;
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
    const STATUS_LINES = statusLines?.length ?? 0;
    const allFiles = getProjectFiles();
    const PLACEHOLDER = chalk.dim('Type your message, @path/to/file, or /command…');
    const PREFIX = chalk.hex(G)(' ❯ ');

    readline.emitKeypressEvents(process.stdin);

    function filterFiles() {
      const q = mentionQuery.toLowerCase();
      mentionFiltered = allFiles.filter(f => !q || f.toLowerCase().includes(q)).slice(0, 9);
      mentionSelectedIdx = Math.min(mentionSelectedIdx, Math.max(0, mentionFiltered.length - 1));
    }

    function updateCommandSuggestions() {
      const trimmed = buf.trimStart();
      if (!/^\/[^\s]*$/.test(trimmed)) {
        commandFiltered = [];
        commandSelectedIdx = 0;
        return;
      }
      const token = trimmed.toLowerCase();
      commandFiltered = token === '/'
        ? SLASH_COMMANDS.slice()
        : SLASH_COMMANDS.filter(cmd => cmd.startsWith(token));
      if (commandFiltered.length === 0 && token.length > 1) {
        commandFiltered = SLASH_COMMANDS.filter(cmd => cmd.includes(token.slice(1)));
      }
      commandSelectedIdx = Math.min(commandSelectedIdx, Math.max(0, commandFiltered.length - 1));
    }

    function isCommandSuggesting(): boolean {
      updateCommandSuggestions();
      return commandFiltered.length > 0;
    }

    function applyCommandSuggestion(submit: boolean): boolean {
      if (!isCommandSuggesting()) return false;
      const selected = commandFiltered[commandSelectedIdx] ?? commandFiltered[0];
      if (!selected) return false;
      const trimmed = buf.trimStart();
      const leadingSpaces = buf.slice(0, buf.length - trimmed.length);
      const nextValue = leadingSpaces + selected;
      if (submit) {
        if (nextValue.trim() && nextValue !== inputHistory[inputHistory.length - 1]) {
          inputHistory.push(nextValue);
        }
        historyIdx = -1;
        historyTempBuf = '';
        done(nextValue);
      } else {
        buf = nextValue;
      }
      return true;
    }

    function render() {
      updateCommandSuggestions();
      const showCommandSuggestions = commandFiltered.length > 0;
      const showMentionSuggestions = !showCommandSuggestions && mentionStart >= 0 && mentionFiltered.length > 0;

      process.stdout.write('\x1b[?25l');
      process.stdout.write('\r\x1b[J');
      process.stdout.write(PREFIX);
      if (buf) {
        process.stdout.write(highlightMentions(buf));
      } else {
        process.stdout.write(PLACEHOLDER);
      }

      let targetColumn = PREFIX.replace(/\x1B\[[0-9;]*m/gi, '').length + buf.length;
      if (!buf) {
        targetColumn = PREFIX.replace(/\x1B\[[0-9;]*m/gi, '').length;
      }

      let linesPrinted = 0;
      if (showCommandSuggestions) {
        for (let i = 0; i < commandFiltered.length; i++) {
          const cmd = commandFiltered[i] ?? '';
          if (!cmd) continue;
          const isSelected = i === commandSelectedIdx;
          const label = isSelected
            ? chalk.bgHex('#1a2a3a')(chalk.cyan.bold(' ❯ ') + chalk.cyan(cmd))
            : chalk.dim('   ' + cmd);
          process.stdout.write('\n\r\x1b[K' + chalk.hex(G)('⌘') + ' ' + label);
          linesPrinted++;
        }
      } else if (showMentionSuggestions) {
        for (let i = 0; i < mentionFiltered.length; i++) {
          const f = mentionFiltered[i] ?? '';
          if (!f) continue;
          const isSelected = i === mentionSelectedIdx;
          const isDir = f.endsWith('/');
          const icon = isDir ? chalk.yellow('📁') : chalk.dim('📄');
          const label = isSelected
            ? chalk.bgHex('#1a2a3a')(chalk.cyan.bold(' ❯ ') + chalk.cyan(f))
            : chalk.dim('   ' + f);
          process.stdout.write('\n\r\x1b[K' + icon + ' ' + label);
          linesPrinted++;
        }
      }

      if (statusLines) {
        for (const line of statusLines) {
          process.stdout.write('\n\r\x1b[K' + line);
          linesPrinted++;
        }
      }

      if (linesPrinted > 0) {
        process.stdout.write(`\x1b[${linesPrinted}A`);
      }
      process.stdout.write('\r');
      if (targetColumn > 0) {
        process.stdout.write(`\x1b[${targetColumn}C`);
      }
      process.stdout.write('\x1b[?25h');
    }

    function done(value: string) {
      process.stdout.write('\r\x1b[J');
      if (value.trim()) {
        process.stdout.write(
          chalk.blue.bold('User') + chalk.dim(' › ') + highlightMentions(value)
        );
      }
      process.stdin.removeListener('keypress', keypressHandler);
      process.stdout.write('\n');
      resolve(value);
    }

    render();

    const keypressHandler = (_str: string, key: any) => {
      if (!key) return;

      if (key.ctrl && key.name === 'c') {
        done('');
        process.exit(0);
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (isCommandSuggesting()) {
          if (applyCommandSuggestion(true)) return;
        }
        if (mentionStart >= 0 && mentionFiltered.length > 0) {
          const sel = mentionFiltered[mentionSelectedIdx] ?? '';
          buf = buf.slice(0, mentionStart) + '@' + sel + (sel.endsWith('/') ? '' : ' ');
          mentionStart = -1;
          mentionQuery = '';
          mentionFiltered = [];
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
        if (isCommandSuggesting()) {
          if (applyCommandSuggestion(false)) {
            render();
            return;
          }
        }
        if (mentionStart >= 0 && mentionFiltered.length > 0) {
          const sel = mentionFiltered[mentionSelectedIdx] ?? '';
          buf = buf.slice(0, mentionStart) + '@' + sel + (sel.endsWith('/') ? '' : ' ');
          mentionStart = -1;
          mentionQuery = '';
          mentionFiltered = [];
          render();
        }
        return;
      }

      if (key.name === 'escape') {
        mentionStart = -1;
        mentionQuery = '';
        mentionFiltered = [];
        commandFiltered = [];
        commandSelectedIdx = 0;
        render();
        return;
      }

      if (key.name === 'up') {
        if (isCommandSuggesting()) {
          commandSelectedIdx = commandSelectedIdx > 0 ? commandSelectedIdx - 1 : commandFiltered.length - 1;
          render();
        } else if (mentionStart >= 0 && mentionFiltered.length > 0) {
          mentionSelectedIdx = mentionSelectedIdx > 0 ? mentionSelectedIdx - 1 : mentionFiltered.length - 1;
          render();
        } else if (inputHistory.length > 0) {
          if (historyIdx === -1) { historyTempBuf = buf; historyIdx = inputHistory.length - 1; }
          else if (historyIdx > 0) { historyIdx--; }
          buf = inputHistory[historyIdx] ?? buf;
          render();
        }
        return;
      }

      if (key.name === 'down') {
        if (isCommandSuggesting()) {
          commandSelectedIdx = commandSelectedIdx < commandFiltered.length - 1 ? commandSelectedIdx + 1 : 0;
          render();
        } else if (mentionStart >= 0 && mentionFiltered.length > 0) {
          mentionSelectedIdx = mentionSelectedIdx < mentionFiltered.length - 1 ? mentionSelectedIdx + 1 : 0;
          render();
        } else if (historyIdx !== -1) {
          historyIdx++;
          if (historyIdx >= inputHistory.length) { historyIdx = -1; buf = historyTempBuf; }
          else { buf = inputHistory[historyIdx] ?? buf; }
          render();
        }
        return;
      }

      if (key.name === 'backspace') {
        if (buf.length > 0) {
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
        }
        return;
      }

      const ch: string = _str ?? '';
      if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
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
      }
    };

    process.stdin.on('keypress', keypressHandler);
  });
}

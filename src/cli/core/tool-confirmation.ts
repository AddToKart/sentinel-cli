import chalk from 'chalk';
import readline from 'readline';
import path from 'path';
import { COLORS, THEME } from '../ui/theme.js';

const alwaysAllowKeys = new Set<string>();

function getApprovalKey(tool: any, args: any): string {
  const toolName = String(tool?.name ?? 'unknown');
  if (typeof args?.path === 'string' && args.path.trim()) {
    const fullPath = path.isAbsolute(args.path) ? args.path : path.join(process.cwd(), args.path);
    return `${toolName}:path:${fullPath.toLowerCase()}`;
  }
  if (typeof args?.command === 'string' && args.command.trim()) {
    return `${toolName}:command:${args.command}`;
  }
  return `${toolName}:global`;
}

export async function confirmTool(tool: any, args: any): Promise<boolean> {
  const approvalKey = getApprovalKey(tool, args);
  if (alwaysAllowKeys.has(approvalKey)) {
    return true;
  }

  const summary = tool.getRiskSummary ? tool.getRiskSummary(args) : (tool.getLabel ? tool.getLabel(args) : tool.name);
  process.stdout.write('\n' + chalk.yellow('  ⚠') + chalk.yellow.bold(' Confirmation required') + '\n');
  process.stdout.write(chalk.dim('  Action: ') + chalk.white(summary) + '\n');
  process.stdout.write(chalk.dim('  Allow? ') + THEME.accent('[y]') + chalk.dim('es / ') + chalk.red('[n]') + chalk.dim('o / ') + THEME.accent('[a]') + chalk.dim('lways : '));

  return new Promise<boolean>((resolve) => {
    readline.emitKeypressEvents(process.stdin);

    const handler = (_str: string, key: any) => {
      if (!key) return;
      const ch = (key.name || '').toLowerCase();
      if (['y', 'n', 'a', 'return', 'enter'].includes(ch)) {
        process.stdin.removeListener('keypress', handler);
        if (ch === 'a') {
          alwaysAllowKeys.add(approvalKey);
        }
        process.stdout.write(ch === 'n' ? chalk.red('no') + '\n\n' : THEME.accent(ch === 'a' ? 'always' : 'yes') + '\n\n');
        resolve(ch !== 'n');
      }
      if (key.ctrl && key.name === 'c') {
        process.stdin.removeListener('keypress', handler);
        resolve(false);
      }
    };

    process.stdin.on('keypress', handler);
  });
}

export async function confirmYesNo(prompt: string, yesDefault: boolean = true): Promise<boolean> {
  process.stdout.write(chalk.dim('\n  ? ') + chalk.white(prompt) + ' ');
  process.stdout.write(chalk.dim(yesDefault ? '[Y/n]: ' : '[y/N]: '));

  return new Promise<boolean>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const handler = (_str: string, key: any) => {
      if (!key) return;
      const ch = (key.name || '').toLowerCase();
      if (ch === 'return' || ch === 'enter') {
        process.stdin.removeListener('keypress', handler);
        process.stdout.write((yesDefault ? chalk.green('yes') : chalk.red('no')) + '\n');
        resolve(yesDefault);
        return;
      }
      if (ch === 'y') {
        process.stdin.removeListener('keypress', handler);
        process.stdout.write(chalk.green('yes') + '\n');
        resolve(true);
        return;
      }
      if (ch === 'n') {
        process.stdin.removeListener('keypress', handler);
        process.stdout.write(chalk.red('no') + '\n');
        resolve(false);
      }
    };
    process.stdin.on('keypress', handler);
  });
}

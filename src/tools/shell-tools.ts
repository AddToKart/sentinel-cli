import { spawn } from 'child_process';
import fs from 'fs';
import {
  ToolDefinition, ToolExecutionContext, ShellSpawnFactory,
  resolvePath, isDangerousCommand, appendWithLimit, truncateText
} from './security.js';

export const shellTool: ToolDefinition = {
  name: 'execute_shell',
  displayName: 'Shell',
  description: 'Execute a shell command. Use for scripts, package managers, build tools, git, tests.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      cwd: { type: 'string', description: 'Working directory (default: current directory)' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 30000, max 120000)' },
      log_tail: { type: 'number', description: 'Return only the last N lines of output. Use for long output.' },
      env: { type: 'object', description: 'Extra env vars (e.g. {"NODE_ENV":"test"})' },
    },
    required: ['command'],
  },
  requiresConfirmation: true,
  getLabel: ({ command, cwd }) => `${cwd ? `${cwd} ` : ''}$ ${command}`,
  getRiskSummary: ({ command, cwd, timeout_ms }) => {
    const parts = [`Run: ${command}`];
    if (cwd) parts.push(`cwd=${cwd}`);
    if (timeout_ms) parts.push(`timeout=${timeout_ms}ms`);
    return parts.join(' | ');
  },
  async execute({ command, cwd, timeout_ms, log_tail, env }, context = {}) {
    const workingDir = cwd ? resolvePath(cwd) : process.cwd();
    if (!fs.existsSync(workingDir)) return `Error: working directory not found: ${cwd}`;
    if (!fs.statSync(workingDir).isDirectory()) return `Error: not a directory: ${cwd}`;
    const dangerCheck = isDangerousCommand(command);
    if (dangerCheck.dangerous) return `Blocked: ${dangerCheck.reason}`;
    const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 30000, 120000));
    const extraEnv = env && typeof env === 'object' ? env : {};
    return runStreamingShellCommand(command, workingDir, timeout, context, extraEnv, log_tail ? Number(log_tail) : undefined);
  },
};

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]0;.*?\x07/g, '');
}

function compressOutput(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= 150) return text;
  const head = lines.slice(0, 50).join('\n');
  const tail = lines.slice(-80).join('\n');
  const omitted = lines.length - 130;
  return `${head}\n\n... [${omitted} lines omitted] ...\n\n${tail}`;
}

function formatCodeBlock(lang: string, content: string): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

export function runStreamingShellCommand(
  command: string,
  workingDir: string,
  timeout: number,
  context: ToolExecutionContext = {},
  extraEnv: Record<string, string> = {},
  logTail?: number,
  spawnFactory: ShellSpawnFactory = (cmd: string, options: any) => spawn(cmd, options) as any
): Promise<string> {
  const maxCapture = 1024 * 256;

  return new Promise<string>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const childEnv = { ...process.env, ...extraEnv };
    const child = spawnFactory(command, {
      cwd: workingDir,
      shell: true,
      windowsHide: true,
      env: childEnv,
    });

    let abortHandler: (() => void) | undefined;

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (context.signal && abortHandler) {
        context.signal.removeEventListener('abort', abortHandler);
      }
      resolve(result);
    };

    const emitChunk = (stream: 'stdout' | 'stderr', raw: Buffer | string) => {
      const text = String(raw);
      if (stream === 'stdout') {
        stdout = appendWithLimit(stdout, text, maxCapture);
      } else {
        stderr = appendWithLimit(stderr, text, maxCapture);
      }
      context.onOutput?.({ stream, text });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      context.onOutput?.({ stream: 'system', text: `Process timed out after ${timeout}ms.\n` });
      child.kill('SIGTERM');
    }, timeout);

    abortHandler = () => {
      aborted = true;
      context.onOutput?.({ stream: 'system', text: 'Process cancelled by harness.\n' });
      child.kill('SIGTERM');
    };

    if (context.signal) {
      if (context.signal.aborted) {
        abortHandler();
      } else {
        context.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer | string) => emitChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => emitChunk('stderr', chunk));

    child.on('error', (err: any) => {
      finish(`Shell error: ${err.message}`);
    });

    child.on('close', (code: any, signal: any) => {
      const status = timedOut ? `timed out (${timeout}ms)`
        : aborted ? 'cancelled'
        : code === 0 ? `exit 0`
        : `exit ${code ?? '?'}${signal ? ` (signal: ${signal})` : ''}`;

      let out = stripAnsi(stdout ? compressOutput(stdout) : '');
      let err = stripAnsi(stderr ? compressOutput(stderr) : '');

      if (logTail && logTail > 0) {
        const tail = (s: string) => { const ls = s.split('\n'); return ls.slice(-logTail).join('\n'); };
        out = tail(out);
        err = tail(err);
      }

      let result = `[${status}]`;
      if (out) result += `\n${out}`;
      if (err) result += `\nstderr:\n${formatCodeBlock('text', truncateText(err, 8000))}`;
      if (!out && !err) result += '\n(no output)';
      finish(result);
    });
  });
}

import { execSync } from 'child_process';
import { ToolDefinition } from './security.js';

export const gitTool: ToolDefinition = {
  name: 'git',
  displayName: 'Git',
  description: 'Execute git commands (status, diff, log, commit, add, branch, checkout, etc.). High-level wrapper for common git operations.',
  parameters: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', description: 'Git subcommand (e.g., "status", "diff", "log -n 5", "add .", "commit -m \\"msg\\"")' },
    },
    required: ['subcommand'],
  },
  requiresConfirmation: true,
  getLabel: ({ subcommand }) => `git ${subcommand}`,
  getRiskSummary: ({ subcommand }) => `Run: git ${subcommand}`,
  async execute({ subcommand }) {
    try {
      const blockedPatterns = [/push\s+.*--force/i, /reset\s+--hard/i, /clean\s+-fdx/i];
      for (const pattern of blockedPatterns) {
        if (pattern.test(subcommand)) {
          return `Blocked: dangerous git command detected: "git ${subcommand}". Requires manual user execution.`;
        }
      }
      const output = execSync(`git ${subcommand}`, {
        encoding: 'utf-8',
        timeout: 15000,
        maxBuffer: 1024 * 512,
        cwd: process.cwd(),
      });
      return output.trim() ? `git ${subcommand}:\n${output.trim()}` : `git ${subcommand}: (success, no output)`;
    } catch (err: any) {
      const stderr = err.stderr ? String(err.stderr).trim() : '';
      const message = err.message ? String(err.message).trim() : 'Unknown error';
      return `git ${subcommand} failed:\n${stderr || message}`;
    }
  },
};

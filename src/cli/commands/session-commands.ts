import fs from 'fs';
import path from 'path';
import { Message } from '../../providers/types.js';
import { Style } from '../ui/theme.js';

export function saveSession(messages: Message[], currentProvider: string, currentModel: string, customPath?: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = customPath?.trim() || `sentinel-session-${timestamp}.json`;
  const filePath = path.isAbsolute(filename) ? filename : path.join(process.cwd(), filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const session = { timestamp, provider: currentProvider, model: currentModel, messages };
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  process.stdout.write(`${Style.success(' ✔')} Session saved to ${Style.accent(filename)}\n\n`);
}

export function loadSession(filePath: string): { messages: Message[]; provider: string; model: string } | null {
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) { process.stdout.write(Style.error(` ✖ File not found: ${filePath}\n`)); return null; }
    const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    if (!raw.messages || !Array.isArray(raw.messages)) { process.stdout.write(Style.error(' ✖ Invalid session file.\n')); return null; }
    return { messages: raw.messages, provider: raw.provider || 'gemini', model: raw.model || 'gemini-2.5-pro' };
  } catch (err: any) { process.stdout.write(Style.error(` ✖ Error loading session: ${err.message}\n`)); return null; }
}

export function listSessions(): { files: string[]; dir: string } {
  const dir = process.cwd();
  const files = fs.readdirSync(dir).filter(f => f.startsWith('sentinel-session-') && f.endsWith('.json')).sort().reverse();
  return { files, dir };
}

export function exportSessionToMarkdown(messages: Message[], currentProvider: string, currentModel: string, customPath?: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = customPath?.trim() || `sentinel-session-${timestamp}.md`;
  const filePath = path.isAbsolute(filename) ? filename : path.join(process.cwd(), filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = messages.filter(m => m.role !== 'system').map(m => {
    const role = m.role === 'user' ? '**User**' : m.role === 'assistant' ? '**Sentinel**' : `**[Tool: ${m.name}]**`;
    return `### ${role}\n${m.content}\n`;
  }).join('\n---\n\n');
  const header = `# Sentinel Session\n> ${currentProvider} / ${currentModel}\n> ${new Date().toLocaleString()}\n\n---\n\n`;
  fs.writeFileSync(filePath, header + content, 'utf-8');
  process.stdout.write(`${Style.success(' ✔')} Session exported to ${Style.accent(filename)}\n\n`);
}

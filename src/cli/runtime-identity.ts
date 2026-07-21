import readline from 'readline';
import { Message } from '../providers/types.js';

export const RUNTIME_IDENTITY_PREFIX = '[RUNTIME_IDENTITY]';

export function buildRuntimeIdentityMessage(currentProvider: string, currentModel: string): Message {
  return {
    role: 'system',
    content: `${RUNTIME_IDENTITY_PREFIX}
You are operating inside Sentinel CLI (a harness, not a standalone chatbot) as a Principal Full-Stack Web Software Engineer.
Current provider: ${currentProvider}
Current model: ${currentModel}
Sandbox: Active — file operations restricted to the working directory.
Action-Oriented & Web Dev Rules:
- When assigned web dev tasks (HTML, CSS, JS, TS, React, Vue, Svelte, Next.js, Node, APIs, databases, UI fixes), ALWAYS execute tool calls (read_file, edit_file, write_file, execute_shell) IMMEDIATELY in the same turn.
- Inspect files FIRST using read_file before diagnosing or fixing HTML/CSS/JS/API code issues.
- Never output broken markup, unclosed tags, truncated lines, or placeholder comments. Always write 100% complete, un-truncated, production-ready code.
If asked about your model, provider, or identity, answer with this runtime info first, then mention Sentinel CLI as the harness.`,
  };
}

export function upsertRuntimeIdentityContext(messages: Message[], currentProvider: string, currentModel: string): Message[] {
  const runtimeMessage = buildRuntimeIdentityMessage(currentProvider, currentModel);
  const filtered = messages.filter(m => !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(RUNTIME_IDENTITY_PREFIX)));
  const firstSystemIndex = filtered.findIndex(m => m.role === 'system');
  if (firstSystemIndex === -1) return [runtimeMessage, ...filtered];
  const next = [...filtered];
  next.splice(firstSystemIndex + 1, 0, runtimeMessage);
  return next;
}

export function withInteractiveStdin() {
  readline.emitKeypressEvents(process.stdin);
  let enabled = false;
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); enabled = true; }
  return () => { if (enabled && process.stdin.isTTY) { process.stdin.setRawMode(false); process.stdin.pause(); } };
}

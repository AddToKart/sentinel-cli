import { Message } from '../../providers/types.js';
import { tools } from '../../tools/index.js';
import { Style, buildPanel } from '../ui/theme.js';
import { TaskContinuityTracker } from '../core/intelligence.js';
import { getCostSummary } from '../core/tracker.js';
import { getUndoCount } from '../core/undo.js';

export type PlanningMode = 'off' | 'auto' | 'on';

export function showStats(
  messages: Message[],
  currentProvider: string,
  currentModel: string,
  planningMode: PlanningMode,
  continuity: TaskContinuityTracker
) {
  const msgCount = messages.filter(m => m.role !== 'system').length;
  const userMsgs = messages.filter(m => m.role === 'user').length;
  const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
  const toolMsgs = messages.filter(m => m.role === 'tool').length;
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const approx = Math.round(totalChars / 4);
  const costSummary = getCostSummary(currentModel);
  const undoCount = getUndoCount();
  const body = buildPanel('Session Stats', [
    `${Style.dim('Provider:')}   ${Style.accent(currentProvider)}`,
    `${Style.dim('Model:')}      ${Style.accent(currentModel)}`,
    `${Style.dim('Messages:')}   ${Style.accent(String(msgCount))}${Style.dim(` (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool)`)}`,
    `${Style.dim('Context:')}    ${Style.accent(`~${approx.toLocaleString()} tokens`)}${Style.dim(` (${(totalChars / 1024).toFixed(1)} KB)`)}`,
    `${Style.dim('Usage:')}      ${Style.accent(costSummary)}`,
    `${Style.dim('Undo:')}       ${Style.accent(String(undoCount))}${Style.dim(' operations available')}`,
    `${Style.dim('Planning:')}   ${Style.accent(planningMode)}`,
    `${Style.dim('Mode:')}       ${Style.accent(continuity.getMode())}`,
    `${Style.dim('Focus:')}      ${Style.accent(String(continuity.getFocusedFiles().length))}${Style.dim(' tracked files')}`,
  ]);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('\n');
}

export function showTools() {
  const items: string[] = [];
  for (const tool of tools) {
    const icon = tool.requiresConfirmation ? Style.warning('⚠') : Style.icon('◈');
    items.push(`${icon} ${Style.accent(tool.name)}${Style.dim(` — ${tool.description.slice(0, 60)}...`)}`);
  }
  const body = buildPanel('Available Tools', items);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('\n');
}

export function showHelp() {
  const items = [
    `${Style.accent('/models')}      ${Style.dim('Switch AI model')}`,
    `${Style.accent('/clear')}       ${Style.dim('Clear conversation history')}`,
    `${Style.accent('/save')}        ${Style.dim('Save session [path]')}`,
    `${Style.accent('/load')}        ${Style.dim('Load saved session')}`,
    `${Style.accent('/export')}      ${Style.dim('Export conversation as markdown [path]')}`,
    `${Style.accent('/undo')}        ${Style.dim('Revert last file edit/write')}`,
    `${Style.accent('/stats')}       ${Style.dim('Show token usage & session stats')}`,
    `${Style.accent('/tools')}       ${Style.dim('List registered agent tools')}`,
    `${Style.accent('/plan')}        ${Style.dim('Toggle planning mode (auto|on|off)')}`,
    `${Style.accent('/compact')}     ${Style.dim('Compress message history')}`,
    `${Style.accent('/remember')}    ${Style.dim('Store custom memory hint')}`,
    `${Style.accent('/forget')}      ${Style.dim('Remove stored memory hint')}`,
    `${Style.accent('/memories')}    ${Style.dim('List all persistent memory hints')}`,
    `${Style.accent('/exit')}        ${Style.dim('Exit session')}`,
  ];
  const body = buildPanel('Available Slash Commands', items);
  for (const l of body) process.stdout.write(`  ${l}\n`);
  process.stdout.write('\n');
}

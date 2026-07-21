import fs from 'fs';
import path from 'path';

interface FileSnapshot {
  filePath: string;
  content: string;
  timestamp: number;
  toolName: string;
  label: string;
}

const MAX_HISTORY = 50;
const history: FileSnapshot[] = [];

/**
 * Save a snapshot of a file before modifying it.
 * Call this BEFORE write_file or edit_file executes.
 */
export function snapshotBeforeWrite(filePath: string, toolName: string, label: string): void {
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) return; // New file, no snapshot needed
    const content = fs.readFileSync(fullPath, 'utf-8');
    history.push({
      filePath: fullPath,
      content,
      timestamp: Date.now(),
      toolName,
      label,
    });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  } catch { /* skip unreadable */ }
}

/**
 * Undo the last write_file or edit_file operation.
 * Returns a result message describing what was undone.
 */
export function undoLastFileOp(): string {
  if (history.length === 0) return 'Nothing to undo.';

  const last = history.pop()!;
  try {
    fs.writeFileSync(last.filePath, last.content, 'utf-8');
    const relative = path.relative(process.cwd(), last.filePath);
    return `Undid ${last.toolName} on ${relative} (${last.label})`;
  } catch (err: any) {
    history.push(last); // Put it back if undo failed
    return `Undo failed for ${last.filePath}: ${err.message}`;
  }
}

/**
 * Get the number of available undo operations.
 */
export function getUndoCount(): number {
  return history.length;
}

/**
 * Get the summary of the last operation that can be undone.
 */
export function getLastUndoLabel(): string | null {
  const last = history[history.length - 1];
  if (!last) return null;
  const relative = path.relative(process.cwd(), last.filePath);
  return `${last.toolName} on ${relative}`;
}

/**
 * Clear the undo history.
 */
export function clearUndoHistory(): void {
  history.length = 0;
}

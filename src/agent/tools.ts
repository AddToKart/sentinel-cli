import { ToolDefinition } from '../tools/index.js';
import {
  readFileTool,
  grepTool,
  globTool,
  listDirTool,
  readCodebaseTool,
  webFetchTool,
  gitTool,
  askUserTool,
} from '../tools/index.js';

// Subagents get READ-ONLY discovery tools plus git and ask_user.
// No write_file, edit_file, execute_shell, or delegate_task.
// gitTool is read-only (status/diff/log/branch) — no add/commit.
// ask_user lets subagents request clarification from the parent context.
export function getAgentToolset(): ToolDefinition[] {
  return [
    grepTool,
    globTool,
    readFileTool,
    readCodebaseTool,
    listDirTool,
    webFetchTool,
    gitTool,
    askUserTool,
  ];
}

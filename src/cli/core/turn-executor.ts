import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { AIProvider, Message, ProviderResponse } from '../../providers/types.js';
import { ToolDefinition, ToolExecutionContext, ToolOutputChunk } from '../../tools/index.js';
import { injectMentionedContextWithMetadata, MentionContextResult } from './context.js';
import {
  HarnessMemory, TaskContinuityTracker, buildMemoryContext, buildPlanningRequest,
  buildPolicyHints, buildSelfCritiquePrompt, injectHarnessContext, shouldSelfCritique, validateToolCall
} from './intelligence.js';
import { createTurnInterruptController } from './request-interrupt.js';
import { COLORS, Style } from '../ui/theme.js';
import { renderMarkdown, startSpinner, renderDiff, sanitizeAnsi, MarkdownStreamRenderer } from '../ui/rendering.js';
import { checkSandbox, isPathInSandbox, resolvePathSafe, getSandboxRoot, recheckPathInSandbox } from './sandbox.js';
import { snapshotBeforeWrite } from './undo.js';
import { recordUsage, estimateTokens } from './tracker.js';
import { confirmYesNo, isDirectoryTrusted } from './tool-confirmation.js';
import { isPathSensitive } from '../../tools/index.js';

export interface PreparedExecutionTurn {
  executionInput: string;
  mentionContext: MentionContextResult;
  autoLoadedPathSet: Set<string>;
}

export interface TurnExecutionIO {
  startSpinner(label: string): () => void;
  renderAssistant(text: string): Promise<void>;
  beginAssistantStream(): void;
  pushAssistantChunk(text: string): void;
  endAssistantStream(): void;
  showPlan(plan: string): Promise<void>;
  showNotice(message: string, tone?: 'dim' | 'warn' | 'error'): void;
  showNoResponse(): void;
  showToolStart(tool: ToolDefinition, label: string): void;
  showToolOutput(chunk: ToolOutputChunk): void;
  showToolResult(result: string): void;
  showToolError(message: string): void;
}

export interface TurnExecutionOptions {
  provider: AIProvider;
  taskInput: string;
  messages: Message[];
  memory: HarnessMemory;
  continuity: TaskContinuityTracker;
  tools: ToolDefinition[];
  toolResultCache: Map<string, string>;
  io: TurnExecutionIO;
  confirmTool?: (tool: ToolDefinition, args: any) => Promise<boolean>;
  autoLoadedPathSet?: Set<string>;
}

function isEmptyAssistantResponse(response?: ProviderResponse): boolean {
  if (!response) return true;
  const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
  const hasToolCalls = Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  return !hasContent && !hasToolCalls;
}

function normalizeNewlines(content: string): string { return content.replace(/\r\n/g, '\n'); }
function detectEol(content: string): '\r\n' | '\n' { return content.includes('\r\n') ? '\r\n' : '\n'; }
function withEol(content: string, eol: '\r\n' | '\n'): string { return normalizeNewlines(content).replace(/\n/g, eol); }

export function normalizeTargetPath(filePath: string): string {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return path.normalize(fullPath).toLowerCase();
}

function getToolSignature(name: string, args: any): string { return `${name}:${JSON.stringify(args ?? {})}`; }
function popLastUserIfPending(messages: Message[]) { const last = messages[messages.length - 1]; if (last?.role === 'user') messages.pop(); }

function isStableCachedResult(toolName: string, result: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false;
  return result.startsWith('Skipped ') || result.startsWith('No changes:') || result.startsWith('⚠ Blocked:') || result.includes('old_string not found') || result.includes('old_string appears');
}

export function isPerTurnDedupableTool(toolName: string): boolean {
  return ['write_file', 'edit_file', 'read_file', 'list_directory', 'grep', 'glob', 'read_codebase', 'web_fetch'].includes(toolName);
}

function shouldPrintNotice(noticeSet: Set<string>, key: string): boolean {
  if (noticeSet.has(key)) return false;
  noticeSet.add(key);
  return true;
}

// ─── Tool Call Retry (Error Recovery) ───────────────────────────────────
// When edit_file fails with "old_string not found", we grep for the
// content pattern, find the actual lines, and retry with corrected args.
async function retryFailedEditCall(
  call: { name: string; args: any },
  result: string,
  io: TurnExecutionIO
): Promise<{ retried: boolean; newResult?: string }> {
  // Only retry edit_file with old_string not found errors
  if (call.name !== 'edit_file') return { retried: false };
  if (!result.includes('old_string not found')) return { retried: false };

  const oldString: string = call.args?.old_string ?? '';
  const newString: string = call.args?.new_string ?? '';
  const filePath: string = call.args?.path ?? '';

  if (!oldString || !filePath) return { retried: false };

  io.showNotice('Edit failed — attempting auto-recovery...', 'warn');

  // Extract a searchable pattern from the failed old_string (first significant line)
  const searchLines = oldString.split('\n').filter(l => l.trim().length > 3);
  if (searchLines.length === 0) return { retried: false };

  // Try to find the file content first
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) return { retried: false };

  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  const fileLines = fileContent.split('\n');

  // Try to find each search line in the file
  let bestLineIdx = -1;
  let bestScore = 0;

  for (const searchLine of searchLines) {
    const trimmed = searchLine.trim();
    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i]?.includes(trimmed)) {
        const score = trimmed.length;
        if (score > bestScore) {
          bestScore = score;
          bestLineIdx = i;
        }
      }
    }
  }

  if (bestLineIdx < 0) return { retried: false };

  // Build corrected old_string using the actual file content
  const correctedOldStart = bestLineIdx;
  const oldLineCount = oldString.split('\n').length;
  const correctedOld = fileLines.slice(correctedOldStart, correctedOldStart + oldLineCount).join('\n');

  if (correctedOld === oldString) return { retried: false }; // No improvement

  io.showNotice(`Recovered: found match at line ${bestLineIdx + 1}, retrying...`, 'dim');

  // Execute the retry
  try {
    const { editFileTool } = await import('../../tools/index.js');
    const retryResult = await editFileTool.execute({
      path: filePath,
      old_string: correctedOld,
      new_string: newString,
    });
    return { retried: true, newResult: retryResult };
  } catch {
    return { retried: false };
  }
}

// ─── Diff Preview ───────────────────────────────────────────────────────
// Shows a diff and asks for confirmation before write_file or edit_file.
async function showDiffPreviewAndConfirm(call: { name: string; args: any }): Promise<boolean> {
  if (call.name !== 'write_file' && call.name !== 'edit_file') return true;

  try {
    const filePath: string = call.args?.path ?? '';
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const dirPath = path.dirname(fullPath);

    // Security: sensitive files (e.g. .env) — always require confirmation
    // even in Flow Mode, and skip diff preview to avoid leaking contents.
    const sensitiveCheck = isPathSensitive(fullPath);
    if (sensitiveCheck.sensitive) {
      return await confirmYesNo(
        `⚠ ${sensitiveCheck.reason} detected: ${filePath}. Apply this change?`,
        false  // default no for sensitive files
      );
    }

    // Flow Mode: skip confirmation in trusted directories
    if (isDirectoryTrusted(dirPath)) return true;

    if (call.name === 'write_file') {
      if (!fs.existsSync(fullPath)) return true; // New file, no diff needed
      const oldContent = fs.readFileSync(fullPath, 'utf-8');
      const newContent: string = call.args?.content ?? '';
      const diff = renderDiff(generateDiffString(oldContent, newContent, filePath));
      process.stdout.write(`\n${Style.dim(' Diff preview:')}\n${diff}\n`);
    } else {
      // edit_file
      if (!fs.existsSync(fullPath)) return true;
      const oldContent = fs.readFileSync(fullPath, 'utf-8');
      const oldStr: string = call.args?.old_string ?? '';
      const newStr: string = call.args?.new_string ?? '';
      const updatedContent = oldContent.replace(oldStr, newStr);
      if (updatedContent === oldContent) return true;
      const diff = renderDiff(generateDiffString(oldContent, updatedContent, filePath));
      process.stdout.write(`\n${Style.dim(' Diff preview:')}\n${diff}\n`);
    }

    return await confirmYesNo('Apply this change?', true);
  } catch {
    return true; // If diff fails, proceed anyway
  }
}

function generateDiffString(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const result: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let changed = false;
  const block: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === undefined) { block.push(`+ ${n}`); changed = true; }
    else if (n === undefined) { block.push(`- ${o}`); changed = true; }
    else if (o !== n) { block.push(`- ${o}`); block.push(`+ ${n}`); changed = true; }
    else { block.push(`  ${o}`); }
  }
  if (!changed) return '(no changes)';
  return result.concat(block).join('\n');
}

// ─── Self-Critique ───────────────────────────────────────────────────────
async function runSelfCritiqueIfNeeded(provider: AIProvider, messages: Message[], response: ProviderResponse, taskInput: string): Promise<ProviderResponse> {
  if (!shouldSelfCritique(response, taskInput)) return response;
  const critiquePrompt = buildSelfCritiquePrompt(taskInput, response.content || '');
  try {
    const improved = await provider.sendMessage(
      [...messages, { role: 'assistant', content: response.content || '' }, { role: 'user', content: critiquePrompt }],
      [], { maxRetries: 1 }
    );
    if (improved?.content && improved.content.trim().length > 0) return improved;
  } catch { /* fall through */ }
  return response;
}

// ─── Planning ────────────────────────────────────────────────────────────
export async function runPlanningPass(provider: AIProvider, messages: Message[], taskInput: string): Promise<string> {
  const stop = startSpinner('Planning...');
  try {
    const planResp = await provider.sendMessage(
      [...messages, { role: 'user', content: buildPlanningRequest(taskInput) }],
      [], { maxRetries: 1 }
    );
    return planResp.content || '';
  } finally { stop(); }
}

export async function prepareExecutionTurn(taskInput: string, memory: HarnessMemory, continuity: TaskContinuityTracker): Promise<PreparedExecutionTurn> {
  const mentionContext = await injectMentionedContextWithMetadata(taskInput);
  if (mentionContext.anchorFiles.length > 0 || mentionContext.relatedFiles.length > 0 || mentionContext.workingSetFiles.length > 0) {
    continuity.setTurnContextFiles(mentionContext.anchorFiles, mentionContext.relatedFiles, mentionContext.workingSetFiles);
  }
  const continuityContext = continuity.buildContextBlock();
  const policyHints = [...buildPolicyHints(taskInput), ...continuity.buildHints()];
  const memoryContext = [continuityContext, buildMemoryContext(taskInput, memory)].filter(Boolean).join('\n\n');
  const executionInput = injectHarnessContext(mentionContext.content, memoryContext, policyHints);
  const autoLoadedPathSet = new Set(mentionContext.loadedFiles.map(p => normalizeTargetPath(p)));
  return { executionInput, mentionContext, autoLoadedPathSet };
}

// ─── Request Assistant Response (with REAL streaming) ────────────────────
async function requestAssistantResponse(
  provider: AIProvider, messages: Message[], tools: ToolDefinition[], io: TurnExecutionIO,
  streamPreferred: boolean, taskInput: string, interrupt: ReturnType<typeof createTurnInterruptController>
): Promise<{ response?: ProviderResponse; cancelled: boolean; streamed: boolean }> {
  let response: ProviderResponse | undefined;
  let streamed = false;

  if (streamPreferred && provider.streamMessage) {
    io.beginAssistantStream();
    // Show a spinner while the AI is thinking before streaming begins
    const stopThinking = io.startSpinner('Working on it...');
    let streamFailed = false;
    let streamStarted = false;
    try {
      const streamedResp = await interrupt.run(() =>
        provider.streamMessage!(messages, tools, (chunk) => {
          if (!streamStarted) {
            stopThinking();
            streamStarted = true;
          }
          io.pushAssistantChunk(chunk);
        }, { maxRetries: 2, signal: interrupt.getSignal() })
      );
      if (!streamStarted) stopThinking();
      io.endAssistantStream();
      if (streamedResp.cancelled) return { cancelled: true, streamed };
      response = streamedResp.value;
      streamed = true;
    } catch {
      if (!streamStarted) stopThinking();
      streamFailed = true;
      io.endAssistantStream();
    }
    if (!response && streamFailed) {
      const stopFallback = io.startSpinner('Thinking...');
      try {
        const fallback = await interrupt.run(() => provider.sendMessage(messages, tools, { maxRetries: 2, signal: interrupt.getSignal() }));
        stopFallback();
        if (fallback.cancelled) return { cancelled: true, streamed };
        response = fallback.value;
      } catch (err) { stopFallback(); throw err; }
    }
  } else {
    const stop = io.startSpinner('Working on it...');
    try {
      const result = await interrupt.run(() => provider.sendMessage(messages, tools, { maxRetries: 2, signal: interrupt.getSignal() }));
      stop();
      if (result.cancelled) return { cancelled: true, streamed };
      response = result.value;
    } catch (err) { stop(); throw err; }
  }

  if (!response) return { cancelled: false, streamed };

  if (isEmptyAssistantResponse(response)) {
    const stopRetry = io.startSpinner('Retrying...');
    try {
      const retry = await interrupt.run(() => provider.sendMessage(messages, tools, { maxRetries: 1, signal: interrupt.getSignal() }));
      stopRetry();
      if (retry.cancelled) return { cancelled: true, streamed };
      if (!isEmptyAssistantResponse(retry.value)) response = retry.value;
    } catch { stopRetry(); }
  }

  if (!response) return { cancelled: false, streamed };

  response = await runSelfCritiqueIfNeeded(provider, messages, response, taskInput);

  // Track token usage if content exists
  if (response.content) {
    const promptTokens = estimateTokens(messages.map(m => m.content).join('\n'));
    const completionTokens = estimateTokens(response.content);
    recordUsage(provider.name, (provider as any).modelName || provider.name, promptTokens, completionTokens);
  }

  return { response, cancelled: false, streamed: streamed || false };
}

// ─── Sandbox Helpers ─────────────────────────────────────────────────────
function getSandboxablePath(call: { name: string; args: any }): string | null {
  const args = call.args ?? {};
  switch (call.name) {
    case 'read_file': case 'write_file': case 'edit_file': return typeof args.path === 'string' ? args.path : null;
    case 'list_directory': case 'read_codebase': case 'glob': return typeof args.path === 'string' ? args.path : '.';
    case 'grep': return typeof args.path === 'string' ? args.path : '.';
    case 'execute_shell': return typeof args.cwd === 'string' ? args.cwd : null;
    default: return null;
  }
}

function getOperationLabel(call: { name: string; args: any }): string {
  switch (call.name) {
    case 'read_file': return 'read file'; case 'write_file': return 'write file'; case 'edit_file': return 'edit file';
    case 'list_directory': return 'list directory'; case 'read_codebase': return 'read codebase';
    case 'glob': return 'find files'; case 'grep': return 'search files'; case 'execute_shell': return 'execute shell';
    default: return 'access filesystem';
  }
}

// ─── Execute Tool Calls ──────────────────────────────────────────────────
async function executeToolCalls(
  response: ProviderResponse, options: TurnExecutionOptions,
  interrupt: ReturnType<typeof createTurnInterruptController>,
  turnToolResultCache: Map<string, string>, turnReadCache: Map<string, string>, turnNoticeCache: Set<string>
): Promise<{ stopTurn: boolean }> {
  const { messages, memory, continuity, tools, toolResultCache, io, confirmTool, autoLoadedPathSet = new Set<string>() } = options;

  for (const call of response.toolCalls || []) {
    if (interrupt.isHardCancelled()) return { stopTurn: true };
    if (interrupt.isInterrupted()) { io.showNotice('Interrupted. Skipping remaining tool execution.', 'warn'); return { stopTurn: true }; }

    const signature = getToolSignature(call.name, call.args);
    const turnCached = turnToolResultCache.get(signature);
    if (turnCached && isPerTurnDedupableTool(call.name)) {
      messages.push({ role: 'tool', content: turnCached, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, turnCached);
      continuity.onToolResult(call.name, call.args, turnCached);
      continue;
    }

    if (call.name === 'read_file' && typeof call.args?.path === 'string') {
      const rp = normalizeTargetPath(call.args.path);
      if (autoLoadedPathSet.has(rp)) {
        const msg = `Skipped read_file: ${call.args.path} was already loaded from @mention.`;
        if (shouldPrintNotice(turnNoticeCache, `autoload:${rp}`)) io.showNotice(msg, 'dim');
        messages.push({ role: 'tool', content: msg, name: call.name, tool_call_id: call.id });
        memory.addToolResult(call.name, call.args, msg);
        continuity.onToolResult(call.name, call.args, msg);
        turnReadCache.set(rp, msg);
        if (isPerTurnDedupableTool(call.name)) turnToolResultCache.set(signature, msg);
        continue;
      }
      const cached = turnReadCache.get(rp);
      if (cached) {
        if (shouldPrintNotice(turnNoticeCache, `readcache:${rp}`)) io.showNotice(`Reused cached: ${call.args.path}`, 'dim');
        messages.push({ role: 'tool', content: cached, name: call.name, tool_call_id: call.id });
        memory.addToolResult(call.name, call.args, cached);
        continuity.onToolResult(call.name, call.args, cached);
        if (isPerTurnDedupableTool(call.name)) turnToolResultCache.set(signature, cached);
        continue;
      }
    }

    const cached = toolResultCache.get(signature);
    if (cached && isStableCachedResult(call.name, cached)) {
      if (shouldPrintNotice(turnNoticeCache, `cache:${signature}:${cached}`)) io.showNotice(cached, 'dim');
      messages.push({ role: 'tool', content: cached, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, cached);
      continuity.onToolResult(call.name, call.args, cached);
      turnToolResultCache.set(signature, cached);
      continue;
    }

    const callError = validateToolCall(call, tools);
    if (callError) {
      if (shouldPrintNotice(turnNoticeCache, `policy:${signature}:${callError}`)) io.showNotice(`Policy blocked: ${callError}`, 'warn');
      const err = `Error: ${callError}`;
      messages.push({ role: 'tool', content: err, name: call.name, tool_call_id: call.id });
      toolResultCache.set(signature, err);
      turnToolResultCache.set(signature, err);
      continue;
    }

    const continuityError = continuity.validateToolCall(call);
    if (continuityError) {
      if (shouldPrintNotice(turnNoticeCache, `cont:${signature}:${continuityError}`)) io.showNotice(`Policy blocked: ${continuityError}`, 'warn');
      const err = `Error: ${continuityError}`;
      messages.push({ role: 'tool', content: err, name: call.name, tool_call_id: call.id });
      toolResultCache.set(signature, err);
      turnToolResultCache.set(signature, err);
      continue;
    }

    // ─── Sandbox Check ───────────────────────────────────────────────
    const sandboxPath = getSandboxablePath(call);
    if (sandboxPath) {
      const sandboxResult = await checkSandbox(call.name, sandboxPath, getOperationLabel(call));
      if (sandboxResult) {
        if (shouldPrintNotice(turnNoticeCache, `sandbox:${signature}:${sandboxResult}`)) io.showNotice(sandboxResult, 'warn');
        messages.push({ role: 'tool', content: sandboxResult, name: call.name, tool_call_id: call.id });
        memory.addToolResult(call.name, call.args, sandboxResult);
        continuity.onToolResult(call.name, call.args, sandboxResult);
        toolResultCache.set(signature, sandboxResult);
        turnToolResultCache.set(signature, sandboxResult);
        continue;
      }
    }

    const tool = tools.find(t => t.name === call.name);
    if (!tool) continue;

    // ─── Diff Preview ─────────────────────────────────────────────────
    if (call.name === 'write_file' || call.name === 'edit_file') {
      const approved = await showDiffPreviewAndConfirm(call);
      if (!approved) {
        io.showNotice('Change skipped by user.', 'dim');
        messages.push({ role: 'tool', content: 'User declined to apply this change.', name: call.name, tool_call_id: call.id });
        continue;
      }
      // Take snapshot BEFORE executing
      snapshotBeforeWrite(call.args?.path ?? '', call.name, tool.getLabel?.(call.args) ?? '');
    }

    if (tool.requiresConfirmation) {
      const approved = confirmTool ? await confirmTool(tool, call.args) : false;
      if (!approved) {
        io.showNotice('Skipped.', 'dim');
        messages.push({ role: 'tool', content: 'User declined to run this action.', name: call.name, tool_call_id: call.id });
        continue;
      }
    }

    const label = tool.getLabel ? tool.getLabel(call.args) : call.name;
    io.showToolStart(tool, label);
    const stopSpinner = io.startSpinner(`${tool.displayName || tool.name}...`);

    try {
      // TOCTOU mitigation: re-check path right before execution for file operations
      const filePathArg = call.args?.path;
      if (typeof filePathArg === 'string' && ['write_file', 'edit_file', 'read_file', 'list_directory', 'glob'].includes(call.name)) {
        const toctouCheck = recheckPathInSandbox(filePathArg);
        if (!toctouCheck.allowed) {
          const msg = `Sandbox blocked (TOCTOU): path "${filePathArg}" resolved to "${toctouCheck.realPath}" which is outside the sandbox.`;
          io.showNotice(msg, 'error');
          messages.push({ role: 'tool', content: msg, name: call.name, tool_call_id: call.id });
          continue;
        }
      }

      const toolContext: ToolExecutionContext = { signal: interrupt.getSignal(), onOutput: (chunk) => io.showToolOutput(chunk) };
      let result = await tool.execute(call.args, toolContext);
      stopSpinner();

      // ─── Error Recovery (edit_file retry) ───────────────────────────
      if (result.includes('old_string not found')) {
        const recovery = await retryFailedEditCall(call, result, io);
        if (recovery.retried && recovery.newResult) {
          result = recovery.newResult;
        }
      }

      io.showToolResult(result);
      messages.push({ role: 'tool', content: result, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, result);
      continuity.onToolResult(call.name, call.args, result);
      if (call.name === 'read_file' && typeof call.args?.path === 'string')
        turnReadCache.set(normalizeTargetPath(call.args.path), result);
      toolResultCache.set(signature, result);
      if (isPerTurnDedupableTool(call.name)) turnToolResultCache.set(signature, result);
    } catch (err: any) {
      stopSpinner();
      const errResult = `Error: ${err.message}`;
      io.showToolError(err.message);
      messages.push({ role: 'tool', content: errResult, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, errResult);
      continuity.onToolResult(call.name, call.args, errResult);
      if (call.name === 'read_file' && typeof call.args?.path === 'string')
        turnReadCache.set(normalizeTargetPath(call.args.path), errResult);
      toolResultCache.set(signature, errResult);
      if (isPerTurnDedupableTool(call.name)) turnToolResultCache.set(signature, errResult);
    }
  }
  return { stopTurn: false };
}

// ─── Execute Turn ────────────────────────────────────────────────────────
export async function executeHarnessTurn(options: TurnExecutionOptions): Promise<{ producedOutput: boolean }> {
  const { provider, taskInput, messages, io, tools } = options;
  const turnToolResultCache = new Map<string, string>();
  const turnNoticeCache = new Set<string>();
  const turnReadCache = new Map<string, string>();
  const interrupt = createTurnInterruptController();
  let producedOutput = false;

  try {
    while (true) {
      const { response, cancelled, streamed } = await requestAssistantResponse(provider, messages, tools, io, true, taskInput, interrupt);
      if (cancelled) { io.showNotice('Request interrupted.', 'warn'); break; }
      if (!response || ((!response.content || !response.content.trim()) && (!response.toolCalls || response.toolCalls.length === 0))) {
        if (response) console.debug('[Sentinel] Empty response:', JSON.stringify(response, null, 2));
        io.showNoResponse();
        popLastUserIfPending(messages);
        break;
      }
      if (response.content && !streamed) {
        await io.renderAssistant(response.content);
        options.memory.addSummary('assistant', response.content);
        producedOutput = true;
      } else if (response.content && streamed) {
        options.memory.addSummary('assistant', response.content);
        producedOutput = true;
      }
      const assistantMessage: Message = { role: 'assistant', content: response.content || '' };
      if (response.toolCalls && response.toolCalls.length > 0) assistantMessage.tool_calls = response.toolCalls;
      messages.push(assistantMessage);
      if (interrupt.isInterrupted() && response.toolCalls && response.toolCalls.length > 0) {
        io.showNotice('Interrupted. Skipping remaining tool execution.', 'warn');
        break;
      }
      if (response.toolCalls && response.toolCalls.length > 0) {
        const { stopTurn } = await executeToolCalls(response, options, interrupt, turnToolResultCache, turnReadCache, turnNoticeCache);
        producedOutput = true;
        if (stopTurn) break;
        continue;
      }
      break;
    }
  } finally { interrupt.stop(); }
  return { producedOutput };
}

// ─── Terminal Turn IO ────────────────────────────────────────────────────
export function createTerminalTurnIO(): TurnExecutionIO {
  const mdStream = new MarkdownStreamRenderer();
  return {
    startSpinner,
    async renderAssistant(text: string) {
      process.stdout.write(`\n${Style.icon('◈ ')}${Style.header('Sentinel')}${Style.dim(` ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)}\n`);
      const safeText = sanitizeAnsi(text);
      const rendered = renderMarkdown(safeText);
      process.stdout.write(`${rendered}\n\n`);
    },
    beginAssistantStream() {
      process.stdout.write(`\n${Style.icon('◈ ')}${Style.header('Sentinel')}${Style.dim(` ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)}\n`);
    },
    pushAssistantChunk(text: string) { mdStream.write(sanitizeAnsi(text)); },
    endAssistantStream() { mdStream.end(); process.stdout.write('\n\n'); },
    async showPlan(plan: string) {
      process.stdout.write(`\n${Style.icon('◈ ')}${chalk.bold.hex(COLORS.green300)('Plan')}${Style.dim(' ›')}\n`);
      const rendered = renderMarkdown(plan);
      process.stdout.write(`${rendered}\n\n`);
    },
    showNotice(message: string, tone: 'dim' | 'warn' | 'error' = 'dim') {
      const color = tone === 'warn' ? chalk.yellow : tone === 'error' ? chalk.red : chalk.dim;
      process.stdout.write(`${color(`  └ ${message}`)}\n`);
    },
    showNoResponse() { process.stdout.write(`\n${chalk.yellow('⚠')} ${chalk.yellow('No response received.')}\n\n`); },
    showToolStart(tool: ToolDefinition, label: string) {
      process.stdout.write(`\n${Style.border('╭─ ')}${Style.header(`[Tool] ${tool.displayName || tool.name} `)}${Style.dim(label)}\n`);
    },
    showToolOutput(chunk: ToolOutputChunk) {
      const lines = String(chunk.text).replace(/\r/g, '').split('\n');
      const color = chunk.stream === 'stderr' ? chalk.hex(COLORS.slate500) : chunk.stream === 'system' ? chalk.hex(COLORS.green300) : Style.dim;
      for (const line of lines) { if (!line.trim()) continue; process.stdout.write(`${Style.border('│')} ${color(line)}\n`); }
    },
    showToolResult(result: string) {
      printToolResultPreview(result);
      process.stdout.write(`${Style.border('╰─')}${chalk.hex(COLORS.green400)(' ✔ done')}\n\n`);
    },
    showToolError(message: string) { process.stdout.write(`${Style.border('╰─')}${chalk.hex(COLORS.slate600)(` ✖ ${message}`)}\n\n`); },
  };
}

// ─── Tool Result Preview ────────────────────────────────────────────────
function printToolResultPreview(result: string, maxLines: number = 14) {
  if (!result || result.length === 0) return;
  const lines = result.split('\n');
  const preview = lines.slice(0, maxLines);
  let inCode = false;
  for (const line of preview) {
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (!line) { process.stdout.write(`${Style.border('│')}\n`); continue; }
    if (inCode) { process.stdout.write(`${Style.border('│')} ${Style.body(line)}\n`); continue; }
    if (/^[A-Z][A-Za-z0-9 ()/_-]+:$/.test(line)) { process.stdout.write(`${Style.border('│')} ${Style.accent(line)}\n`); }
    else if (line.startsWith('+ ')) { process.stdout.write(`${Style.border('│')} ${chalk.hex(COLORS.green400)(line)}\n`); }
    else if (line.startsWith('- ')) { process.stdout.write(`${Style.border('│')} ${chalk.hex(COLORS.slate600)(line)}\n`); }
    else { process.stdout.write(`${Style.border('│')} ${Style.body(line)}\n`); }
  }
  if (lines.length > maxLines) process.stdout.write(`${Style.border('│')} ${Style.dim(`... (${lines.length - maxLines} more lines)`)}\n`);
}

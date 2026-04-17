import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { AIProvider, Message, ProviderResponse } from '../../providers/types.js';
import { ToolDefinition, ToolExecutionContext, ToolOutputChunk } from '../../tools/index.js';
import { injectMentionedContextWithMetadata, MentionContextResult } from './context.js';
import {
  HarnessMemory,
  TaskContinuityTracker,
  buildMemoryContext,
  buildPlanningRequest,
  buildPolicyHints,
  buildSelfCritiquePrompt,
  injectHarnessContext,
  shouldSelfCritique,
  validateToolCall
} from './intelligence.js';
import { createTurnInterruptController } from './request-interrupt.js';
import { COLORS, THEME } from '../ui/theme.js';
import { renderMarkdown, startSpinner, streamText } from '../ui/rendering.js';

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

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function withEol(content: string, eol: '\r\n' | '\n'): string {
  return normalizeNewlines(content).replace(/\n/g, eol);
}

export function normalizeTargetPath(filePath: string): string {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return path.normalize(fullPath).toLowerCase();
}

function getToolSignature(name: string, args: any): string {
  return `${name}:${JSON.stringify(args ?? {})}`;
}

function popLastUserIfPending(messages: Message[]) {
  const last = messages[messages.length - 1];
  if (last?.role === 'user') messages.pop();
}

function isStableCachedResult(toolName: string, result: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false;
  return result.startsWith('Skipped ')
    || result.startsWith('No changes:')
    || result.startsWith('⚠ Blocked:')
    || result.includes('old_string not found')
    || result.includes('old_string appears');
}

export function isPerTurnDedupableTool(toolName: string): boolean {
  return toolName === 'write_file'
    || toolName === 'edit_file'
    || toolName === 'read_file'
    || toolName === 'list_directory'
    || toolName === 'grep'
    || toolName === 'glob'
    || toolName === 'read_codebase'
    || toolName === 'web_fetch';
}

function shouldPrintNotice(noticeSet: Set<string>, key: string): boolean {
  if (noticeSet.has(key)) return false;
  noticeSet.add(key);
  return true;
}

function getNoopToolResult(call: { name: string; args: any }): string | null {
  if (call.name === 'write_file') {
    const filePath = call.args?.path;
    const content = call.args?.content;
    if (typeof filePath !== 'string' || typeof content !== 'string') return null;
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) return null;
    try {
      const current = fs.readFileSync(fullPath, 'utf-8');
      if (normalizeNewlines(current) === normalizeNewlines(content)) {
        return `Skipped write_file: ${filePath} already matches the requested content.`;
      }
    } catch {
      return null;
    }
  }

  if (call.name === 'edit_file') {
    const filePath = call.args?.path;
    const oldString = call.args?.old_string;
    const newString = call.args?.new_string;
    if (typeof filePath !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string') return null;
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) return null;
    if (normalizeNewlines(oldString) === normalizeNewlines(newString)) {
      return `Skipped edit_file: replacement text is identical for ${filePath}.`;
    }
    try {
      const original = fs.readFileSync(fullPath, 'utf-8');
      const fileEol = detectEol(original);
      const oldCandidates = [oldString, withEol(oldString, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
      const matchedOld = oldCandidates.find(candidate => original.includes(candidate));
      if (!matchedOld) {
        const newCandidates = [newString, withEol(newString, fileEol)].filter((v, i, arr) => arr.indexOf(v) === i);
        if (newCandidates.some(candidate => original.includes(candidate))) {
          return `Skipped edit_file: ${filePath} already has the requested content.`;
        }
        return null;
      }
      const replacement = withEol(newString, fileEol);
      const updated = original.replace(matchedOld, replacement);
      if (updated === original) return `Skipped edit_file: ${filePath} already has the requested content.`;
    } catch {
      return null;
    }
  }

  return null;
}

export function printToolResultPreview(result: string, maxLines: number = 16) {
  const lines = result.split('\n');
  const previewLines = lines.slice(0, maxLines);
  let inCodeBlock = false;

  for (const line of previewLines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!line) {
      process.stdout.write(THEME.border('│ ') + '\n');
      continue;
    }
    if (inCodeBlock) {
      process.stdout.write(THEME.border('│ ') + THEME.body(line) + '\n');
      continue;
    }
    if (/^[A-Z][A-Za-z0-9 ()/_-]+:$/.test(line)) {
      process.stdout.write(THEME.border('│ ') + THEME.accent(line) + '\n');
      continue;
    }
    if (line.startsWith('+ ')) {
      process.stdout.write(THEME.border('│ ') + chalk.hex(COLORS.green400)(line) + '\n');
      continue;
    }
    if (line.startsWith('- ')) {
      process.stdout.write(THEME.border('│ ') + chalk.hex(COLORS.slate600)(line) + '\n');
      continue;
    }
    process.stdout.write(THEME.border('│ ') + THEME.body(line) + '\n');
  }

  if (lines.length > maxLines) {
    process.stdout.write(THEME.border('│ ') + THEME.dim(`... (${lines.length - maxLines} more lines)`) + '\n');
  }
}

export async function runSelfCritiqueIfNeeded(
  provider: AIProvider,
  messages: Message[],
  response: ProviderResponse,
  taskInput: string
): Promise<ProviderResponse> {
  if (!shouldSelfCritique(response, taskInput)) return response;
  const critiquePrompt = buildSelfCritiquePrompt(taskInput, response.content || '');
  try {
    const improved = await provider.sendMessage(
      [...messages, { role: 'assistant', content: response.content || '' }, { role: 'user', content: critiquePrompt }],
      [],
      { maxRetries: 1 }
    );
    if (improved?.content && improved.content.trim().length > 0) return improved;
  } catch {
    return response;
  }
  return response;
}

export async function runPlanningPass(provider: AIProvider, messages: Message[], taskInput: string): Promise<string> {
  const stop = startSpinner('Planning...');
  try {
    const planResp = await provider.sendMessage(
      [...messages, { role: 'user', content: buildPlanningRequest(taskInput) }],
      [],
      { maxRetries: 1 }
    );
    return planResp.content || '';
  } finally {
    stop();
  }
}

export async function prepareExecutionTurn(
  taskInput: string,
  memory: HarnessMemory,
  continuity: TaskContinuityTracker
): Promise<PreparedExecutionTurn> {
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

async function requestAssistantResponse(
  provider: AIProvider,
  messages: Message[],
  tools: ToolDefinition[],
  io: TurnExecutionIO,
  streamPreferred: boolean,
  taskInput: string,
  interrupt: ReturnType<typeof createTurnInterruptController>
): Promise<{ response?: ProviderResponse; cancelled: boolean; streamed: boolean }> {
  let response: ProviderResponse | undefined;
  let streamed = false;

  if (streamPreferred && provider.streamMessage) {
    const stop = io.startSpinner('Thinking...');
    let streamFailed = false;

    try {
      const streamedResp = await interrupt.run(() =>
        provider.streamMessage!(messages, tools, () => {}, { maxRetries: 2 })
      );
      stop();
      if (streamedResp.cancelled) {
        return { cancelled: true, streamed };
      }
      response = streamedResp.value;
    } catch {
      streamFailed = true;
      stop();
    }

    if (!response && streamFailed) {
      const stopFallback = io.startSpinner('Thinking...');
      try {
        const fallback = await interrupt.run(() => provider.sendMessage(messages, tools, { maxRetries: 2 }));
        stopFallback();
        if (fallback.cancelled) return { cancelled: true, streamed };
        response = fallback.value;
      } catch (err) {
        stopFallback();
        throw err;
      }
    }
  } else {
    const stop = io.startSpinner('Thinking...');
    try {
      const result = await interrupt.run(() => provider.sendMessage(messages, tools, { maxRetries: 2 }));
      stop();
      if (result.cancelled) return { cancelled: true, streamed };
      response = result.value;
    } catch (err) {
      stop();
      throw err;
    }
  }

  if (!response) {
      return { cancelled: false, streamed };
  }

  if (isEmptyAssistantResponse(response)) {
    const stopRetry = io.startSpinner('Retrying...');
    try {
      const retry = await interrupt.run(() => provider.sendMessage(messages, tools, { maxRetries: 1 }));
      stopRetry();
      if (retry.cancelled) return { cancelled: true, streamed };
      if (!isEmptyAssistantResponse(retry.value)) {
        response = retry.value;
      }
    } catch {
      stopRetry();
    }
  }

  if (!response) {
    return { cancelled: false, streamed };
  }

  response = await runSelfCritiqueIfNeeded(provider, messages, response, taskInput);
  return { response, cancelled: false, streamed };
}

async function executeToolCalls(
  response: ProviderResponse,
  options: TurnExecutionOptions,
  interrupt: ReturnType<typeof createTurnInterruptController>,
  turnToolResultCache: Map<string, string>,
  turnReadCache: Map<string, string>,
  turnNoticeCache: Set<string>
): Promise<{ stopTurn: boolean }> {
  const { messages, memory, continuity, tools, toolResultCache, io, confirmTool, autoLoadedPathSet = new Set<string>() } = options;

  for (const call of response.toolCalls || []) {
    if (interrupt.isHardCancelled()) {
      return { stopTurn: true };
    }
    if (interrupt.isInterrupted()) {
      io.showNotice('Interrupted. Skipping remaining tool execution for this turn.', 'warn');
      return { stopTurn: true };
    }

    const signature = getToolSignature(call.name, call.args);
    const turnCached = turnToolResultCache.get(signature);
    if (turnCached && isPerTurnDedupableTool(call.name)) {
      messages.push({ role: 'tool', content: turnCached, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, turnCached);
      continuity.onToolResult(call.name, call.args, turnCached);
      continue;
    }

    if (call.name === 'read_file' && typeof call.args?.path === 'string') {
      const normalizedReadPath = normalizeTargetPath(call.args.path);
      if (autoLoadedPathSet.has(normalizedReadPath)) {
        const alreadyLoaded = `Skipped read_file: ${call.args.path} was already loaded from your @mention this turn.`;
        if (shouldPrintNotice(turnNoticeCache, `autoload:${normalizedReadPath}`)) {
          io.showNotice(alreadyLoaded, 'dim');
        }
        messages.push({ role: 'tool', content: alreadyLoaded, name: call.name, tool_call_id: call.id });
        memory.addToolResult(call.name, call.args, alreadyLoaded);
        continuity.onToolResult(call.name, call.args, alreadyLoaded);
        turnReadCache.set(normalizedReadPath, alreadyLoaded);
        if (isPerTurnDedupableTool(call.name)) turnToolResultCache.set(signature, alreadyLoaded);
        continue;
      }

      const cachedRead = turnReadCache.get(normalizedReadPath);
      if (cachedRead) {
        if (shouldPrintNotice(turnNoticeCache, `readcache:${normalizedReadPath}`)) {
          io.showNotice(`Reused cached read: ${call.args.path}`, 'dim');
        }
        messages.push({ role: 'tool', content: cachedRead, name: call.name, tool_call_id: call.id });
        memory.addToolResult(call.name, call.args, cachedRead);
        continuity.onToolResult(call.name, call.args, cachedRead);
        if (isPerTurnDedupableTool(call.name)) turnToolResultCache.set(signature, cachedRead);
        continue;
      }
    }

    const noopResult = getNoopToolResult(call);
    if (noopResult) {
      if (shouldPrintNotice(turnNoticeCache, `noop:${signature}:${noopResult}`)) {
        io.showNotice(noopResult, 'dim');
      }
      messages.push({ role: 'tool', content: noopResult, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, noopResult);
      continuity.onToolResult(call.name, call.args, noopResult);
      toolResultCache.set(signature, noopResult);
      turnToolResultCache.set(signature, noopResult);
      continue;
    }

    const cached = toolResultCache.get(signature);
    if (cached && isStableCachedResult(call.name, cached)) {
      if (shouldPrintNotice(turnNoticeCache, `cache:${signature}:${cached}`)) {
        io.showNotice(cached, 'dim');
      }
      messages.push({ role: 'tool', content: cached, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, cached);
      continuity.onToolResult(call.name, call.args, cached);
      turnToolResultCache.set(signature, cached);
      continue;
    }

    const callError = validateToolCall(call, tools);
    if (callError) {
      if (shouldPrintNotice(turnNoticeCache, `policy:${signature}:${callError}`)) {
        io.showNotice(`Policy blocked: ${callError}`, 'warn');
      }
      const err = `Error: ${callError}`;
      messages.push({ role: 'tool', content: err, name: call.name, tool_call_id: call.id });
      toolResultCache.set(signature, err);
      turnToolResultCache.set(signature, err);
      continue;
    }

    const continuityError = continuity.validateToolCall(call);
    if (continuityError) {
      if (shouldPrintNotice(turnNoticeCache, `continuity:${signature}:${continuityError}`)) {
        io.showNotice(`Policy blocked: ${continuityError}`, 'warn');
      }
      const err = `Error: ${continuityError}`;
      messages.push({ role: 'tool', content: err, name: call.name, tool_call_id: call.id });
      toolResultCache.set(signature, err);
      turnToolResultCache.set(signature, err);
      continue;
    }

    const tool = tools.find(t => t.name === call.name);
    if (!tool) continue;

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
      const toolContext: ToolExecutionContext = {
        signal: interrupt.getSignal(),
        onOutput: (chunk) => io.showToolOutput(chunk),
      };
      const result = await tool.execute(call.args, toolContext);
      stopSpinner();
      io.showToolResult(result);
      messages.push({ role: 'tool', content: result, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, result);
      continuity.onToolResult(call.name, call.args, result);
      if (call.name === 'read_file' && typeof call.args?.path === 'string') {
        turnReadCache.set(normalizeTargetPath(call.args.path), result);
      }
      toolResultCache.set(signature, result);
      if (isPerTurnDedupableTool(call.name)) {
        turnToolResultCache.set(signature, result);
      }
    } catch (err: any) {
      stopSpinner();
      const errResult = `Error: ${err.message}`;
      io.showToolError(err.message);
      messages.push({ role: 'tool', content: errResult, name: call.name, tool_call_id: call.id });
      memory.addToolResult(call.name, call.args, errResult);
      continuity.onToolResult(call.name, call.args, errResult);
      if (call.name === 'read_file' && typeof call.args?.path === 'string') {
        turnReadCache.set(normalizeTargetPath(call.args.path), errResult);
      }
      toolResultCache.set(signature, errResult);
      if (isPerTurnDedupableTool(call.name)) {
        turnToolResultCache.set(signature, errResult);
      }
    }
  }

  return { stopTurn: false };
}

export async function executeHarnessTurn(options: TurnExecutionOptions): Promise<{ producedOutput: boolean }> {
  const { provider, taskInput, messages, io, tools } = options;
  const turnToolResultCache = new Map<string, string>();
  const turnNoticeCache = new Set<string>();
  const turnReadCache = new Map<string, string>();
  const interrupt = createTurnInterruptController();
  let producedOutput = false;

  try {
    while (true) {
      const { response, cancelled, streamed } = await requestAssistantResponse(
        provider,
        messages,
        tools,
        io,
        true,
        taskInput,
        interrupt
      );

      if (cancelled) {
        io.showNotice('Request interrupted.', 'warn');
        break;
      }

      if (!response || ((!response.content || !response.content.trim()) && (!response.toolCalls || response.toolCalls.length === 0))) {
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
      if (response.toolCalls && response.toolCalls.length > 0) {
        assistantMessage.tool_calls = response.toolCalls;
      }
      messages.push(assistantMessage);

      if (interrupt.isInterrupted() && response.toolCalls && response.toolCalls.length > 0) {
        io.showNotice('Interrupted. Skipping remaining tool execution for this turn.', 'warn');
        break;
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        const { stopTurn } = await executeToolCalls(
          response,
          options,
          interrupt,
          turnToolResultCache,
          turnReadCache,
          turnNoticeCache
        );
        producedOutput = true;
        if (stopTurn) break;
        continue;
      }

      break;
    }
  } finally {
    interrupt.stop();
  }

  return { producedOutput };
}

export function createTerminalTurnIO(): TurnExecutionIO {
  return {
    startSpinner,
    async renderAssistant(text: string) {
      process.stdout.write('\n' + THEME.icon('◈ ') + THEME.header('Sentinel') + THEME.dim(` ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) + '\n');
      await streamText(renderMarkdown(text));
      process.stdout.write('\n');
    },
    beginAssistantStream() {
      process.stdout.write('\n' + THEME.icon('◈ ') + THEME.header('Sentinel') + THEME.dim(` ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) + '\n');
    },
    pushAssistantChunk(text: string) {
      process.stdout.write(text);
    },
    endAssistantStream() {
      process.stdout.write('\n\n');
    },
    async showPlan(plan: string) {
      process.stdout.write('\n' + THEME.icon('◈ ') + chalk.bold.hex(COLORS.green300)('Plan') + THEME.dim(' ›') + '\n');
      await streamText(renderMarkdown(plan));
      process.stdout.write('\n');
    },
    showNotice(message: string, tone: 'dim' | 'warn' | 'error' = 'dim') {
      const color = tone === 'warn' ? chalk.yellow : tone === 'error' ? chalk.red : chalk.dim;
      process.stdout.write(color(`  └ ${message}\n\n`));
    },
    showNoResponse() {
      process.stdout.write(`\n${chalk.yellow('⚠')} ${chalk.yellow('No response received.')}\n\n`);
    },
    showToolStart(tool: ToolDefinition, label: string) {
      process.stdout.write('\n' + THEME.border('╭─ ') + THEME.header(`[Tool] ${tool.displayName || tool.name} `) + THEME.dim(label) + '\n');
    },
    showToolOutput(chunk: ToolOutputChunk) {
      const lines = String(chunk.text).replace(/\r/g, '').split('\n');
      const color = chunk.stream === 'stderr'
        ? chalk.hex(COLORS.slate500)
        : chunk.stream === 'system'
          ? chalk.hex(COLORS.green300)
          : THEME.dim;
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(THEME.border('│ ') + color(line) + '\n');
      }
    },
    showToolResult(result: string) {
      printToolResultPreview(result);
      process.stdout.write(THEME.border('╰─') + chalk.hex(COLORS.green400)(' ✔ done') + '\n\n');
    },
    showToolError(message: string) {
      process.stdout.write(THEME.border('╰─') + chalk.hex(COLORS.slate600)(` ✖ ${message}`) + '\n\n');
    },
  };
}

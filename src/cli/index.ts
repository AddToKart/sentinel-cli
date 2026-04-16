import { Command } from 'commander';
import chalk from 'chalk';
import { search, Separator, input } from '@inquirer/prompts';
import readline from 'readline';
import figures from 'figures';
import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig } from '../config/index.js';
import { ProviderFactory } from '../providers/index.js';
import { AIProvider, Message, ProviderResponse } from '../providers/types.js';
import { tools } from '../tools/index.js';
import { AVAILABLE_MODELS } from './core/models.js';
import { safePrompt, ensureApiKey } from './core/auth.js';
import { confirmTool, confirmYesNo } from './core/tool-confirmation.js';
import { composeSystemPrompt, injectMentionedContextWithMetadata, readProjectContext } from './core/context.js';
import { G, G_LIGHT } from './ui/theme.js';
import { buildStatusBar, renderMarkdown, renderWelcome, startSpinner, streamText } from './ui/rendering.js';
import { smartInput } from './ui/smart-input.js';
import { createTurnInterruptController } from './core/request-interrupt.js';
import {
  HarnessMemory,
  TaskContinuityTracker,
  buildMemoryContext,
  buildPlanningRequest,
  buildPolicyHints,
  buildSelfCritiquePrompt,
  injectHarnessContext,
  isHeavyTask,
  shouldSelfCritique,
  validateToolCall
} from './core/intelligence.js';

export const program = new Command();

type PlanningMode = 'auto' | 'on' | 'off';

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function withEol(content: string, eol: '\r\n' | '\n'): string {
  return normalizeNewlines(content).replace(/\n/g, eol);
}

function normalizeTargetPath(filePath: string): string {
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

function isPerTurnDedupableTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'edit_file';
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

async function runSelfCritiqueIfNeeded(
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
      tools
    );
    if (improved?.content && improved.content.trim().length > 0) return improved;
  } catch {
    return response;
  }
  return response;
}

async function runPlanningPass(provider: AIProvider, messages: Message[], taskInput: string): Promise<string> {
  const stop = startSpinner('Planning...');
  try {
    const planResp = await provider.sendMessage([...messages, { role: 'user', content: buildPlanningRequest(taskInput) }], tools);
    return planResp.content || '';
  } finally {
    stop();
  }
}

export async function startChat(providerName?: string, modelName?: string) {
  const config = loadConfig();
  let currentProvider = providerName || config.DEFAULT_PROVIDER;
  const configKey = `${currentProvider.toUpperCase()}_MODEL`;
  let currentModel = modelName || (config as any)[configKey];
  let planningMode: PlanningMode = 'auto';
  const memory = new HarnessMemory();
  const continuity = new TaskContinuityTracker();

  renderWelcome(currentProvider, currentModel);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  const restoreStdin = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  process.once('exit', restoreStdin);

  const projectContext = readProjectContext();
  if (projectContext) {
    process.stdout.write(chalk.dim(' 📋 Loaded SENTINEL.md project context\n\n'));
  }

  const fullSystemPrompt = composeSystemPrompt(projectContext, '--- Project Context (from SENTINEL.md) ---');
  let messages: Message[] = [{ role: 'system', content: fullSystemPrompt }];
  const toolResultCache = new Map<string, string>();

  while (true) {
    const ctxChars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
    const approxTokens = Math.round(ctxChars / 4);
    const statusLines = buildStatusBar(currentModel, approxTokens);

    const userInput = await smartInput(statusLines);
    if (userInput === null) continue;

    let trimmedInput = userInput.trim();
    if (!trimmedInput) continue;

    if (trimmedInput.startsWith('/')) {
      const parts = trimmedInput.split(' ');
      const command = (parts[0] ?? '').toLowerCase();

      if (command === '/exit' || command === '/quit') break;

      if (command === '/planning') {
        const next = (parts[1] ?? '').toLowerCase();
        if (next === 'on' || next === 'off' || next === 'auto') {
          planningMode = next as PlanningMode;
          console.log(chalk.green(`\n ✔ Planning mode set to ${planningMode}\n`));
        } else {
          console.log(chalk.dim(`\n Planning mode: ${planningMode} (use /planning auto|on|off)\n`));
        }
        continue;
      }

      if (command === '/clear') {
        messages = [{ role: 'system', content: fullSystemPrompt }];
        continuity.reset();
        renderWelcome(currentProvider, currentModel);
        console.log(chalk.dim(' Conversation history cleared.\n'));
        continue;
      }

      if (command === '/compact') {
        const systemMsgs = messages.filter(m => m.role === 'system');
        const nonSystem = messages.filter(m => m.role !== 'system');
        const kept = nonSystem.slice(-8);
        const removed = nonSystem.length - kept.length;
        messages = [...systemMsgs, ...kept];
        console.log(chalk.green(`\n ✔ Compacted: removed ${removed} older messages, kept ${kept.length}.\n`));
        continue;
      }

      if (command === '/stats') {
        const msgCount = messages.filter(m => m.role !== 'system').length;
        const userMsgs = messages.filter(m => m.role === 'user').length;
        const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
        const toolMsgs = messages.filter(m => m.role === 'tool').length;
        const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
        const approx = Math.round(totalChars / 4);
        console.log(chalk.cyan('\n  ┌─ Session Stats ─────────────────'));
        console.log(chalk.dim('  │ ') + chalk.white('Provider: ') + chalk.cyan(currentProvider));
        console.log(chalk.dim('  │ ') + chalk.white('Model:    ') + chalk.cyan(currentModel));
        console.log(chalk.dim('  │ ') + chalk.white('Messages: ') + chalk.yellow(`${msgCount}`) + chalk.dim(` (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool)`));
        console.log(chalk.dim('  │ ') + chalk.white('Context:  ') + chalk.yellow(`~${approx.toLocaleString()} tokens`) + chalk.dim(` (${(totalChars / 1024).toFixed(1)} KB)`));
        console.log(chalk.dim('  │ ') + chalk.white('Planning: ') + chalk.yellow(planningMode));
        console.log(chalk.dim('  │ ') + chalk.white('Mode:     ') + chalk.yellow(continuity.getMode()));
        console.log(chalk.dim('  │ ') + chalk.white('Focus:    ') + chalk.yellow(String(continuity.getFocusedFiles().length)) + chalk.dim(' tracked files'));
        console.log(chalk.cyan('  └──────────────────────────────────\n'));
        continue;
      }

      if (command === '/tools') {
        console.log(chalk.cyan('\n  ┌─ Available Tools ────────────────'));
        for (const t of tools) {
          const icon = t.requiresConfirmation ? chalk.yellow('⚠') : chalk.hex(G)('◆');
          console.log(chalk.dim('  │ ') + icon + ' ' + chalk.bold.white(t.name) + chalk.dim(` — ${t.description.slice(0, 60)}...`));
        }
        console.log(chalk.cyan('  └──────────────────────────────────\n'));
        continue;
      }

      if (command === '/save') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `sentinel-session-${timestamp}.md`;
        const filePath = path.join(process.cwd(), filename);
        const content = messages
          .filter(m => m.role !== 'system')
          .map(m => {
            const role = m.role === 'user' ? '**User**' : m.role === 'assistant' ? '**Sentinel**' : `**[Tool: ${m.name}]**`;
            return `### ${role}\n${m.content}\n`;
          })
          .join('\n---\n\n');
        const header = `# Sentinel Session\n> ${currentProvider} / ${currentModel}\n> ${new Date().toLocaleString()}\n\n---\n\n`;
        fs.writeFileSync(filePath, header + content, 'utf-8');
        console.log(chalk.green(`\n ✔ Session saved to ${chalk.bold(filename)}\n`));
        continue;
      }

      if (command === '/models') {
        const selected: any = await safePrompt(() => search({
          message: 'Select Model (Inspect or type to search)',
          source: async (term) => {
            if (!term) return AVAILABLE_MODELS;
            const t = term.toLowerCase();
            return AVAILABLE_MODELS.filter(m =>
              !(m instanceof Separator) && ((m as any).value.model.toLowerCase().includes(t) || (m as any).value.provider.toLowerCase().includes(t))
            );
          }
        }));

        if (!selected) continue;

        let newModel = selected.model;
        let newProvider = selected.provider;

        if (newModel === 'custom') {
          const customName = await safePrompt(() => input({ message: 'Enter custom model name:' }));
          if (!customName) continue;
          newModel = customName;
          newProvider = 'openrouter';
        }

        await ensureApiKey(newProvider, config);

        currentModel = newModel;
        currentProvider = newProvider;
        const providerModelKey = `${currentProvider.toUpperCase()}_MODEL`;
        (config as any)[providerModelKey] = currentModel;
        config.DEFAULT_PROVIDER = currentProvider as any;
        saveConfig({ [providerModelKey]: currentModel, DEFAULT_PROVIDER: currentProvider as any } as any);

        renderWelcome(currentProvider, currentModel);
        console.log(chalk.green(` ${figures.tick} Switched and saved to ${currentModel} (${currentProvider})\n`));
        continue;
      }

      if (command === '/init') {
        const mdPath = path.join(process.cwd(), 'SENTINEL.md');
        if (fs.existsSync(mdPath)) {
          console.log(chalk.yellow(` ${figures.warning} SENTINEL.md already exists in this directory.\n`));
        } else {
          fs.writeFileSync(mdPath, `# Sentinel Context\n\nDescribe your project, coding style, and any rules Sentinel should follow.\n\n## Project\n- **Name**: \n- **Stack**: \n- **Notes**: \n`);
          console.log(chalk.green(` ${figures.tick} Generated SENTINEL.md! Add your custom context there.\n`));
        }
        continue;
      }

      if (command === '/help') {
        console.log(chalk.cyan('\n  ┌─ Sentinel Commands ──────────────'));
        const cmds = [
          ['/models',   'Switch AI model and provider'],
          ['/tools',    'List all available agent tools'],
          ['/stats',    'Show session stats & token usage'],
          ['/compact',  'Trim old messages to free context'],
          ['/planning', 'Planning mode (auto|on|off)'],
          ['/save',     'Export session to markdown file'],
          ['/init',     'Generate a SENTINEL.md project file'],
          ['/clear',    'Clear conversation history'],
          ['/exit',     'Close Sentinel'],
        ];
        for (const [cmd, desc] of cmds) {
          console.log(chalk.dim('  │ ') + chalk.cyan.bold((cmd ?? '').padEnd(10)) + chalk.white(desc));
        }
        console.log(chalk.dim('  │'));
        console.log(chalk.dim('  │ ') + chalk.white.bold('File mentions'));
        console.log(chalk.dim('  │ ') + chalk.dim('Type ') + chalk.cyan('@') + chalk.dim(' to browse files, or just name a file (e.g. ') + chalk.cyan('calculator.html') + chalk.dim(')'));
        console.log(chalk.cyan('  └──────────────────────────────────\n'));
        continue;
      }

      console.log(chalk.yellow(`\n ⚠ Unknown command: ${command}. Type /help for a list.\n`));
      continue;
    }

    const taskInput = trimmedInput;
    continuity.onUserInput(taskInput);
    const hasKey = await ensureApiKey(currentProvider, config);
    if (!hasKey) continue;

    let provider: AIProvider;
    try {
      provider = ProviderFactory.getProvider(currentProvider, config, currentModel);
    } catch (err: any) {
      console.log(chalk.red(`\n ${figures.cross} Provider Setup Error: ${err.message || err}`));
      continue;
    }

    const shouldPlan = planningMode === 'on' || (planningMode === 'auto' && isHeavyTask(taskInput));
    if (shouldPlan) {
      const accepted = planningMode === 'on'
        ? true
        : await confirmYesNo('Heavy task detected. Start with a plan first?', true);

      if (accepted) {
        const plan = await runPlanningPass(provider, messages, taskInput);
        if (plan.trim()) {
          process.stdout.write('\n' + chalk.hex(G)('◆') + ' ' + chalk.bold.hex(G_LIGHT)('Plan') + chalk.dim(' ›') + '\n');
          await streamText(renderMarkdown(plan));
          process.stdout.write('\n');
          memory.addSummary('plan', plan);
        }
        const proceed = await confirmYesNo('Proceed with execution now?', true);
        if (!proceed) continue;
      }
    }

    const mentionContext = await injectMentionedContextWithMetadata(taskInput);
    if (mentionContext.loadedFiles.length > 0) {
      continuity.setExplicitTurnFiles(mentionContext.loadedFiles);
    }
    let executionInput = mentionContext.content;
    const continuityContext = continuity.buildContextBlock();
    const policyHints = [...buildPolicyHints(taskInput), ...continuity.buildHints()];
    const memoryContext = [continuityContext, buildMemoryContext(taskInput, memory)].filter(Boolean).join('\n\n');
    executionInput = injectHarnessContext(
      executionInput,
      memoryContext,
      policyHints
    );
    messages.push({ role: 'user', content: executionInput });
    const turnToolResultCache = new Map<string, string>();
    const turnNoticeCache = new Set<string>();
    const turnReadCache = new Map<string, string>();
    const autoLoadedPathSet = new Set(mentionContext.loadedFiles.map(p => normalizeTargetPath(p)));
    const interrupt = createTurnInterruptController();
    let producedOutputThisTurn = false;

    try {
      while (true) {
        let response: ProviderResponse | undefined;

        if (provider.streamMessage) {
          let stop = startSpinner('Thinking...');
          let streamError: any = null;
          let tokenCount = 0;

          try {
            const result = await interrupt.run(() =>
              provider.streamMessage!(messages, tools, (_chunk: string) => {
                tokenCount++;
                if (tokenCount === 1) {
                  stop();
                  stop = startSpinner('Generating...');
                }
              })
            );
            stop();
            if (result.cancelled) {
              if (interrupt.isHardCancelled() && !producedOutputThisTurn) popLastUserIfPending(messages);
              break;
            }
            response = result.value;
          } catch (err: any) {
            stop();
            streamError = err;
          }

          if (streamError) {
            const errMsg = (streamError.message || String(streamError)).replace(/\n/g, ' ');
            const isTokenErr = /token|context.length|context_length|maximum context|too long/i.test(errMsg);
            if (isTokenErr) {
              process.stdout.write(chalk.yellow('\n  ⚠ Context limit hit. Auto-compacting...\n'));
              const sys = messages.filter(m => m.role === 'system');
              const nonSys = messages.filter(m => m.role !== 'system');
              messages = [...sys, ...nonSys.slice(-6)];
              process.stdout.write(chalk.dim('  Trimmed to last ' + Math.min(6, nonSys.length) + ' messages. Retrying...\n\n'));
              continue;
            }
            process.stdout.write('\n' + chalk.red('x') + ' ' + chalk.red('Error: ' + errMsg) + '\n\n');
            popLastUserIfPending(messages);
            break;
          }
        } else {
          const stopSpinner = startSpinner('Thinking...');
          try {
            const result = await interrupt.run(() => provider.sendMessage(messages, tools));
            stopSpinner();
            if (result.cancelled) {
              if (interrupt.isHardCancelled() && !producedOutputThisTurn) popLastUserIfPending(messages);
              break;
            }
            response = result.value;
          } catch (err: any) {
            stopSpinner();
            const errMsg = (err.message || String(err)).replace(/\n/g, ' ');
            const isTokenErr = /token|context.length|context_length|maximum context|too long/i.test(errMsg);
            if (isTokenErr) {
              process.stdout.write(chalk.yellow('\n  ⚠ Context limit hit. Auto-compacting…\n'));
              const sys = messages.filter(m => m.role === 'system');
              const nonSys = messages.filter(m => m.role !== 'system');
              messages = [...sys, ...nonSys.slice(-6)];
              process.stdout.write(chalk.dim(`  Trimmed to last ${Math.min(6, nonSys.length)} messages. Retrying…\n\n`));
              continue;
            }
            process.stdout.write(`\n${chalk.red('✖')} ${chalk.red('Error: ' + errMsg)}\n\n`);
            popLastUserIfPending(messages);
            break;
          }
        }

        if (!response || (!response.content && (!response.toolCalls || response.toolCalls.length === 0))) {
          process.stdout.write(`\n${chalk.yellow('⚠')} ${chalk.yellow('No response received.')}\n\n`);
          popLastUserIfPending(messages);
          break;
        }

        response = await runSelfCritiqueIfNeeded(provider, messages, response, taskInput);

        if (response.content) {
          process.stdout.write('\n' + chalk.hex(G)('◆') + ' ' + chalk.bold.hex(G_LIGHT)('Sentinel') + chalk.dim(' ›') + '\n');
          await streamText(renderMarkdown(response.content));
          process.stdout.write('\n');
          memory.addSummary('assistant', response.content);
          producedOutputThisTurn = true;
        }

        const msgObj: Message = { role: 'assistant', content: response.content || '' };
        if (response.toolCalls && response.toolCalls.length > 0) {
          msgObj.tool_calls = response.toolCalls;
        }
        messages.push(msgObj);

        if (interrupt.isInterrupted() && response.toolCalls && response.toolCalls.length > 0) {
          process.stdout.write(chalk.yellow('  ⚠ Interrupted. Skipping remaining tool execution for this turn.\n\n'));
          break;
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          let stopTurn = false;
          for (const call of response.toolCalls) {
            if (interrupt.isHardCancelled()) {
              stopTurn = true;
              break;
            }
            if (interrupt.isInterrupted()) {
              process.stdout.write(chalk.yellow('  ⚠ Interrupted. Skipping remaining tool execution for this turn.\n\n'));
              stopTurn = true;
              break;
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
                  process.stdout.write(chalk.dim(`  └ ${alreadyLoaded}\n\n`));
                }
                messages.push({ role: 'tool', content: alreadyLoaded, name: call.name, tool_call_id: call.id });
                memory.addToolResult(call.name, call.args, alreadyLoaded);
                continuity.onToolResult(call.name, call.args, alreadyLoaded);
                turnReadCache.set(normalizedReadPath, alreadyLoaded);
                continue;
              }
              const cachedRead = turnReadCache.get(normalizedReadPath);
              if (cachedRead) {
                if (shouldPrintNotice(turnNoticeCache, `readcache:${normalizedReadPath}`)) {
                  process.stdout.write(chalk.dim(`  └ Reused cached read: ${call.args.path}\n\n`));
                }
                messages.push({ role: 'tool', content: cachedRead, name: call.name, tool_call_id: call.id });
                memory.addToolResult(call.name, call.args, cachedRead);
                continuity.onToolResult(call.name, call.args, cachedRead);
                continue;
              }
            }

            const noopResult = getNoopToolResult(call);
            if (noopResult) {
              if (shouldPrintNotice(turnNoticeCache, `noop:${signature}:${noopResult}`)) {
                process.stdout.write(chalk.dim(`  └ ${noopResult}\n\n`));
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
                process.stdout.write(chalk.dim(`  └ ${cached}\n\n`));
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
                process.stdout.write(chalk.yellow(`  └ Policy blocked: ${callError}\n\n`));
              }
              messages.push({ role: 'tool', content: `Error: ${callError}`, name: call.name, tool_call_id: call.id });
              toolResultCache.set(signature, `Error: ${callError}`);
              turnToolResultCache.set(signature, `Error: ${callError}`);
              continue;
            }
            const continuityError = continuity.validateToolCall(call);
            if (continuityError) {
              if (shouldPrintNotice(turnNoticeCache, `continuity:${signature}:${continuityError}`)) {
                process.stdout.write(chalk.yellow(`  └ Policy blocked: ${continuityError}\n\n`));
              }
              messages.push({ role: 'tool', content: `Error: ${continuityError}`, name: call.name, tool_call_id: call.id });
              toolResultCache.set(signature, `Error: ${continuityError}`);
              turnToolResultCache.set(signature, `Error: ${continuityError}`);
              continue;
            }

            const tool = tools.find(t => t.name === call.name);
            if (!tool) continue;

            const label = tool.getLabel ? tool.getLabel(call.args) : call.name;
            const displayName = tool.displayName || tool.name;

            if (tool.requiresConfirmation) {
              const approved = await confirmTool(tool, call.args);
              if (!approved) {
                process.stdout.write(chalk.dim('  └ Skipped.\n\n'));
                messages.push({ role: 'tool', content: 'User declined to run this action.', name: call.name, tool_call_id: call.id });
                continue;
              }
            }

            process.stdout.write('\n' + chalk.cyan('  ┌') + chalk.cyan.bold(` ${displayName} `) + chalk.dim(label) + '\n');
            const stopToolSpinner = startSpinner(`${displayName}...`);
            try {
              const result = await tool.execute(call.args);
              stopToolSpinner();

              const lines = result.split('\n');
              const previewLines = lines.slice(0, 12);
              for (const line of previewLines) {
                if (line.startsWith('+ ')) process.stdout.write(chalk.green('  │ ' + line) + '\n');
                else if (line.startsWith('- ')) process.stdout.write(chalk.red('  │ ' + line) + '\n');
                else process.stdout.write(chalk.dim('  │ ') + chalk.white(line) + '\n');
              }
              if (lines.length > 12) {
                process.stdout.write(chalk.dim(`  │ ... (${lines.length - 12} more lines)`) + '\n');
              }
              process.stdout.write(chalk.cyan('  └') + chalk.green(' ✔ done') + '\n\n');
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
              producedOutputThisTurn = true;
            } catch (toolErr: any) {
              stopToolSpinner();
              process.stdout.write(chalk.cyan('  └') + chalk.red(` ✖ ${toolErr.message}`) + '\n\n');
              const errResult = `Error: ${toolErr.message}`;
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
              producedOutputThisTurn = true;
            }
          }
          if (stopTurn) break;
          continue;
        }

        break;
      }
    } finally {
      interrupt.stop();
    }
  }
}

program
  .command('chat')
  .description('Start an interactive chat session')
  .option('-p, --provider <provider>', 'LLM provider (gemini, openai, anthropic, openrouter)')
  .option('-m, --model <model>', 'Model name to use')
  .action(async (options) => {
    await startChat(options.provider, options.model);
  });

program
  .command('run <prompt>')
  .description('Run a one-shot prompt and exit (non-interactive)')
  .option('-p, --provider <provider>', 'LLM provider')
  .option('-m, --model <model>', 'Model name')
  .action(async (prompt, options) => {
    await runOnce(prompt, options.provider, options.model);
  });

program
  .command('config')
  .description('Configure API keys and settings')
  .option('-g, --gemini <key>', 'Set Gemini API Key')
  .option('--openai <key>', 'Set OpenAI API Key')
  .option('--anthropic <key>', 'Set Anthropic API Key')
  .option('--openrouter <key>', 'Set OpenRouter API Key')
  .option('-m, --model <model>', 'Set default model')
  .action((options) => {
    const updates: any = {};
    if (options.gemini) { updates.GEMINI_API_KEY = options.gemini; console.log(chalk.green(' ✔ Gemini API key saved')); }
    if (options.openai) { updates.OPENAI_API_KEY = options.openai; console.log(chalk.green(' ✔ OpenAI API key saved')); }
    if (options.anthropic) { updates.ANTHROPIC_API_KEY = options.anthropic; console.log(chalk.green(' ✔ Anthropic API key saved')); }
    if (options.openrouter) { updates.OPENROUTER_API_KEY = options.openrouter; console.log(chalk.green(' ✔ OpenRouter API key saved')); }
    if (options.model) { updates.GEMINI_MODEL = options.model; console.log(chalk.green(` ✔ Default model set to ${options.model}`)); }
    if (Object.keys(updates).length > 0) {
      saveConfig(updates);
    } else {
      console.log(chalk.dim('  No changes. Use --help to see options.'));
    }
  });

export async function runOnce(prompt: string, providerName?: string, modelName?: string) {
  const config = loadConfig();
  const currentProvider = providerName || config.DEFAULT_PROVIDER;
  const configKey = `${currentProvider.toUpperCase()}_MODEL`;
  const currentModel = modelName || (config as any)[configKey];
  const memory = new HarnessMemory();
  const continuity = new TaskContinuityTracker();
  continuity.onUserInput(prompt);

  const projectContext = readProjectContext();
  const systemContent = composeSystemPrompt(projectContext, '--- Project Context ---');
  const hasKey = await ensureApiKey(currentProvider, config);
  if (!hasKey) process.exit(1);

  const provider = ProviderFactory.getProvider(currentProvider, config, currentModel);
  const baseMessages: Message[] = [{ role: 'system', content: systemContent }];

  if (isHeavyTask(prompt)) {
    const plan = await runPlanningPass(provider, baseMessages, prompt);
    if (plan.trim()) {
      process.stdout.write('\n' + chalk.hex(G)('◆') + ' ' + chalk.bold.hex(G_LIGHT)('Plan') + chalk.dim(' ›') + '\n');
      await streamText(renderMarkdown(plan));
      process.stdout.write('\n');
      memory.addSummary('plan', plan);
    }
  }

  const mentionContext = await injectMentionedContextWithMetadata(prompt);
  if (mentionContext.loadedFiles.length > 0) {
    continuity.setExplicitTurnFiles(mentionContext.loadedFiles);
  }
  const continuityContext = continuity.buildContextBlock();
  const policyHints = [...buildPolicyHints(prompt), ...continuity.buildHints()];
  const memoryContext = [continuityContext, buildMemoryContext(prompt, memory)].filter(Boolean).join('\n\n');
  const executionInput = injectHarnessContext(mentionContext.content, memoryContext, policyHints);
  const messages: Message[] = [...baseMessages, { role: 'user', content: executionInput }];
  const toolResultCache = new Map<string, string>();
  const interrupt = createTurnInterruptController();
  let enabledRawMode = false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    enabledRawMode = true;
  }

  try {
    const stopSpinner = startSpinner('Thinking...');
    let response: ProviderResponse;
    try {
      const firstResult = await interrupt.run(() => provider.sendMessage(messages, tools));
      stopSpinner();
      if (firstResult.cancelled) {
        process.stdout.write(chalk.yellow('\n  ⚠ Request interrupted.\n'));
        return;
      }
      response = firstResult.value!;
    } catch (err: any) {
      stopSpinner();
      process.stderr.write(chalk.red(`Error: ${err.message}\n`));
      process.exit(1);
    }

    response = await runSelfCritiqueIfNeeded(provider, messages, response, prompt);

    while (response.toolCalls && response.toolCalls.length > 0) {
      const msgObj: Message = { role: 'assistant', content: response.content || '' };
      msgObj.tool_calls = response.toolCalls;
      messages.push(msgObj);
      const turnToolResultCache = new Map<string, string>();
      const turnReadCache = new Map<string, string>();

      for (const call of response.toolCalls) {
        if (interrupt.isHardCancelled() || interrupt.isInterrupted()) {
          process.stdout.write(chalk.yellow('\n  ⚠ Interrupted. Stopping execution.\n'));
          return;
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
          const cachedRead = turnReadCache.get(normalizedReadPath);
          if (cachedRead) {
            messages.push({ role: 'tool', content: cachedRead, name: call.name, tool_call_id: call.id });
            memory.addToolResult(call.name, call.args, cachedRead);
            continuity.onToolResult(call.name, call.args, cachedRead);
            continue;
          }
        }

        const noopResult = getNoopToolResult(call);
        if (noopResult) {
          messages.push({ role: 'tool', content: noopResult, name: call.name, tool_call_id: call.id });
          memory.addToolResult(call.name, call.args, noopResult);
          continuity.onToolResult(call.name, call.args, noopResult);
          toolResultCache.set(signature, noopResult);
          turnToolResultCache.set(signature, noopResult);
          continue;
        }

        const cached = toolResultCache.get(signature);
        if (cached && isStableCachedResult(call.name, cached)) {
          messages.push({ role: 'tool', content: cached, name: call.name, tool_call_id: call.id });
          memory.addToolResult(call.name, call.args, cached);
          continuity.onToolResult(call.name, call.args, cached);
          turnToolResultCache.set(signature, cached);
          continue;
        }

        const callError = validateToolCall(call, tools);
        if (callError) {
          const err = `Error: ${callError}`;
          messages.push({ role: 'tool', content: err, name: call.name, tool_call_id: call.id });
          toolResultCache.set(signature, err);
          turnToolResultCache.set(signature, err);
          continue;
        }
        const continuityError = continuity.validateToolCall(call);
        if (continuityError) {
          const err = `Error: ${continuityError}`;
          messages.push({ role: 'tool', content: err, name: call.name, tool_call_id: call.id });
          toolResultCache.set(signature, err);
          turnToolResultCache.set(signature, err);
          continue;
        }
        const tool = tools.find(t => t.name === call.name);
        if (tool) {
          process.stdout.write(chalk.cyan(`\n  ┌ ${tool.displayName || tool.name} `) + chalk.dim(tool.getLabel ? tool.getLabel(call.args) : '') + '\n');
          try {
            const result = await tool.execute(call.args);
            process.stdout.write(chalk.cyan('  └') + chalk.green(' ✔ done\n'));
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
          } catch (e: any) {
            const errResult = `Error: ${e.message}`;
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
      }

      const stopS = startSpinner('Thinking...');
      try {
        const result = await interrupt.run(() => provider.sendMessage(messages, tools));
        stopS();
        if (result.cancelled) {
          process.stdout.write(chalk.yellow('\n  ⚠ Request interrupted.\n'));
          return;
        }
        response = result.value!;
      } catch {
        stopS();
        break;
      }
      response = await runSelfCritiqueIfNeeded(provider, messages, response, prompt);
    }

    if (response.content) {
      process.stdout.write('\n' + renderMarkdown(response.content) + '\n\n');
    }
  } finally {
    interrupt.stop();
    if (enabledRawMode && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}

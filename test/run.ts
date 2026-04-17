import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { buildSmartInputFrame, getCommandSuggestions } from '../src/cli/ui/smart-input.js';
import { renderMarkdown } from '../src/cli/ui/rendering.js';
import { injectMentionedContextWithMetadata } from '../src/cli/core/context.js';
import { HarnessMemory, TaskContinuityTracker } from '../src/cli/core/intelligence.js';
import { executeHarnessTurn, runPlanningPass, type TurnExecutionIO } from '../src/cli/core/turn-executor.js';
import type { AIProvider, Message, ProviderResponse } from '../src/providers/types.js';
import { runStreamingShellCommand, type ShellSpawnFactory, type ToolDefinition, type ToolOutputChunk } from '../src/tools/index.js';

type Case = {
  name: string;
  run: () => Promise<void> | void;
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function createTestIO(): TurnExecutionIO & { notices: string[]; assistant: string[]; toolResults: string[]; toolOutput: ToolOutputChunk[] } {
  return {
    notices: [],
    assistant: [],
    toolResults: [],
    toolOutput: [],
    startSpinner: () => () => {},
    async renderAssistant(text: string) {
      this.assistant.push(text);
    },
    beginAssistantStream() {},
    pushAssistantChunk(text: string) {
      this.assistant.push(text);
    },
    endAssistantStream() {},
    async showPlan() {},
    showNotice(message: string) {
      this.notices.push(message);
    },
    showNoResponse() {
      this.notices.push('no-response');
    },
    showToolStart() {},
    showToolOutput(chunk: ToolOutputChunk) {
      this.toolOutput.push(chunk);
    },
    showToolResult(result: string) {
      this.toolResults.push(result);
    },
    showToolError(message: string) {
      this.notices.push(message);
    },
  };
}

function withTempDir<T>(run: (dir: string) => Promise<T> | T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function nodeCommand(source: string) {
  return `"${process.execPath}" -e "${source.replace(/"/g, '\\"')}"`;
}

function createFakeSpawn(onStart: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean }) => void): ShellSpawnFactory {
  return () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 1, 'SIGTERM'));
      return true;
    };
    onStart(child);
    return child as any;
  };
}

const cases: Case[] = [
  {
    name: 'smart input returns direct and fallback slash-command suggestions',
    run() {
      assert.deepEqual(getCommandSuggestions('/pl'), ['/planning']);
      assert.deepEqual(getCommandSuggestions('/tool'), ['/tools']);
      assert.equal(getCommandSuggestions('hello').length, 0);
    }
  },
  {
    name: 'smart input frame preserves prompt geometry when suggestions are shown',
    run() {
      const frame = buildSmartInputFrame({
        width: 80,
        buffer: '/pl',
        statusLines: ['status'],
        mentionStart: -1,
        mentionFiltered: [],
        mentionSelectedIdx: 0,
        commandFiltered: ['/planning'],
        commandSelectedIdx: 0,
      });
      assert.equal(frame.inputRowIndex, 2);
      assert.equal(frame.rowsBelowInput, 3);
      assert.ok(frame.cursorColumn > 0);
      assert.equal(frame.lines[0], 'status');
    }
  },
  {
    name: 'render markdown highlights fenced html without mutating code content',
    run() {
      const rendered = renderMarkdown('```html\n<div class="hero">Hello</div>\n```');
      const plain = stripAnsi(rendered);
      assert.match(plain, /╭─ html /);
      assert.match(plain, /<div class="hero">Hello<\/div>/);
    }
  },
  {
    name: 'mentioned files load related local assets into the working set',
    async run() {
      await withTempDir(async (dir) => {
        fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'test', 'index.html'), '<link rel="stylesheet" href="./styles.css"><script src="./script.js"></script>');
        fs.writeFileSync(path.join(dir, 'test', 'styles.css'), 'body { color: red; }');
        fs.writeFileSync(path.join(dir, 'test', 'script.js'), 'console.log("hi");');

        const previousCwd = process.cwd();
        process.chdir(dir);
        try {
          const result = await injectMentionedContextWithMetadata('@test/index.html redesign this');
          assert.equal(result.anchorFiles.length, 1);
          assert.equal(result.relatedFiles.length, 2);
          assert.equal(result.workingSetFiles.length, 3);
          assert.match(result.content, /Related File: test\/styles\.css/);
          assert.match(result.content, /Related File: test\/script\.js/);
        } finally {
          process.chdir(previousCwd);
        }
      });
    }
  },
  {
    name: 'continuity tracker exposes and enforces the explicit working set',
    run() {
      const tracker = new TaskContinuityTracker();
      tracker.onUserInput('@test/index.html redesign this');
      tracker.setTurnContextFiles(
        ['C:/repo/test/index.html'],
        ['C:/repo/test/styles.css'],
        ['C:/repo/test/index.html', 'C:/repo/test/styles.css', 'C:/repo/test/script.js']
      );

      const snapshot = tracker.getWorkingSet();
      assert.equal(snapshot.selected.length, 3);
      assert.ok(tracker.buildHints().some(hint => hint.includes('Current working set:')));
      assert.equal(tracker.validateToolCall({ name: 'edit_file', args: { path: 'C:/repo/test/script.js' } }), null);
      assert.match(
        tracker.validateToolCall({ name: 'edit_file', args: { path: 'C:/repo/other/away.ts' } }) || '',
        /stay near the files anchored this turn/i
      );
    }
  },
  {
    name: 'planning pass disables tool access',
    async run() {
      let receivedTools: any[] | undefined;
      const provider: AIProvider = {
        name: 'fake',
        async sendMessage(_messages, tools): Promise<ProviderResponse> {
          receivedTools = tools;
          return { content: '1) Scope\n2) Plan\n3) Risks\n4) First action' };
        }
      };

      const plan = await runPlanningPass(provider, [{ role: 'system', content: 'sys' }], 'redesign test/index.html');
      assert.ok(plan.includes('1) Scope'));
      assert.deepEqual(receivedTools, []);
    }
  },
  {
    name: 'shared turn executor renders final assistant text after streamed response',
    async run() {
      const streamedContent = [
        'Here is your snippet:',
        '',
        '```html',
        '<div class="hero">Hello</div>',
        '```',
      ].join('\n');

      const provider: AIProvider = {
        name: 'fake',
        async sendMessage(): Promise<ProviderResponse> {
          assert.fail('sendMessage should not be called when streamMessage succeeds');
        },
        async streamMessage(_messages, _tools, onChunk): Promise<ProviderResponse> {
          onChunk('Here is your ');
          onChunk('snippet...');
          return { content: streamedContent };
        }
      };

      const io = createTestIO();
      const messages: Message[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'show html snippet' },
      ];

      const result = await executeHarnessTurn({
        provider,
        taskInput: 'show html snippet',
        messages,
        memory: new HarnessMemory(),
        continuity: new TaskContinuityTracker(),
        tools: [],
        toolResultCache: new Map(),
        io,
      });

      assert.equal(result.producedOutput, true);
      assert.deepEqual(io.assistant, [streamedContent]);
    }
  },
  {
    name: 'shared turn executor dedupes repeated read-only tool calls in a turn',
    async run() {
      let sendCount = 0;
      let executions = 0;
      const provider: AIProvider = {
        name: 'fake',
        async sendMessage(): Promise<ProviderResponse> {
          sendCount += 1;
          if (sendCount === 1) {
            return {
              content: '',
              toolCalls: [
                { id: 'a', name: 'list_directory', args: { path: 'test' } },
                { id: 'b', name: 'list_directory', args: { path: 'test' } },
              ]
            };
          }
          return { content: 'done' };
        }
      };

      const tool: ToolDefinition = {
        name: 'list_directory',
        description: 'List files',
        parameters: { type: 'object', properties: {}, required: [] },
        async execute() {
          executions += 1;
          return 'Listed test';
        }
      };

      const io = createTestIO();
      const messages: Message[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'inspect test' },
      ];

      const result = await executeHarnessTurn({
        provider,
        taskInput: 'inspect test',
        messages,
        memory: new HarnessMemory(),
        continuity: new TaskContinuityTracker(),
        tools: [tool],
        toolResultCache: new Map(),
        io,
      });

      assert.equal(result.producedOutput, true);
      assert.equal(executions, 1);
      assert.ok(io.assistant.some(entry => entry.includes('done')));
    }
  },
  {
    name: 'shared turn executor skips read_file for auto-loaded mentioned files',
    async run() {
      let sendCount = 0;
      const provider: AIProvider = {
        name: 'fake',
        async sendMessage(): Promise<ProviderResponse> {
          sendCount += 1;
          if (sendCount === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'a', name: 'read_file', args: { path: 'test/index.html' } }]
            };
          }
          return { content: 'finished' };
        }
      };

      const readTool: ToolDefinition = {
        name: 'read_file',
        description: 'Read file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        async execute() {
          assert.fail('read_file should have been skipped because the file was auto-loaded');
        }
      };

      const cwd = process.cwd();
      const autoLoadedPath = path.join(cwd, 'test', 'index.html').toLowerCase();
      const io = createTestIO();
      await executeHarnessTurn({
        provider,
        taskInput: 'work on @test/index.html',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'work on @test/index.html' }],
        memory: new HarnessMemory(),
        continuity: new TaskContinuityTracker(),
        tools: [readTool],
        toolResultCache: new Map(),
        io,
        autoLoadedPathSet: new Set([autoLoadedPath]),
      });

      assert.ok(io.notices.some(message => message.includes('already loaded from your @mention')));
    }
  },
  {
    name: 'shell tool streams stdout and stderr while capturing final output',
    async run() {
      const chunks: string[] = [];
      const result = await runStreamingShellCommand(
        nodeCommand('process.stdout.write("alpha\\n");process.stderr.write("beta\\n");'),
        process.cwd(),
        5000,
        {
          onOutput(chunk) {
            chunks.push(`${chunk.stream}:${chunk.text}`);
          }
        },
        createFakeSpawn((child) => {
          queueMicrotask(() => {
            child.stdout.write('alpha\n');
            child.stderr.write('beta\n');
            child.emit('close', 0, null);
          });
        })
      );

      assert.match(result, /Shell command completed successfully/);
      assert.ok(chunks.some(chunk => chunk.includes('stdout:alpha')));
      assert.ok(chunks.some(chunk => chunk.includes('stderr:beta')));
    }
  },
  {
    name: 'shell tool respects harness cancellation',
    async run() {
      const controller = new AbortController();
      const pending = runStreamingShellCommand(
        nodeCommand('setTimeout(() => process.stdout.write("late\\n"), 5000);'),
        process.cwd(),
        5000,
        { signal: controller.signal },
        createFakeSpawn(() => {
          // Intentionally wait for cancellation to trigger kill().
        })
      );

      setTimeout(() => controller.abort(), 100);
      const result = await pending;
      assert.match(result, /cancelled by harness/i);
    }
  },
];

async function main() {
  let passed = 0;

  for (const entry of cases) {
    try {
      await entry.run();
      passed += 1;
      process.stdout.write(`ok ${passed} - ${entry.name}\n`);
    } catch (error: any) {
      process.stderr.write(`not ok ${passed + 1} - ${entry.name}\n`);
      process.stderr.write((error?.stack || String(error)) + '\n');
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(`1..${cases.length}\n`);
  process.stdout.write(`# pass ${passed}\n`);
}

main().catch((error) => {
  process.stderr.write((error?.stack || String(error)) + '\n');
  process.exit(1);
});

# Copilot Instructions for Sentinel CLI

## Build, test, and lint commands

- Install dependencies: `npm install`
- Development CLI (tsx): `npm run dev`
- TypeScript build: `npm run build`
- One-shot CLI command: `npm run dev -- run "your prompt here"` (or `sentinel run "your prompt here"` after build/link)
- Pipe mode: `echo "your prompt" | npm run dev`
- Test script: `npm test` *(currently a placeholder that exits with error: "no test specified")*
- Lint script: no lint script is currently defined in `package.json`
- Single-test command: no test runner is configured yet, so single-test execution is not available

## High-level architecture

- **Entry point and runtime modes** (`src/index.ts`):
  - No args + TTY: starts interactive chat.
  - Positional prompt or `run <prompt>`: executes one-shot mode via `runOnce(...)`.
  - Piped stdin with no args: reads stdin and executes one-shot mode.
- **Interactive CLI loop** (`src/cli/index.ts`):
  - Maintains conversation history as `Message[]`, seeded with a system prompt.
  - Auto-loads `SENTINEL.md` and appends it to system context.
  - Uses a custom raw-mode input UI (`smartInput`) with status bar, command/file highlighting, history navigation, and `@` mention file picker.
  - Auto-injects file contents when filenames are mentioned, and injects directory context for `@dir` mentions via `read_codebase`.
  - Supports slash commands: `/models`, `/tools`, `/stats`, `/compact`, `/save`, `/init`, `/clear`, `/help`, `/exit`, `/quit`.
  - Runs an agentic tool loop: assistant tool calls -> execute tool -> append `role: 'tool'` result -> re-query provider until no tool calls.
  - Applies a confirmation gate for tools marked `requiresConfirmation`.
- **CLI runtime loop** (`src/cli/index.ts`):
  - Prefers `streamMessage` when provider supports it; otherwise falls back to `sendMessage`.
  - On context-limit errors, automatically compacts conversation history and retries.
- **Provider abstraction** (`src/providers/types.ts`, `src/providers/index.ts`):
  - `AIProvider` interface standardizes `sendMessage(messages, tools)`.
  - Providers may implement optional `streamMessage(messages, tools, onChunk)`.
  - `ProviderFactory` constructs providers and enforces required API keys.
  - Implemented providers: **Gemini** (`src/providers/gemini.ts`) and **OpenRouter** (`src/providers/openrouter.ts`).
  - `openai` and `anthropic` provider names are selectable in UI but currently throw "Coming soon" in `ProviderFactory`.
- **Tooling layer** (`src/tools/index.ts`):
  - Tools are registry-based (`tools: ToolDefinition[]`), each with JSON-schema-like `parameters` and async `execute`.
  - Current built-in tools: `execute_shell`, `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `web_fetch`, `list_directory`, `read_codebase`, `ask_user`.
  - `write_file` and `edit_file` include omission-placeholder guards and return inline diffs.
- **Config lifecycle** (`src/config/index.ts`):
  - Reads `.sentinel.json` from current working directory.
  - Merges env vars with file config and validates via Zod.
  - Includes migration logic from legacy `DEFAULT_MODEL` to provider-specific model fields.

## Key conventions in this repository

- **ESM import convention**: local TypeScript imports include the `.js` extension (NodeNext ESM output), e.g. `import { loadConfig } from '../config/index.js'`.
- **Provider/tool protocol**:
  - Assistant tool calls are stored on `Message.tool_calls`.
  - Tool execution results are appended as `role: 'tool'` messages with `tool_call_id` and `name`.
  - Providers are responsible for adapting this message format to upstream API specifics (Gemini function responses vs OpenRouter tool messages).
- **Streaming-first provider behavior**:
  - Gemini/OpenRouter both support streaming; CLI currently buffers streamed output and renders formatted markdown once complete.
  - OpenRouter streaming reconstructs `tool_calls` incrementally from SSE deltas before returning final tool calls.
- **Session behavior differs by mode**:
  - Interactive mode enforces confirmation for risky tools (`requiresConfirmation`).
  - One-shot `runOnce` executes tool calls agentically without per-tool confirmation prompts.
- **Config source of truth**: runtime configuration is expected in `.sentinel.json` + environment variables, not hardcoded constants.
- **UI/branding conventions** (from implementation + `GEMINI.md`):
  - CLI presentation uses `chalk`, `gradient-string`, custom markdown rendering, and spinner-based feedback.
  - Interactive model selection uses `@inquirer/prompts`; the main chat input is a custom raw-mode readline UI.
- **Development workflow expectation** (from `GEMINI.md` + scripts): use `tsx` for local iteration and `tsc` (`npm run build`) as the compile gate.

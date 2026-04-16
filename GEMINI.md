# Gemini Project Context: Sentinel CLI

Sentinel CLI is a professional AI Agent CLI harness built with TypeScript and Node.js. It provides an interactive interface to interact with various LLM providers, starting with Google's Gemini models, and empowers the agent with local system tools.

## Project Overview

- **Purpose**: A customizable, branded AI agent interface for the terminal.
- **Key Technologies**:
    - **Language**: TypeScript (ESM)
    - **CLI Framework**: `commander`
    - **Interactive UI**: `@inquirer/prompts`, `chalk`, `gradient-string`, `ora`, `figures`
    - **AI SDK**: `@google/generative-ai`
    - **Validation**: `zod`
    - **Configuration**: `dotenv`, custom JSON config (`.sentinel.json`)

## Architecture & Features

The project follows a modular provider-tool architecture:
- `src/index.ts`: Entry point that bootstraps the CLI and defaults to chat mode.
- `src/cli/`: Contains the interactive chat loop and visual rendering logic.
    - **Gemini Aesthetic**: Uses `gradient-string` and minimalist labels for a premium feel.
    - **Slash Commands**:
        - `/models`: Dynamic model switcher with arrow-key selection.
        - `/clear`: Wipes conversation history and refreshes the welcome screen.
        - `/exit`: Safely terminates the session.
- `src/providers/`: Abstracted AI provider layer.
    - **GeminiProvider**: Implements full function-calling for `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, and `gemma-4-pro-preview`.
- `src/tools/`: System tools that the agent can execute (e.g., `execute_shell`, `write_file`).
- `src/config/`: Manages API keys and default settings using Zod for validation.

## Building and Running

### Prerequisites
- Node.js (v18+)
- npm

### Key Commands
- **Development**: `npm run dev` (Runs the CLI using `tsx` for real-time execution)
- **Build**: `npm run build` (Compiles TypeScript to `dist/`)
- **Configuration**: `npm run dev config -- -g YOUR_GEMINI_API_KEY`
- **Global Install**: `npm link` (Allows running `sentinel` from anywhere via the `sentinel` command)

## Development Conventions

- **Module System**: The project is configured as an ECMAScript Module (ESM). All local imports **must** include the `.js` extension (e.g., `import { x } from './file.js'`).
- **Styling**: Use the `sentinelGradient` for branding and `chalk` for semantic coloring.
- **UI Interaction**: Use the modern `@inquirer/prompts` (`select`, `input`) for all interactive inputs.
- **Error Handling**: Use `ora` spinners for long-running AI requests and wrap tool executions in try-catch blocks.
- **Tooling**: Prefer `tsx` for development and ensure `npm run build` (npx tsc) passes before finalizing changes.
- **Types**: Always provide explicit types for messages and provider responses in `src/providers/types.ts`.

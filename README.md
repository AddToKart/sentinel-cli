# Sentinel CLI 🛡️

Sentinel CLI is a professional-grade AI Agent harness built with **TypeScript** and **Node.js**. It provides a sleek, interactive terminal interface for interacting with LLMs (starting with Google's Gemini) while empowering the agent with a robust set of local system tools.

## ✨ Features

- **Interactive Chat**: A premium terminal experience using `gradient-string` and `ora` spinners.
- **Provider-Tool Architecture**: Modular design allowing for easy extension of AI providers and capabilities.
- **Advanced Function Calling**: Fully integrated with Gemini's tool-calling API.
- **Slash Commands**:
  - `/models`: Switch between available AI models (Gemini Flash, Pro, etc.).
  - `/clear`: Wipe conversation history and reset the session.
  - `/exit`: Gracefully terminate the CLI.
- **Surgical File Editing**: Specialized tools to perform precise find-and-replace operations with safety guards.
- **Codebase Context**: Tools to read entire directories or specific file patterns to provide rich context to the AI.

## 🛠️ Toolset

Sentinel CLI equips the AI agent with powerful local capabilities:

- **Shell Execution**: Run any system command safely (requires user confirmation).
- **FileSystem**: `read_file`, `write_file`, `edit_file` (surgical), and `list_directory`.
- **Search**: `grep` (content search) and `glob` (file path matching).
- **Web**: `web_fetch` to pull documentation or data from the internet.
- **Intelligence**: `read_codebase` for bulk source analysis and `ask_user` for mid-task clarifications.

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v18 or higher.
- **API Key**: A Google Gemini API key (get one at [Google AI Studio](https://aistudio.google.com/)).

### Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/youruser/sentinel-cli.git
    cd sentinel-cli
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Configure**:
    Run the configuration command to set your API key:
    ```bash
    npm run dev config -- -g YOUR_GEMINI_API_KEY
    ```
    *Alternatively, create a `.sentinel.json` or `.env` file in the root.*

4.  **Run**:
    ```bash
    npm run dev
    ```

### Global Usage

To use Sentinel from anywhere on your system:
```bash
npm link
sentinel
```

## 🏗️ Architecture

- `src/index.ts`: The main entry point and command router.
- `src/cli/`: UI rendering, chat loop, and input handling.
- `src/providers/`: AI logic and message formatting (Gemini, OpenRouter).
- `src/tools/`: Implementation of the toolset available to the agent.
- `src/config/`: Configuration management and Zod schema validation.

## 📝 Development

- **Language**: TypeScript (ESM)
- **Build**: `npm run build` (outputs to `dist/`)
- **Dev**: `npm run dev` (uses `tsx` for fast execution)

> **Note**: As an ESM project, all local imports must include the `.js` extension (e.g., `import { tools } from './tools/index.js'`).

## 📄 License

This project is licensed under the **ISC License**.

# Your +1 — Your AI Engineering Companion

**Your +1** is an autonomous AI engineering companion for Visual Studio Code, designed to pair program with developers, provide architectural insights, and streamline coding workflows.

This repository represents **Milestone 3: Context Assembly Engine**, featuring an intelligent, explainable context assembly pipeline with explicit `@file` and `@symbol` parsing, automatic semantic keyword retrieval, bounded token budgeting, and an explainable selection webview UI.

---

## Features

- **Native Activity Bar Container**: Custom `+1` icon integrated into the VS Code Activity Bar.
- **Interactive Sidebar & Explainable Context UI**: A native-styled webview introducing Your +1, its mission, live status, and an interactive Context Selection panel.
- **Explicit Context References (`@file`, `@symbol`)**:
  - `@file path/to/file.ts`: Resolves workspace-relative paths, enforces traversal protection (`..`), rejects sensitive files (`.env`, `.pem`) and binaries.
  - `@symbol SymbolName`: Resolves definitions of functions, classes, interfaces, and variables. Intelligently disambiguates duplicate symbols across files, prioritizing core source implementations over test mocks and documenting rationale.
- **Automatic Semantic Context Retrieval**: Discovers relevant files and contiguous code excerpts based on task terminology, keyword density, and active editor context without needing explicit mentions.
- **Transparent Context Budgeting**:
  - Enforces bounded token budgets (configurable via `yourplusone.maxContextBudgetTokens`, default 16,000 tokens).
  - Uses a transparent, documented token estimation heuristic (~4 chars/token).
  - Strictly prioritizes explicit references over automatic candidates.
  - Gracefully truncates or omits lower-relevance automatic excerpts when the budget is reached.
- **Explainable Selection Rationale**: Displays file paths, symbol names, retrieval sources, selection reasons, excerpt line ranges, token counts, and inclusion statuses.
- **TrueForge SDK & MCP Integration**: Dispatches assembled context directly to TrueForge agent turns while keeping read-only workspace tools (`search_workspace`, `read_file`) active.
- **Commands**:
  - `yourplusone.openWelcome`: Reveals sidebar view.
  - `yourplusone.testConnection`: Verifies runtime reachability and streams PONG response.
  - `yourplusone.runMcpProof`: Exercises embedded MCP server with TrueForge autonomous tool discovery.
  - `yourplusone.assembleContext`: Interactively assembles explainable context for any developer task.
  - `yourplusone.runTurnWithContext`: Executes an end-to-end TrueForge agent turn with assembled context.
- **Modular TypeScript Architecture**: Built with strict TypeScript compiler checks and fast esbuild bundling.

---

## Project Structure

```text
Your-Plus-One/
├── .vscode/               # VS Code launch and task configurations
├── dist/                  # Bundled extension output (esbuild)
├── resources/             # Extension assets (Activity Bar icon, test fixtures)
├── src/
│   ├── services/
│   │   ├── context/
│   │   │   ├── ContextTypes.ts            # Type definitions for candidates & budget
│   │   │   ├── FileResolver.ts            # @file reference resolution & security checks
│   │   │   ├── SymbolResolver.ts          # @symbol definition resolution & disambiguation
│   │   │   ├── AutomaticRetriever.ts      # Task keyword extraction & excerpt scoring
│   │   │   ├── ContextBudgetManager.ts    # Token budget allocation & truncation
│   │   │   └── ContextAssemblyEngine.ts   # Central context assembly orchestrator
│   │   ├── McpServerService.ts            # Embedded Streamable HTTP MCP server
│   │   └── TrueForgeService.ts            # TrueForge SDK communication & streaming
│   ├── views/
│   │   └── WelcomeViewProvider.ts         # Sidebar WebviewViewProvider & Context UI
│   ├── test/
│   │   ├── extension.test.ts              # Scaffolding & command registration tests
│   │   ├── mcp.test.ts                    # MCP security & tool bridge tests
│   │   └── context.test.ts                # Context assembly, budgeting & symbol tests
│   └── extension.ts                       # Main extension entrypoint & activation
├── esbuild.js             # esbuild configuration
├── package.json           # Extension manifest
├── tsconfig.json          # Strict TypeScript configuration
└── README.md
```

---

## Configuration

The extension contributes the following VS Code settings under `yourplusone.*`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `yourplusone.runtimeUrl` | string | `http://127.0.0.1:8790` | Base URL of the local or remote TrueForge runtime server |
| `yourplusone.apiToken` | string | `trueforge-standalone` | API authentication token or secret for the TrueForge runtime |
| `yourplusone.model` | string | `""` (auto-detected) | Default model to use (falls back to runtime-configured default) |
| `yourplusone.maxContextBudgetTokens` | integer | `16000` | Maximum token budget allocated for assembled context |

---

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)
- [Visual Studio Code](https://code.visualstudio.com/) (v1.85 or higher)

---

## Installation & Build

1. Clone or open the repository folder in VS Code:
   ```bash
   cd Your-Plus-One
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Compile the extension:
   ```bash
   npm run compile
   ```

4. (Optional) Run continuous watch build during development:
   ```bash
   npm run watch
   ```

5. Run integration tests:
   ```bash
   npm test
   ```

---

## How to Launch the Extension

1. Open this repository (`Your-Plus-One`) in Visual Studio Code.
2. Press `F5` (or navigate to the **Run and Debug** view and click **Run Extension**).
3. A new **[Extension Development Host]** window will launch with the **Your +1** extension loaded.

---

## How to Test Manually

### 1. Test the Activity Bar Container & Sidebar View
1. In the **[Extension Development Host]** window, find the **Your +1** (`+1`) icon on the Activity Bar (left sidebar).
2. Click the icon to expand the **Your +1** sidebar.
3. Verify that the welcome view renders with:
   - Header: "Your +1" and "Your AI Engineering Companion".
   - Status badge indicating active foundation.
   - Interactive buttons: **Open Welcome Command** and **About Your +1**.
4. Click **About Your +1** to verify message communication between the webview and extension host.

### 2. Test the "Your +1: Open Welcome" Command
1. Open the Command Palette by pressing `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS).
2. Type `Your +1: Open Welcome` and select it.
3. Observe:
   - The **Your +1** sidebar view is focused automatically.
   - An information toast appears: `"Welcome to Your +1 — Your AI Engineering Companion!"`.

### 3. Test the "Your +1: Test TrueForge Connection" Command
1. Ensure the TrueForge runtime is running locally (e.g. `http://127.0.0.1:8790`).
2. In the Extension Development Host, open the Command Palette (`Ctrl+Shift+P`).
3. Type `Your +1: Test TrueForge Connection` and press Enter (or click **Test TrueForge Connection** in the sidebar welcome view).
4. Observe:
   - A progress notification appears at the bottom-right: `Testing connection to TrueForge...`.
   - The dedicated **Your +1** Output Channel automatically opens in the bottom panel.
   - The channel logs the health probe, model discovery (`google-gemini/gemini-3-1-flash-lite`), temporary session creation, streaming PONG response, and temporary session deletion.
   - A success notification is shown: `Connected to TrueForge (model: ...). Response: "PONG"`.

### 4. Test the "Your +1: Run MCP Bridge Proof" Command
1. Ensure the TrueForge runtime is running locally with loopback outbound enabled (`OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"]`).
2. In the Extension Development Host, click **Run MCP Bridge Proof** in the sidebar welcome view (or run `Your +1: Run MCP Bridge Proof` from the Command Palette).
3. Observe:
   - The embedded MCP server starts on a local loopback port with an ephemeral bearer token.
   - The MCP server is dynamically registered in TrueForge under `yourplusone-tools`.
   - TrueForge queries and discovers `search_workspace` and `read_file`.
   - An agent turn is dispatched instructing the model to find the marker and read the file.
   - The model calls `search_workspace` and `read_file` autonomously.
   - The model streams its final answer: the verification secret from `resources/mcp-test-marker.txt`.
   - All resources (TrueForge session, MCP server registration, local HTTP server) are cleaned up automatically.

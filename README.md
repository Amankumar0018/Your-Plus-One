# Your +1 — Your AI Engineering Companion

**Your +1** is an autonomous AI engineering companion for Visual Studio Code, designed to pair program with developers, provide architectural insights, and streamline coding workflows.

This repository represents **Milestone 4 & 4.1: Safe Workspace Editing, Hunk-Level Diff Review & Safety Hardening**, featuring safe in-memory modification proposals, native VS Code diff review (`yourplusone-staged:`), granular hunk-by-hunk acceptance/rejection, TrueForge tool approval integration, atomic workspace application via multi-file `WorkspaceEdit`, canonical symlink escape protection, conflict-aware undo, and memory-safe diffing.

---

## Features

- **Native Activity Bar Container**: Custom `+1` icon integrated into the VS Code Activity Bar.
- **Interactive Sidebar & Review UI**: A native-styled webview introducing Your +1, its mission, live status, Context Selection panel, and the **Hunk-Level Diff Review & Staging** controls.
- **Safe In-Memory Staging & Zero Silent Writes**:
  - Code changes proposed by the AI or user are staged strictly in-memory (`ModificationProposal` / `FileProposal`).
  - Absolute traversal prevention (`..`), sensitive path filtering (`.env`, `*.pem`, `.git`, `.github/workflows/`), and binary null-byte rejection.
  - Zero disk writes take place until explicitly accepted and confirmed.
- **Production Safe Batch Writer (Milestone 4.1)**:
  - Both MCP tool execution (`apply_proposal`) and extension commands use the exact same atomic VS Code `WorkspaceEdit` batch writer (`createSafeVsCodeWorkspaceWriter`).
  - Direct sequential filesystem write fallbacks (`fs.writeFileSync`) are strictly forbidden in production.
  - Handles open and dirty VS Code documents safely and verifies resulting disk contents immediately following application.
- **Canonical Symlink Escape Protection (Milestone 4.1)**:
  - Canonicalizes the authorized workspace root using `fs.realpathSync.native`.
  - Inspects every path component and rejects symbolic links and Windows junctions that point outside the authorized root.
  - Revalidates paths immediately prior to writing to catch symlinks retargeted while a proposal was awaiting review.
- **Conflict-Aware Undo Manager (Milestone 4.1)**:
  - Stores SHA-256 post-apply hashes in immutable `TransactionRecord`s.
  - Before restoring previous content, verifies that no subsequent developer edits were made to any affected files. If a file was changed on disk after the transaction, undo aborts to protect user changes.
  - Applies restorations through the atomic workspace batch writer.
- **Memory-Safe Diff Engine (Milestone 4.1)**:
  - Optimizes diffing by stripping common prefix and suffix lines before computing the dynamic programming matrix.
  - Uses flat `Int32Array` buffers (4 bytes/cell) instead of nested arrays to minimize heap allocations.
  - Enforces safe input and matrix thresholds (`MAX_DIFF_INPUT_LINES = 20,000`, `MAX_DIFF_MATRIX_CELLS = 2,500,000`), raising a descriptive `DiffSizeExceededError` to protect the extension host against memory exhaustion.
- **Virtual Staging & Native Diff Editor**:
  - `StagedContentProvider` serves proposed content under the virtual `yourplusone-staged:` URI scheme.
  - Opens native VS Code diff editors (`vscode.diff`) side-by-side comparing the live workspace file against the proposed staged version.
- **Independent Hunk-by-Hunk Review**:
  - An LCS-based line-level diff engine parses multi-file changes into unified hunks with standard headers (`@@ -x,y +a,b @@`).
  - Developers can accept, reject, or inspect individual hunks or entire files independently.
  - Non-contiguous and mixed hunk decisions are accurately recombined (`applyHunkDecisions`), applying only accepted hunks while leaving rejected hunks untouched.
- **TrueForge Tool Approval Integration**:
  - `apply_proposal` is strictly protected by TrueForge's `require_approval_for_tools` policy.
  - TrueForge pauses execution upon `tool.approval_required` and maps the request to the staged proposal and tool call before awaiting developer confirmation via `user.tool_approval` turn events (`allow` or `deny`).
- **Explicit Context References (`@file`, `@symbol`)**:
  - `@file path/to/file.ts`: Resolves workspace-relative paths, enforces traversal protection, rejects sensitive files and binaries.
  - `@symbol SymbolName`: Resolves definitions of functions, classes, interfaces, and variables. Intelligently disambiguates duplicate symbols across files, prioritizing core source implementations over test mocks.
- **Automatic Semantic Context Retrieval**: Discovers relevant files and contiguous code excerpts based on task terminology, keyword density, and active editor context.
- **Transparent Context Budgeting**:
  - Enforces bounded token budgets (configurable via `yourplusone.maxContextBudgetTokens`, default 16,000 tokens).
  - Uses a transparent, documented token estimation heuristic (~4 chars/token).
  - Strictly prioritizes explicit references over automatic candidates.
- **Commands**:
  - `yourplusone.openWelcome`: Reveals sidebar view.
  - `yourplusone.testConnection`: Verifies runtime reachability and streams PONG response.
  - `yourplusone.runMcpProof`: Exercises embedded MCP server with TrueForge autonomous tool discovery.
  - `yourplusone.assembleContext`: Interactively assembles explainable context for any developer task.
  - `yourplusone.runTurnWithContext`: Executes an end-to-end TrueForge agent turn with assembled context.
  - `yourplusone.openNativeDiff`: Opens native side-by-side diff between original file and staged proposal.
  - `yourplusone.applyAcceptedHunks`: Atomically applies accepted hunks of the staged proposal to the workspace.
  - `yourplusone.undoLastTransaction`: Reverts the most recent file modification transaction.

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
│   │   ├── diff/
│   │   │   ├── DiffTypes.ts               # Hunk, Proposal, Decision, BatchWriter & Transaction types
│   │   │   ├── HunkEngine.ts              # LCS diff, common prefix/suffix, Int32Array & memory limits
│   │   │   ├── ProposalStore.ts           # In-memory staging, symlink validation, conflict checks & undo
│   │   │   └── StagedContentProvider.ts   # yourplusone-staged: TextDocumentContentProvider & diff launcher
│   │   ├── McpServerService.ts            # Embedded Streamable HTTP MCP server (safe batch writer integrated)
│   │   └── TrueForgeService.ts            # TrueForge SDK communication, approval events & tool mapping
│   ├── views/
│   │   └── WelcomeViewProvider.ts         # Sidebar WebviewViewProvider, Context UI & Diff Review UI
│   ├── test/
│   │   ├── extension.test.ts              # Scaffolding & command registration tests
│   │   ├── mcp.test.ts                    # MCP security & tool bridge tests
│   │   ├── context.test.ts                # Context assembly, budgeting & symbol tests
│   │   └── diff.test.ts                   # Diff engine, symlinks, undo conflicts, batch writer & approval tests
│   └── extension.ts                       # Main extension entrypoint, commands, safe batch writer & activation
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

### 1. Test Safe Workspace Editing & Hunk Review
1. In the sidebar view, click **Stage Sample Proposal**.
2. Observe:
   - A multi-file proposal is created in-memory and rendered in the **Hunk-Level Diff Review & Staging** card.
   - Each proposed file displays hunk counts, status badges, and action buttons: **Open Native Diff**, **Accept Hunk**, **Reject Hunk**.
3. Click **Open Native Diff**:
   - A native VS Code diff editor tab opens side-by-side (`file.ts` ↔ `file.ts (Staged Proposal)`).
   - Staged content is served directly from the virtual `yourplusone-staged:` scheme without touching disk.
4. Test Selective Hunk Decisions:
   - Click **Reject Hunk** on one of the hunks and **Accept Hunk** on another.
   - Click **Confirm & Apply Accepted Hunks** (or run `Your +1: Apply Accepted Hunks` from Command Palette).
   - Inspect the disk file: only the accepted hunk changes are written to the workspace via `vscode.workspace.applyEdit`; the rejected hunk remains as original.
5. Test Conflict-Aware Undo:
   - Click **Undo Last Transaction** (or run `Your +1: Undo Last Workspace Transaction`).
   - The original workspace files are restored atomically. If any file has been modified externally after the transaction, undo detects the conflict and refuses to overwrite developer changes.

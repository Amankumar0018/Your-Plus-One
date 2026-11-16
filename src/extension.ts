import * as vscode from 'vscode';
import { WelcomeViewProvider } from './views/WelcomeViewProvider.js';
import { TrueForgeService } from './services/TrueForgeService.js';
import { ContextAssemblyEngine } from './services/context/ContextAssemblyEngine.js';
import type { ActiveEditorContext } from './services/context/ContextTypes.js';
import { ProposalStore } from './services/diff/ProposalStore.js';
import { StagedContentProvider } from './services/diff/StagedContentProvider.js';
import type { WorkspaceBatchWriter, WorkspaceBatchWriteItem, WorkspaceBatchWriterResult } from './services/diff/DiffTypes.js';

/**
 * Factory for creating the production VS Code atomic multi-file WorkspaceEdit batch writer.
 * Handles open/dirty documents safely and guarantees atomicity across all proposal files.
 */
export function createSafeVsCodeWorkspaceWriter(): WorkspaceBatchWriter {
    return async (items: WorkspaceBatchWriteItem[]): Promise<WorkspaceBatchWriterResult> => {
        if (items.length === 0) {
            return { success: true, writtenFiles: [] };
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        const openedDocs: Array<{ doc: vscode.TextDocument; uri: vscode.Uri; relPath: string }> = [];

        // 1. Build and validate edits for all files in the batch
        for (const item of items) {
            const uri = vscode.Uri.file(item.absPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            openedDocs.push({ doc, uri, relPath: item.filePath });

            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            workspaceEdit.replace(uri, fullRange, item.content);
        }

        // 2. Apply multi-file WorkspaceEdit atomically
        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (!applied) {
            throw new Error(`Failed to apply atomic WorkspaceEdit across ${items.length} file(s).`);
        }

        // 3. Save all affected documents to disk
        const writtenFiles: string[] = [];
        for (const { doc, relPath } of openedDocs) {
            const saved = await doc.save();
            if (!saved) {
                throw new Error(`Failed to save document to disk after WorkspaceEdit: "${relPath}".`);
            }
            writtenFiles.push(relPath);
        }

        return { success: true, writtenFiles };
    };
}

/**
 * Activates the Your +1 extension.
 *
 * @param context Extension execution context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
    console.log('Your +1 extension is now active.');

    // Create persistent Output Channel for Your +1 logging and streaming
    const outputChannel = vscode.window.createOutputChannel('Your +1');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // 1. Initialize safe diff and staging subsystems with atomic workspace batch writer
    const safeWorkspaceWriter = createSafeVsCodeWorkspaceWriter();
    const proposalStore = new ProposalStore(workspaceFolder, safeWorkspaceWriter);
    const stagedContentProvider = new StagedContentProvider(proposalStore, workspaceFolder);

    const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
        StagedContentProvider.scheme,
        stagedContentProvider
    );

    // 2. Register sidebar webview provider for the Your +1 activity bar container
    const welcomeViewProvider = new WelcomeViewProvider(context.extensionUri);
    const viewDisposable = vscode.window.registerWebviewViewProvider(
        WelcomeViewProvider.viewType,
        welcomeViewProvider
    );

    // Register the "Your +1: Open Welcome" command
    const openWelcomeCommand = vscode.commands.registerCommand('yourplusone.openWelcome', async () => {
        try {
            await vscode.commands.executeCommand('yourplusone.welcomeView.focus');
        } catch {
            welcomeViewProvider.focus();
        }

        void vscode.window.showInformationMessage('Welcome to Your +1 — Your AI Engineering Companion!');
    });

    // Register the "Your +1: Test TrueForge Connection" command
    const testConnectionCommand = vscode.commands.registerCommand('yourplusone.testConnection', async () => {
        outputChannel.show(true);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Your +1: Connecting to TrueForge...',
                cancellable: false
            },
            async (progress) => {
                progress.report({ message: 'Verifying runtime reachability and streaming PONG...' });
                const service = new TrueForgeService();
                const result = await service.testConnection(outputChannel);

                if (result.success) {
                    void vscode.window.showInformationMessage(
                        `Your +1: Successfully connected to TrueForge (${result.model})! Agent replied: "${result.response}".`
                    );
                } else {
                    void vscode.window.showErrorMessage(
                        `Your +1: TrueForge Connection Failed — ${result.error}`
                    );
                }
            }
        );
    });

    // Register the "Your +1: Run MCP Bridge Proof" command
    const runMcpProofCommand = vscode.commands.registerCommand('yourplusone.runMcpProof', async () => {
        outputChannel.show(true);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Your +1: Verifying Read-only MCP Bridge...',
                cancellable: false
            },
            async (progress) => {
                progress.report({ message: 'Starting MCP server, registering with TrueForge, and running autonomous agent turn...' });
                const service = new TrueForgeService();
                const result = await service.testMcpBridge(workspaceFolder, outputChannel);

                if (result.success) {
                    const toolNames = result.toolCallsDetected.map((t) => t.tool).join(', ');
                    void vscode.window.showInformationMessage(
                        `Your +1: MCP Bridge verified! Model independently called [${toolNames}]. Answer: "${result.finalResponse?.slice(0, 80)}..."`
                    );
                } else {
                    void vscode.window.showErrorMessage(
                        `Your +1: MCP Bridge Verification Failed — ${result.error ?? 'Model did not call both search_workspace and read_file'}`
                    );
                }
            }
        );
    });

    // Helper to extract active editor context
    const getActiveEditorContext = (): ActiveEditorContext | undefined => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }

        const doc = editor.document;
        const selection = editor.selection;
        const selectedText = !selection.isEmpty ? doc.getText(selection) : undefined;

        return {
            filePath: doc.uri.fsPath,
            selectedText,
            selectionRange: selectedText ? { startLine: selection.start.line + 1, endLine: selection.end.line + 1 } : undefined
        };
    };

    // Register the "Your +1: Assemble Context for Task" command
    const assembleContextCommand = vscode.commands.registerCommand('yourplusone.assembleContext', async (promptArg?: string) => {
        let taskPrompt = promptArg;
        if (!taskPrompt) {
            taskPrompt = await vscode.window.showInputBox({
                prompt: 'Enter task instruction (supports @file <path> and @symbol <name>)',
                placeHolder: 'e.g. Check authentication logic in @file src/services/TrueForgeService.ts and review @symbol testMcpBridge'
            });
        }

        if (!taskPrompt || taskPrompt.trim().length === 0) {
            return;
        }

        outputChannel.show(true);
        outputChannel.appendLine(`\n========================================================`);
        outputChannel.appendLine(`[Your +1 Context Assembly] Assembling context for task: "${taskPrompt}"`);

        const config = vscode.workspace.getConfiguration('yourplusone');
        const maxBudget = config.get<number>('maxContextBudgetTokens', 16000);

        const engine = new ContextAssemblyEngine(workspaceFolder);
        const activeEditor = getActiveEditorContext();

        const result = await engine.assembleContext(taskPrompt, {
            workspaceRoot: workspaceFolder,
            maxBudgetTokens: maxBudget,
            activeEditor
        });

        // Update sidebar UI with explainable results
        welcomeViewProvider.updateContextResult(result);
        welcomeViewProvider.focus();

        outputChannel.appendLine(`[Your +1 Context Assembly] Budget Used: ${result.budget.usedTokens} / ${result.budget.maxContextAssemblyBudget} tokens (${result.budget.remainingTokens} remaining).`);
        outputChannel.appendLine(`[Your +1 Context Assembly] Selected Candidates (${result.candidates.length}):`);
        for (const c of result.candidates) {
            outputChannel.appendLine(`  - [${c.source}] ${c.filePath}${c.symbolName ? ` (#${c.symbolName})` : ''} [${c.status}] - ~${c.estimatedTokens} tokens`);
            outputChannel.appendLine(`    Reason: ${c.selectionReason}`);
        }

        if (result.warnings.length > 0) {
            for (const w of result.warnings) {
                outputChannel.appendLine(`  [WARNING] ${w}`);
            }
        }

        void vscode.window.showInformationMessage(
            `Your +1: Assembled ${result.candidates.filter(c => c.status === 'included').length} context candidate(s) (${result.budget.usedTokens} tokens). View details in sidebar.`
        );

        return result;
    });

    // Register Native Diff Preview command
    const openNativeDiffCommand = vscode.commands.registerCommand(
        'yourplusone.openNativeDiff',
        async (filePath: string, proposalId?: string) => {
            const targetPropId = proposalId ?? proposalStore.activeProposal?.id;
            if (!targetPropId) {
                void vscode.window.showErrorMessage('Your +1: No active proposal available for diff review.');
                return;
            }

            try {
                await stagedContentProvider.openNativeDiff(targetPropId, filePath);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Your +1: Failed to open diff: ${msg}`);
            }
        }
    );

    // Register Accept Hunk command
    const acceptHunkCommand = vscode.commands.registerCommand(
        'yourplusone.acceptHunk',
        ({ proposalId, filePath, hunkId }: { proposalId: string; filePath: string; hunkId: string }) => {
            try {
                proposalStore.setHunkDecision(proposalId, filePath, hunkId, 'accepted');
                stagedContentProvider.notifyDocumentChanged(proposalId, filePath);
                const prop = proposalStore.getProposal(proposalId);
                if (prop) {
                    welcomeViewProvider.updateProposal(prop);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Error accepting hunk: ${msg}`);
            }
        }
    );

    // Register Reject Hunk command
    const rejectHunkCommand = vscode.commands.registerCommand(
        'yourplusone.rejectHunk',
        ({ proposalId, filePath, hunkId }: { proposalId: string; filePath: string; hunkId: string }) => {
            try {
                proposalStore.setHunkDecision(proposalId, filePath, hunkId, 'rejected');
                stagedContentProvider.notifyDocumentChanged(proposalId, filePath);
                const prop = proposalStore.getProposal(proposalId);
                if (prop) {
                    welcomeViewProvider.updateProposal(prop);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Error rejecting hunk: ${msg}`);
            }
        }
    );

    // Register Accept All Hunks command
    const acceptAllHunksCommand = vscode.commands.registerCommand(
        'yourplusone.acceptAllHunks',
        ({ proposalId, filePath }: { proposalId: string; filePath?: string }) => {
            try {
                proposalStore.setAllHunksDecision(proposalId, 'accepted', filePath);
                if (filePath) {
                    stagedContentProvider.notifyDocumentChanged(proposalId, filePath);
                }
                const prop = proposalStore.getProposal(proposalId);
                if (prop) {
                    welcomeViewProvider.updateProposal(prop);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Error accepting hunks: ${msg}`);
            }
        }
    );

    // Register Reject All Hunks command
    const rejectAllHunksCommand = vscode.commands.registerCommand(
        'yourplusone.rejectAllHunks',
        ({ proposalId, filePath }: { proposalId: string; filePath?: string }) => {
            try {
                proposalStore.setAllHunksDecision(proposalId, 'rejected', filePath);
                if (filePath) {
                    stagedContentProvider.notifyDocumentChanged(proposalId, filePath);
                }
                const prop = proposalStore.getProposal(proposalId);
                if (prop) {
                    welcomeViewProvider.updateProposal(prop);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Error rejecting hunks: ${msg}`);
            }
        }
    );

    // Register Apply Accepted Hunks command
    const applyAcceptedHunksCommand = vscode.commands.registerCommand(
        'yourplusone.applyAcceptedHunks',
        async (proposalIdArg?: string) => {
            const proposalId = proposalIdArg ?? proposalStore.activeProposal?.id;
            if (!proposalId) {
                void vscode.window.showErrorMessage('Your +1: No active proposal to apply.');
                return;
            }

            try {
                const tx = await proposalStore.applyProposal(proposalId);
                const prop = proposalStore.getProposal(proposalId);
                if (prop) {
                    welcomeViewProvider.updateProposal(prop);
                }

                const totalHunks = tx.modifiedFiles.reduce((sum, f) => sum + f.appliedHunkCount, 0);
                void vscode.window.showInformationMessage(
                    `Your +1: Successfully applied ${totalHunks} accepted hunk(s) across ${tx.modifiedFiles.length} file(s). Transaction: ${tx.id}`
                );
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Your +1: Failed to apply proposal: ${msg}`);
            }
        }
    );

    // Register Undo Last Transaction command
    const undoLastTransactionCommand = vscode.commands.registerCommand(
        'yourplusone.undoLastTransaction',
        async () => {
            try {
                const result = await proposalStore.undoTransaction();
                if (proposalStore.activeProposal) {
                    welcomeViewProvider.updateProposal(proposalStore.activeProposal);
                }

                void vscode.window.showInformationMessage(
                    `Your +1: Undid last transaction. Restored ${result.undoneFiles.length} file(s) to previous state.`
                );
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Your +1: Undo failed: ${msg}`);
            }
        }
    );

    // Register the "Your +1: Run Agent Turn with Context" command
    const runTurnWithContextCommand = vscode.commands.registerCommand('yourplusone.runTurnWithContext', async (promptArg?: string) => {
        let taskPrompt = promptArg;
        if (!taskPrompt) {
            taskPrompt = await vscode.window.showInputBox({
                prompt: 'Enter task instruction to execute with assembled context and safe review',
                placeHolder: 'e.g. Modify @file src/helpers.ts to add logging function'
            });
        }

        if (!taskPrompt || taskPrompt.trim().length === 0) {
            return;
        }

        outputChannel.show(true);

        const config = vscode.workspace.getConfiguration('yourplusone');
        const maxBudget = config.get<number>('maxContextBudgetTokens', 16000);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Your +1: Assembling Context & Running Turn...',
                cancellable: false
            },
            async (progress) => {
                progress.report({ message: 'Step 1/2: Assembling explainable context...' });

                const engine = new ContextAssemblyEngine(workspaceFolder);
                const activeEditor = getActiveEditorContext();
                const assembled = await engine.assembleContext(taskPrompt!, {
                    workspaceRoot: workspaceFolder,
                    maxBudgetTokens: maxBudget,
                    activeEditor
                });

                welcomeViewProvider.updateContextResult(assembled);

                progress.report({ message: 'Step 2/2: Dispatching turn to TrueForge...' });
                const service = new TrueForgeService();

                const result = await service.runTurnWithContext(workspaceFolder, assembled, outputChannel, {
                    proposalStore,
                    approvalHandler: async (req) => {
                        const targetProp = req.proposal ?? proposalStore.activeProposal;
                        if (targetProp) {
                            welcomeViewProvider.updateProposal(targetProp);
                            welcomeViewProvider.focus();
                        }

                        const propId = targetProp?.id ?? req.proposalId ?? 'pending';
                        const fileCount = targetProp?.files.length ?? req.toolCalls.length;
                        const choice = await vscode.window.showInformationMessage(
                            `Your +1: TrueForge has requested approval for proposal "${propId}" (${fileCount} file(s)). Review hunks in the sidebar or diff editor.`,
                            { modal: true },
                            'Allow & Apply Accepted Hunks',
                            'Reject Proposal'
                        );

                        return choice === 'Allow & Apply Accepted Hunks' ? 'allow' : 'deny';
                    }
                });

                if (result.proposal) {
                    welcomeViewProvider.updateProposal(result.proposal);
                    welcomeViewProvider.focus();
                }

                if (result.success) {
                    void vscode.window.showInformationMessage(
                        `Your +1: Turn completed! Agent response received (${result.finalResponse?.slice(0, 60)}...).`
                    );
                } else {
                    void vscode.window.showErrorMessage(
                        `Your +1: Context Turn Failed — ${result.error}`
                    );
                }
            }
        );
    });

    context.subscriptions.push(
        outputChannel,
        providerRegistration,
        viewDisposable,
        openWelcomeCommand,
        testConnectionCommand,
        runMcpProofCommand,
        assembleContextCommand,
        runTurnWithContextCommand,
        openNativeDiffCommand,
        acceptHunkCommand,
        rejectHunkCommand,
        acceptAllHunksCommand,
        rejectAllHunksCommand,
        applyAcceptedHunksCommand,
        undoLastTransactionCommand
    );
}

/**
 * Deactivates the Your +1 extension.
 */
export function deactivate(): void {
    // Cleanup resources if needed upon deactivation
}

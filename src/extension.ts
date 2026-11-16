import * as vscode from 'vscode';
import { WelcomeViewProvider } from './views/WelcomeViewProvider.js';
import { TrueForgeService } from './services/TrueForgeService.js';
import { ContextAssemblyEngine } from './services/context/ContextAssemblyEngine.js';
import type { ActiveEditorContext } from './services/context/ContextTypes.js';

/**
 * Activates the Your +1 extension.
 *
 * @param context Extension execution context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
    console.log('Your +1 extension is now active.');

    // Create persistent Output Channel for Your +1 logging and streaming
    const outputChannel = vscode.window.createOutputChannel('Your +1');

    // Register sidebar webview provider for the Your +1 activity bar container
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

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

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

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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

    // Register the "Your +1: Run Agent Turn with Context" command
    const runTurnWithContextCommand = vscode.commands.registerCommand('yourplusone.runTurnWithContext', async (promptArg?: string) => {
        let taskPrompt = promptArg;
        if (!taskPrompt) {
            taskPrompt = await vscode.window.showInputBox({
                prompt: 'Enter task instruction to execute with assembled context',
                placeHolder: 'e.g. Check authentication logic in @file src/services/TrueForgeService.ts and review @symbol testMcpBridge'
            });
        }

        if (!taskPrompt || taskPrompt.trim().length === 0) {
            return;
        }

        outputChannel.show(true);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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
                const result = await service.runTurnWithContext(workspaceFolder, assembled, outputChannel);

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
        viewDisposable,
        openWelcomeCommand,
        testConnectionCommand,
        runMcpProofCommand,
        assembleContextCommand,
        runTurnWithContextCommand
    );
}

/**
 * Deactivates the Your +1 extension.
 */
export function deactivate(): void {
    // Cleanup resources if needed upon deactivation
}

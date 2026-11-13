import * as vscode from 'vscode';
import { WelcomeViewProvider } from './views/WelcomeViewProvider.js';
import { TrueForgeService } from './services/TrueForgeService.js';

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

    context.subscriptions.push(outputChannel, viewDisposable, openWelcomeCommand, testConnectionCommand);
}

/**
 * Deactivates the Your +1 extension.
 */
export function deactivate(): void {
    // Cleanup resources if needed upon deactivation
}

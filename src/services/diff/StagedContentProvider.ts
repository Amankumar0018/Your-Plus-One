import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ProposalStore } from './ProposalStore.js';

/**
 * TextDocumentContentProvider providing virtual staged file representations
 * for native VS Code side-by-side diff editors (Scheme: yourplusone-staged).
 */
export class StagedContentProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'yourplusone-staged';

    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;

    constructor(
        private readonly _proposalStore: ProposalStore,
        private readonly _workspaceRoot: string
    ) {}

    /**
     * Provides virtual text content for staged preview documents.
     */
    public provideTextDocumentContent(uri: vscode.Uri): string {
        const queryParams = new URLSearchParams(uri.query);
        const proposalId = queryParams.get('proposalId');
        const rawPath = uri.path.replace(/^\/+/, '');

        if (!proposalId) {
            return '// Error: Missing proposalId in staged document URI.';
        }

        try {
            return this._proposalStore.getStagedContent(proposalId, rawPath);
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return `// Error loading staged content: ${errorMsg}`;
        }
    }

    /**
     * Notifies VS Code that a staged virtual document has updated (e.g. after hunk decision).
     */
    public notifyDocumentChanged(proposalId: string, filePath: string): void {
        const uri = StagedContentProvider.createStagedUri(proposalId, filePath);
        this._onDidChange.fire(uri);
    }

    /**
     * Constructs a valid staged preview URI for a file in a proposal.
     */
    public static createStagedUri(proposalId: string, filePath: string): vscode.Uri {
        const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
        return vscode.Uri.from({
            scheme: StagedContentProvider.scheme,
            path: `/${normalized}`,
            query: `proposalId=${encodeURIComponent(proposalId)}&v=${Date.now()}`
        });
    }

    /**
     * Opens the native VS Code side-by-side diff editor for a proposed file.
     */
    public async openNativeDiff(proposalId: string, filePath: string): Promise<void> {
        const normalized = filePath.replace(/\\/g, '/');
        const originalUri = vscode.Uri.file(path.resolve(this._workspaceRoot, normalized));
        const stagedUri = StagedContentProvider.createStagedUri(proposalId, normalized);

        const basename = path.basename(normalized);
        const title = `${basename} (Working Tree ↔ Proposed Staging)`;

        await vscode.commands.executeCommand('vscode.diff', originalUri, stagedUri, title, {
            preview: true
        });
    }
}


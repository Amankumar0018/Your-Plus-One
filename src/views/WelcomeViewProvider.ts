import * as vscode from 'vscode';
import type { AssembledContextResult } from '../services/context/ContextTypes.js';
import type { ModificationProposal } from '../services/diff/DiffTypes.js';

/**
 * Webview provider for the Your +1 sidebar welcome, context selection, and hunk-level diff review view.
 */
export class WelcomeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'yourplusone.welcomeView';

    private _view?: vscode.WebviewView;
    private _lastContextResult?: AssembledContextResult;
    private _lastProposal?: ModificationProposal;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: {
            command: string;
            text?: string;
            prompt?: string;
            filePath?: string;
            proposalId?: string;
            hunkId?: string;
        }) => {
            switch (message.command) {
                case 'triggerWelcomeCommand':
                    void vscode.commands.executeCommand('yourplusone.openWelcome');
                    break;
                case 'triggerTestConnection':
                    void vscode.commands.executeCommand('yourplusone.testConnection');
                    break;
                case 'triggerRunMcpProof':
                    void vscode.commands.executeCommand('yourplusone.runMcpProof');
                    break;
                case 'triggerAssembleContext':
                    void vscode.commands.executeCommand('yourplusone.assembleContext', message.prompt);
                    break;
                case 'triggerRunContextTurn':
                    void vscode.commands.executeCommand('yourplusone.runTurnWithContext', message.prompt);
                    break;
                case 'triggerOpenNativeDiff':
                    if (message.filePath) {
                        void vscode.commands.executeCommand('yourplusone.openNativeDiff', message.filePath, message.proposalId);
                    }
                    break;
                case 'triggerAcceptHunk':
                    if (message.proposalId && message.filePath && message.hunkId) {
                        void vscode.commands.executeCommand('yourplusone.acceptHunk', {
                            proposalId: message.proposalId,
                            filePath: message.filePath,
                            hunkId: message.hunkId
                        });
                    }
                    break;
                case 'triggerRejectHunk':
                    if (message.proposalId && message.filePath && message.hunkId) {
                        void vscode.commands.executeCommand('yourplusone.rejectHunk', {
                            proposalId: message.proposalId,
                            filePath: message.filePath,
                            hunkId: message.hunkId
                        });
                    }
                    break;
                case 'triggerAcceptAllHunks':
                    if (message.proposalId) {
                        void vscode.commands.executeCommand('yourplusone.acceptAllHunks', {
                            proposalId: message.proposalId,
                            filePath: message.filePath
                        });
                    }
                    break;
                case 'triggerRejectAllHunks':
                    if (message.proposalId) {
                        void vscode.commands.executeCommand('yourplusone.rejectAllHunks', {
                            proposalId: message.proposalId,
                            filePath: message.filePath
                        });
                    }
                    break;
                case 'triggerApplyAcceptedHunks':
                    void vscode.commands.executeCommand('yourplusone.applyAcceptedHunks', message.proposalId);
                    break;
                case 'triggerUndoLastTransaction':
                    void vscode.commands.executeCommand('yourplusone.undoLastTransaction');
                    break;
                case 'showInfo':
                    if (message.text) {
                        void vscode.window.showInformationMessage(message.text);
                    }
                    break;
            }
        });

        if (this._lastContextResult) {
            void webviewView.webview.postMessage({
                command: 'setContextResult',
                data: this._lastContextResult
            });
        }

        if (this._lastProposal) {
            void webviewView.webview.postMessage({
                command: 'setProposal',
                data: this._lastProposal
            });
        }
    }

    public focus(): void {
        if (this._view) {
            this._view.show(true);
        }
    }

    public updateContextResult(result: AssembledContextResult): void {
        this._lastContextResult = result;
        if (this._view) {
            void this._view.webview.postMessage({
                command: 'setContextResult',
                data: result
            });
        }
    }

    public updateProposal(proposal: ModificationProposal): void {
        this._lastProposal = proposal;
        if (this._view) {
            void this._view.webview.postMessage({
                command: 'setProposal',
                data: proposal
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your +1</title>
    <style nonce="${nonce}">
        :root {
            --container-padding: 12px;
        }

        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: var(--container-padding);
            margin: 0;
            line-height: 1.4;
            box-sizing: border-box;
        }

        .header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 12px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
        }

        .logo-badge {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border-radius: 6px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 700;
            font-size: 14px;
            flex-shrink: 0;
        }

        .title-group {
            display: flex;
            flex-direction: column;
        }

        .title {
            font-size: 15px;
            font-weight: 600;
            margin: 0;
            color: var(--vscode-foreground);
        }

        .subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin: 0;
        }

        .card {
            background-color: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 6px;
            padding: 10px;
            margin-bottom: 12px;
        }

        .card-title {
            font-size: 12px;
            font-weight: 600;
            margin-top: 0;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .form-group {
            margin-bottom: 10px;
        }

        label {
            display: block;
            font-size: 11px;
            font-weight: 500;
            margin-bottom: 4px;
            color: var(--vscode-descriptionForeground);
        }

        textarea {
            width: 100%;
            height: 70px;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.3));
            border-radius: 4px;
            font-family: inherit;
            font-size: 12px;
            resize: vertical;
            box-sizing: border-box;
        }

        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .button-row {
            display: flex;
            gap: 6px;
            margin-top: 8px;
        }

        button {
            padding: 6px 10px;
            border: none;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            box-sizing: border-box;
            flex: 1;
        }

        button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background-color: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        }

        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
        }

        button.success {
            background-color: #27ae60;
            color: #ffffff;
        }

        button.danger {
            background-color: #c0392b;
            color: #ffffff;
        }

        button.small {
            padding: 3px 6px;
            font-size: 10px;
            flex: none;
        }

        /* Badges */
        .badge-pill {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .badge-explicit {
            background: rgba(0, 150, 255, 0.2);
            color: #4daafc;
            border: 1px solid rgba(0, 150, 255, 0.4);
        }

        .badge-auto {
            background: rgba(100, 200, 100, 0.2);
            color: #70d670;
            border: 1px solid rgba(100, 200, 100, 0.4);
        }

        .status-included, .status-accepted {
            color: #2ecc71;
            font-weight: 600;
        }

        .status-truncated, .status-partially {
            color: #f1c40f;
            font-weight: 600;
        }

        .status-omitted, .status-rejected, .status-conflict {
            color: #e74c3c;
            font-weight: 600;
        }

        /* Diff Review Section */
        .file-review-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 8px;
        }

        .file-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: 600;
            font-size: 11px;
            margin-bottom: 6px;
            word-break: break-all;
        }

        .hunk-card {
            background: rgba(128, 128, 128, 0.05);
            border: 1px solid rgba(128, 128, 128, 0.15);
            border-radius: 3px;
            padding: 6px;
            margin-top: 6px;
            font-size: 10px;
        }

        .hunk-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-family: var(--vscode-editor-font-family, monospace);
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
        }

        .hunk-diff-preview {
            display: none;
            margin-top: 4px;
            padding: 4px;
            background: rgba(0, 0, 0, 0.25);
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 9px;
            white-space: pre;
            overflow-x: auto;
            max-height: 100px;
        }

        .diff-del {
            color: #ff6b6b;
        }

        .diff-add {
            color: #51cf66;
        }

        .alert-box {
            background: rgba(255, 170, 0, 0.15);
            border-left: 3px solid #ffa500;
            padding: 6px 8px;
            border-radius: 2px;
            font-size: 11px;
            margin-bottom: 8px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="logo-badge">+1</div>
        <div class="title-group">
            <h1 class="title">Your +1</h1>
            <p class="subtitle">Safe Workspace Editing &amp; Hunk Review</p>
        </div>
    </div>

    <!-- Active Staged Proposal & Hunk Review (Milestone 4) -->
    <div id="proposalSection" class="card" style="display: none;">
        <div class="card-title">
            <span>Hunk-Level Diff Review</span>
            <span id="proposalIdBadge" class="badge-pill badge-explicit">No Proposal</span>
        </div>
        <p style="font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 0 8px 0;">
            Changes are staged in memory. Accept or reject individual hunks before confirming application.
        </p>
        
        <div id="proposalFilesContainer"></div>

        <div class="button-row" style="margin-top: 10px;">
            <button id="applyProposalBtn" class="success">
                <span>Confirm &amp; Apply Accepted Hunks</span>
            </button>
            <button id="undoTransactionBtn" class="secondary" title="Undo the last applied transaction">
                <span>Undo Last Transaction</span>
            </button>
        </div>
    </div>

    <!-- Task & Context Assembly Form -->
    <div class="card">
        <h2 class="card-title">Context Assembly (Milestone 3)</h2>
        <div class="form-group">
            <label for="taskInput">Developer Task (supports @file and @symbol):</label>
            <textarea id="taskInput" placeholder="e.g. Modify @file src/helpers.ts to add logging">Add helper function to @file src/helpers.ts</textarea>
        </div>
        <div class="button-row">
            <button id="assembleBtn" class="primary">
                <span>Assemble Context</span>
            </button>
            <button id="runContextTurnBtn" class="secondary">
                <span>Run Turn</span>
            </button>
        </div>
    </div>

    <!-- Quick Actions -->
    <div class="card">
        <h2 class="card-title">Quick Actions</h2>
        <div class="button-row" style="flex-direction: column;">
            <button id="runMcpProofBtn" class="secondary">
                <span>Run MCP Bridge Proof</span>
            </button>
            <button id="testConnectionBtn" class="secondary">
                <span>Test TrueForge Connection</span>
            </button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const taskInput = document.getElementById('taskInput');
        const assembleBtn = document.getElementById('assembleBtn');
        const runContextTurnBtn = document.getElementById('runContextTurnBtn');
        const proposalSection = document.getElementById('proposalSection');
        const proposalIdBadge = document.getElementById('proposalIdBadge');
        const proposalFilesContainer = document.getElementById('proposalFilesContainer');
        const applyProposalBtn = document.getElementById('applyProposalBtn');
        const undoTransactionBtn = document.getElementById('undoTransactionBtn');

        let currentActiveProposal = null;

        assembleBtn.addEventListener('click', () => {
            const prompt = taskInput.value.trim();
            if (prompt) {
                vscode.postMessage({ command: 'triggerAssembleContext', prompt });
            }
        });

        runContextTurnBtn.addEventListener('click', () => {
            const prompt = taskInput.value.trim();
            if (prompt) {
                vscode.postMessage({ command: 'triggerRunContextTurn', prompt });
            }
        });

        applyProposalBtn.addEventListener('click', () => {
            if (currentActiveProposal) {
                vscode.postMessage({ command: 'triggerApplyAcceptedHunks', proposalId: currentActiveProposal.id });
            }
        });

        undoTransactionBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'triggerUndoLastTransaction' });
        });

        document.getElementById('runMcpProofBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'triggerRunMcpProof' });
        });

        document.getElementById('testConnectionBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'triggerTestConnection' });
        });

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.command === 'setProposal') {
                renderProposal(msg.data);
            }
        });

        function renderProposal(proposal) {
            currentActiveProposal = proposal;
            if (!proposal || !proposal.files || proposal.files.length === 0) {
                proposalSection.style.display = 'none';
                return;
            }

            proposalSection.style.display = 'block';
            proposalIdBadge.textContent = proposal.id;

            proposalFilesContainer.innerHTML = '';

            proposal.files.forEach((file) => {
                const fileCard = document.createElement('div');
                fileCard.className = 'file-review-card';

                const totalHunks = file.hunks ? file.hunks.length : 0;
                const acceptedHunks = file.hunks ? file.hunks.filter(h => h.status === 'accepted').length : 0;
                const rejectedHunks = file.hunks ? file.hunks.filter(h => h.status === 'rejected').length : 0;

                let statusBadge = '<span class="status-truncated">' + file.status + '</span>';
                if (file.status === 'accepted') statusBadge = '<span class="status-accepted">All Accepted</span>';
                if (file.status === 'rejected') statusBadge = '<span class="status-rejected">All Rejected</span>';
                if (file.status === 'conflict') statusBadge = '<span class="status-conflict">Conflict Detected</span>';

                fileCard.innerHTML = 
                    '<div class="file-header">' +
                        '<span>' + escapeHtml(file.filePath) + '</span>' +
                        '<span>' + statusBadge + '</span>' +
                    '</div>' +
                    '<div class="button-row" style="margin-bottom: 8px;">' +
                        '<button class="secondary small diff-btn" data-path="' + escapeHtml(file.filePath) + '">Open Native Diff</button>' +
                        '<button class="secondary small accept-all-btn" data-path="' + escapeHtml(file.filePath) + '">Accept All (' + totalHunks + ')</button>' +
                        '<button class="secondary small reject-all-btn" data-path="' + escapeHtml(file.filePath) + '">Reject All</button>' +
                    '</div>';

                // Render each hunk
                if (file.hunks && file.hunks.length > 0) {
                    file.hunks.forEach((hunk) => {
                        const hunkEl = document.createElement('div');
                        hunkEl.className = 'hunk-card';

                        let hunkStatusHtml = '<span style="color: #f1c40f;">Pending</span>';
                        if (hunk.status === 'accepted') hunkStatusHtml = '<span class="status-accepted">✓ Accepted</span>';
                        if (hunk.status === 'rejected') hunkStatusHtml = '<span class="status-rejected">✗ Rejected</span>';

                        const hunkPreviewId = 'preview-' + hunk.id;

                        let previewLines = '';
                        (hunk.originalLines || []).forEach(l => { previewLines += '<div class="diff-del">-' + escapeHtml(l) + '</div>'; });
                        (hunk.proposedLines || []).forEach(l => { previewLines += '<div class="diff-add">+' + escapeHtml(l) + '</div>'; });

                        hunkEl.innerHTML = 
                            '<div class="hunk-header">' +
                                '<span>' + escapeHtml(hunk.header) + '</span>' +
                                '<span>' + hunkStatusHtml + '</span>' +
                            '</div>' +
                            '<div class="button-row" style="margin-top: 4px;">' +
                                '<button class="small ' + (hunk.status === 'accepted' ? 'primary' : 'secondary') + ' accept-hunk-btn" data-file="' + escapeHtml(file.filePath) + '" data-hunk="' + hunk.id + '">Accept</button>' +
                                '<button class="small ' + (hunk.status === 'rejected' ? 'danger' : 'secondary') + ' reject-hunk-btn" data-file="' + escapeHtml(file.filePath) + '" data-hunk="' + hunk.id + '">Reject</button>' +
                                '<button class="small secondary toggle-hunk-preview" data-target="' + hunkPreviewId + '">Inspect</button>' +
                            '</div>' +
                            '<div id="' + hunkPreviewId + '" class="hunk-diff-preview">' + previewLines + '</div>';

                        fileCard.appendChild(hunkEl);
                    });
                }

                proposalFilesContainer.appendChild(fileCard);
            });

            // Wire event listeners
            proposalFilesContainer.querySelectorAll('.diff-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const filePath = btn.getAttribute('data-path');
                    vscode.postMessage({ command: 'triggerOpenNativeDiff', filePath, proposalId: proposal.id });
                });
            });

            proposalFilesContainer.querySelectorAll('.accept-all-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const filePath = btn.getAttribute('data-path');
                    vscode.postMessage({ command: 'triggerAcceptAllHunks', filePath, proposalId: proposal.id });
                });
            });

            proposalFilesContainer.querySelectorAll('.reject-all-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const filePath = btn.getAttribute('data-path');
                    vscode.postMessage({ command: 'triggerRejectAllHunks', filePath, proposalId: proposal.id });
                });
            });

            proposalFilesContainer.querySelectorAll('.accept-hunk-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const filePath = btn.getAttribute('data-file');
                    const hunkId = btn.getAttribute('data-hunk');
                    vscode.postMessage({ command: 'triggerAcceptHunk', filePath, hunkId, proposalId: proposal.id });
                });
            });

            proposalFilesContainer.querySelectorAll('.reject-hunk-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const filePath = btn.getAttribute('data-file');
                    const hunkId = btn.getAttribute('data-hunk');
                    vscode.postMessage({ command: 'triggerRejectHunk', filePath, hunkId, proposalId: proposal.id });
                });
            });

            proposalFilesContainer.querySelectorAll('.toggle-hunk-preview').forEach(btn => {
                btn.addEventListener('click', () => {
                    const targetId = btn.getAttribute('data-target');
                    const previewEl = document.getElementById(targetId);
                    if (previewEl) {
                        const isVisible = previewEl.style.display === 'block';
                        previewEl.style.display = isVisible ? 'none' : 'block';
                        btn.textContent = isVisible ? 'Inspect' : 'Close';
                    }
                });
            });
        }

        function escapeHtml(text) {
            if (!text) return '';
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

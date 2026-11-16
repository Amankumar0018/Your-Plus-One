import * as vscode from 'vscode';
import type { AssembledContextResult } from '../services/context/ContextTypes.js';

/**
 * Webview provider for the Your +1 sidebar welcome & context selection view.
 */
export class WelcomeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'yourplusone.welcomeView';

    private _view?: vscode.WebviewView;
    private _lastContextResult?: AssembledContextResult;

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

        webviewView.webview.onDidReceiveMessage((message: { command: string; text?: string; prompt?: string }) => {
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
            gap: 6px;
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

        /* Budget Meter */
        .budget-bar-container {
            width: 100%;
            height: 8px;
            background: rgba(128, 128, 128, 0.2);
            border-radius: 4px;
            overflow: hidden;
            margin: 6px 0;
        }

        .budget-bar-fill {
            height: 100%;
            width: 0%;
            background: var(--vscode-progressBar-background, #3794ff);
            transition: width 0.3s ease;
        }

        .budget-stats {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }

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

        .badge-editor {
            background: rgba(220, 150, 0, 0.2);
            color: #e5a93c;
            border: 1px solid rgba(220, 150, 0, 0.4);
        }

        .status-included {
            color: #2ecc71;
            font-weight: 600;
        }

        .status-truncated {
            color: #f1c40f;
            font-weight: 600;
        }

        .status-omitted {
            color: #e74c3c;
            font-weight: 600;
        }

        /* Candidates Table */
        .candidate-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 8px;
            font-size: 11px;
        }

        .candidate-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }

        .candidate-path {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            word-break: break-all;
        }

        .candidate-reason {
            color: var(--vscode-descriptionForeground);
            margin: 4px 0;
            font-size: 11px;
            line-height: 1.3;
        }

        .candidate-meta {
            display: flex;
            gap: 8px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }

        .candidate-snippet {
            display: none;
            margin-top: 6px;
            padding: 6px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 10px;
            white-space: pre;
            overflow-x: auto;
            max-height: 120px;
        }

        .toggle-snippet {
            cursor: pointer;
            text-decoration: underline;
            color: var(--vscode-textLink-foreground);
            font-size: 10px;
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
            <p class="subtitle">Intelligent Context Assembly Engine</p>
        </div>
    </div>

    <!-- Task & Context Assembly Form -->
    <div class="card">
        <h2 class="card-title">Context Assembly (Milestone 3)</h2>
        <div class="form-group">
            <label for="taskInput">Developer Task (use @file and @symbol):</label>
            <textarea id="taskInput" placeholder="e.g. Check authentication logic in @file src/services/TrueForgeService.ts and review @symbol testMcpBridge">Inspect authentication and check @symbol testMcpBridge</textarea>
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

    <!-- Context Budget & Rationale View -->
    <div id="contextSelectionContainer" class="card" style="display: none;">
        <h2 class="card-title">Explainable Context Selection</h2>
        
        <div class="budget-stats">
            <span id="budgetUsageLabel">Used: 0 / 16,000 tokens</span>
            <span id="budgetRemainingLabel">16,000 left</span>
        </div>
        <div class="budget-bar-container">
            <div id="budgetBarFill" class="budget-bar-fill"></div>
        </div>
        <div class="budget-stats" style="margin-top: 4px;">
            <span id="budgetExplicitTokens">Explicit: 0 tokens</span>
            <span id="budgetAutoTokens">Automatic: 0 tokens</span>
        </div>

        <div id="warningsAlert" class="alert-box" style="display: none;"></div>

        <div id="candidatesList" style="margin-top: 10px;"></div>
    </div>

    <!-- System Actions -->
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
        const contextContainer = document.getElementById('contextSelectionContainer');
        const budgetUsageLabel = document.getElementById('budgetUsageLabel');
        const budgetRemainingLabel = document.getElementById('budgetRemainingLabel');
        const budgetBarFill = document.getElementById('budgetBarFill');
        const budgetExplicitTokens = document.getElementById('budgetExplicitTokens');
        const budgetAutoTokens = document.getElementById('budgetAutoTokens');
        const warningsAlert = document.getElementById('warningsAlert');
        const candidatesList = document.getElementById('candidatesList');

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

        document.getElementById('runMcpProofBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'triggerRunMcpProof' });
        });

        document.getElementById('testConnectionBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'triggerTestConnection' });
        });

        // Listen for messages from extension host
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.command === 'setContextResult') {
                renderContextResult(msg.data);
            }
        });

        function renderContextResult(data) {
            if (!data) return;
            contextContainer.style.display = 'block';

            const budget = data.budget;
            const pct = Math.min(100, Math.round((budget.usedTokens / budget.maxContextAssemblyBudget) * 100));
            budgetBarFill.style.width = pct + '%';
            budgetUsageLabel.textContent = 'Used: ' + budget.usedTokens.toLocaleString() + ' / ' + budget.maxContextAssemblyBudget.toLocaleString() + ' tokens (' + pct + '%)';
            budgetRemainingLabel.textContent = budget.remainingTokens.toLocaleString() + ' left';
            budgetExplicitTokens.textContent = 'Explicit: ' + budget.explicitTokens.toLocaleString() + ' tokens';
            budgetAutoTokens.textContent = 'Automatic: ' + budget.automaticTokens.toLocaleString() + ' tokens';

            if (data.warnings && data.warnings.length > 0) {
                warningsAlert.style.display = 'block';
                warningsAlert.innerHTML = '<strong>Warnings:</strong><br>' + data.warnings.map(w => '&bull; ' + escapeHtml(w)).join('<br>');
            } else {
                warningsAlert.style.display = 'none';
            }

            candidatesList.innerHTML = '';
            if (!data.candidates || data.candidates.length === 0) {
                candidatesList.innerHTML = '<p style="color: var(--vscode-descriptionForeground); font-size: 11px;">No relevant context candidates found.</p>';
                return;
            }

            data.candidates.forEach((c, idx) => {
                const card = document.createElement('div');
                card.className = 'candidate-card';

                let sourceBadge = '<span class="badge-pill badge-auto">Automatic</span>';
                if (c.source === 'explicit_file') sourceBadge = '<span class="badge-pill badge-explicit">@file</span>';
                if (c.source === 'explicit_symbol') sourceBadge = '<span class="badge-pill badge-explicit">@symbol</span>';
                if (c.source === 'automatic_active_editor') sourceBadge = '<span class="badge-pill badge-editor">Editor</span>';

                let statusHtml = '<span class="status-included">Included</span>';
                if (c.status === 'truncated') statusHtml = '<span class="status-truncated">Truncated</span>';
                if (c.status === 'omitted_budget') statusHtml = '<span class="status-omitted">Omitted</span>';

                const snippetId = 'snippet-' + idx;
                const toggleId = 'toggle-' + idx;

                card.innerHTML = 
                    '<div class="candidate-header">' +
                        '<span class="candidate-path">' + escapeHtml(c.filePath) + (c.symbolName ? ' (' + escapeHtml(c.symbolName) + ')' : '') + '</span>' +
                        '<div>' + sourceBadge + ' ' + statusHtml + '</div>' +
                    '</div>' +
                    '<div class="candidate-reason">' + escapeHtml(c.selectionReason) + '</div>' +
                    '<div class="candidate-meta">' +
                        '<span>Lines: ' + c.startLine + '-' + c.endLine + '</span>' +
                        '<span>Tokens: ~' + c.estimatedTokens + '</span>' +
                        (c.relevanceScore ? '<span>Score: ' + c.relevanceScore + '</span>' : '') +
                        '<span id="' + toggleId + '" class="toggle-snippet">View Excerpt</span>' +
                    '</div>' +
                    '<div id="' + snippetId + '" class="candidate-snippet">' + escapeHtml(c.content) + '</div>';

                candidatesList.appendChild(card);

                const toggleEl = card.querySelector('#' + toggleId);
                const snippetEl = card.querySelector('#' + snippetId);
                toggleEl.addEventListener('click', () => {
                    const isVisible = snippetEl.style.display === 'block';
                    snippetEl.style.display = isVisible ? 'none' : 'block';
                    toggleEl.textContent = isVisible ? 'View Excerpt' : 'Hide Excerpt';
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

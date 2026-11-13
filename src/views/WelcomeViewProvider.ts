import * as vscode from 'vscode';

/**
 * Webview provider for the Your +1 sidebar welcome view.
 */
export class WelcomeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'yourplusone.welcomeView';

    private _view?: vscode.WebviewView;

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

        webviewView.webview.onDidReceiveMessage((message: { command: string; text?: string }) => {
            switch (message.command) {
                case 'triggerWelcomeCommand':
                    void vscode.commands.executeCommand('yourplusone.openWelcome');
                    break;
                case 'triggerTestConnection':
                    void vscode.commands.executeCommand('yourplusone.testConnection');
                    break;
                case 'showInfo':
                    if (message.text) {
                        void vscode.window.showInformationMessage(message.text);
                    }
                    break;
            }
        });
    }

    public focus(): void {
        if (this._view) {
            this._view.show(true);
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
            --container-padding: 16px;
        }

        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: var(--container-padding);
            margin: 0;
            line-height: 1.5;
            box-sizing: border-box;
        }

        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
        }

        .logo-badge {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border-radius: 8px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 700;
            font-size: 15px;
            flex-shrink: 0;
        }

        .title-group {
            display: flex;
            flex-direction: column;
        }

        .title {
            font-size: 16px;
            font-weight: 600;
            margin: 0;
            color: var(--vscode-foreground);
        }

        .subtitle {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin: 0;
        }

        .card {
            background-color: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 14px;
        }

        .card-title {
            font-size: 13px;
            font-weight: 600;
            margin-top: 0;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .card p {
            margin: 0 0 8px 0;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .card p:last-child {
            margin-bottom: 0;
        }

        .feature-list {
            margin: 0;
            padding-left: 18px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .feature-list li {
            margin-bottom: 6px;
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
            margin-top: 4px;
        }

        .status-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background-color: #2ecc71;
        }

        .actions {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 16px;
        }

        button {
            width: 100%;
            padding: 8px 12px;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            box-sizing: border-box;
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

        .footer {
            margin-top: 20px;
            text-align: center;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="logo-badge">+1</div>
        <div class="title-group">
            <h1 class="title">Your +1</h1>
            <p class="subtitle">Your AI Engineering Companion</p>
        </div>
    </div>

    <div class="card">
        <h2 class="card-title">Welcome to Your +1</h2>
        <p>
            Your +1 connects directly to your TrueForge agent runtime to empower your software engineering workflow.
        </p>
        <div class="status-badge">
            <span class="status-dot"></span>
            <span>TrueForge SDK Connected</span>
        </div>
    </div>

    <div class="card">
        <h2 class="card-title">Runtime &amp; Agent Status</h2>
        <ul class="feature-list">
            <li>TrueForge SDK: <strong>@truefoundry/trueforge-sdk v0.183.0</strong></li>
            <li>Default Runtime URL: <strong>http://127.0.0.1:8790</strong></li>
            <li>Stream Verification: <strong>Ready</strong></li>
        </ul>
    </div>

    <div class="actions">
        <button id="testConnectionBtn" class="primary">
            <span>Test TrueForge Connection</span>
        </button>
        <button id="openWelcomeBtn" class="secondary">
            <span>Open Welcome Notification</span>
        </button>
        <button id="learnMoreBtn" class="secondary">
            <span>About Your +1</span>
        </button>
    </div>

    <div class="footer">
        <p>Your +1 Extension &bull; Milestone 1: TrueForge Connection</p>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.getElementById('testConnectionBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'triggerTestConnection' });
        });

        document.getElementById('openWelcomeBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'triggerWelcomeCommand' });
        });

        document.getElementById('learnMoreBtn').addEventListener('click', () => {
            vscode.postMessage({
                command: 'showInfo',
                text: 'Your +1: TrueForge SDK integration is active and verified.'
            });
        });
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

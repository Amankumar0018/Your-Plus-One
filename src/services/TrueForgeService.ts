import * as vscode from 'vscode';

export interface TrueForgeConfig {
    runtimeUrl: string;
    apiToken: string;
    model?: string;
    timeoutInSeconds?: number;
}

export interface TestConnectionResult {
    success: boolean;
    model?: string;
    response?: string;
    sessionId?: string;
    error?: string;
}

/**
 * Service responsible for communicating with the TrueForge runtime via the official SDK.
 */
export class TrueForgeService {
    private readonly _config: TrueForgeConfig;

    constructor(configOverrides?: Partial<TrueForgeConfig>) {
        const vsConfig = vscode.workspace.getConfiguration('yourplusone');
        this._config = {
            runtimeUrl: configOverrides?.runtimeUrl ?? vsConfig.get<string>('runtimeUrl') ?? 'http://127.0.0.1:8790',
            apiToken: configOverrides?.apiToken ?? vsConfig.get<string>('apiToken') ?? 'trueforge-standalone',
            model: configOverrides?.model ?? vsConfig.get<string>('model') ?? '',
            timeoutInSeconds: configOverrides?.timeoutInSeconds ?? 30
        };
    }

    /**
     * Resolves the runtime URL, handling loopback address dual-stacking (127.0.0.1 vs localhost)
     * if the server is bound strictly to IPv6 or IPv4.
     */
    public async resolveBaseUrl(rawUrl: string, output?: vscode.OutputChannel): Promise<string> {
        const trimmed = rawUrl.replace(/\/+$/, '');
        
        // Fast probe of the configured URL
        if (await this._probeHealth(trimmed)) {
            return trimmed;
        }

        // On Windows 11, Node's server might bind to IPv6 ::1 (localhost) only, causing 127.0.0.1 to refuse
        if (trimmed.includes('127.0.0.1')) {
            const localhostVariant = trimmed.replace('127.0.0.1', 'localhost');
            if (await this._probeHealth(localhostVariant)) {
                output?.appendLine(`[Your +1] Notice: Switched loopback target from ${trimmed} to ${localhostVariant} (IPv6 binding detected).`);
                return localhostVariant;
            }
        } else if (trimmed.includes('localhost')) {
            const ipv4Variant = trimmed.replace('localhost', '127.0.0.1');
            if (await this._probeHealth(ipv4Variant)) {
                output?.appendLine(`[Your +1] Notice: Switched loopback target from ${trimmed} to ${ipv4Variant}.`);
                return ipv4Variant;
            }
        }

        return trimmed;
    }

    /**
     * Dynamically imports the TrueForge SDK constructor to support Node.js ESM loader compatibility.
     */
    private async _getClientConstructor(): Promise<any> {
        const sdk = await import('@truefoundry/trueforge-sdk');
        return sdk.TrueForge;
    }

    /**
     * Executes the verification sequence:
     * 1. Reachability check
     * 2. Model retrieval
     * 3. Temporary session creation
     * 4. PONG turn execution and streaming into output channel
     * 5. Safe session cleanup
     */
    public async testConnection(outputChannel: vscode.OutputChannel): Promise<TestConnectionResult> {
        outputChannel.appendLine(`========================================================`);
        outputChannel.appendLine(`[Your +1] Initiating TrueForge SDK Connection Test`);
        outputChannel.appendLine(`[Your +1] Configured URL: ${this._config.runtimeUrl}`);
        outputChannel.appendLine(`========================================================`);

        let resolvedUrl = this._config.runtimeUrl;
        try {
            resolvedUrl = await this.resolveBaseUrl(this._config.runtimeUrl, outputChannel);
        } catch {
            // Use configured URL as fallback
        }

        outputChannel.appendLine(`[Your +1] Connecting to TrueForge runtime at: ${resolvedUrl}`);

        const TrueForgeClientClass = await this._getClientConstructor();
        const client = new TrueForgeClientClass({
            baseUrl: resolvedUrl,
            token: this._config.apiToken,
            timeoutInSeconds: this._config.timeoutInSeconds ?? 30
        });

        let createdSessionId: string | undefined;

        try {
            // 1. Retrieve model list
            outputChannel.appendLine(`[Your +1] Step 1: Retrieving configured models from TrueForge...`);
            let modelsResponse: any;
            try {
                modelsResponse = await client.models.list();
            } catch (err: unknown) {
                const errorMsg = this._formatError(err, resolvedUrl);
                outputChannel.appendLine(`[Your +1] ERROR in Step 1: ${errorMsg}`);
                return { success: false, error: errorMsg };
            }

            const models = modelsResponse.data ?? [];
            if (models.length === 0) {
                const errorMsg = 'No models configured in TrueForge runtime. Please configure a model in TrueForge settings.';
                outputChannel.appendLine(`[Your +1] ERROR: ${errorMsg}`);
                return { success: false, error: errorMsg };
            }

            outputChannel.appendLine(`[Your +1] Found ${models.length} model(s) in TrueForge:`);
            for (const m of models) {
                outputChannel.appendLine(`   - ${m.name} (model ID: ${m.modelId}, provider: ${m.provider.name})`);
            }

            // Select model
            let selectedModel = models[0].name;
            if (this._config.model && this._config.model.trim().length > 0) {
                const matching = models.find((m: any) => m.name === this._config.model?.trim() || m.modelId === this._config.model?.trim());
                if (matching) {
                    selectedModel = matching.name;
                } else {
                    outputChannel.appendLine(`[Your +1] Warning: Configured model "${this._config.model}" not found in TrueForge. Falling back to "${selectedModel}".`);
                }
            }
            outputChannel.appendLine(`[Your +1] Selected model for verification: ${selectedModel}`);

            // 2. Create temporary session
            outputChannel.appendLine(`[Your +1] Step 2: Creating temporary session...`);
            const sessionRes = await client.sessions.create({
                agent: {
                    spec: {
                        model: {
                            name: selectedModel
                        }
                    }
                }
            });

            createdSessionId = sessionRes.data?.id;
            if (!createdSessionId) {
                throw new Error('TrueForge did not return a valid session ID.');
            }
            outputChannel.appendLine(`[Your +1] Created session successfully. ID: ${createdSessionId}`);

            // 3. Send test instruction and stream response
            outputChannel.appendLine(`[Your +1] Step 3: Streaming test instruction: "Reply with exactly: PONG"...`);
            outputChannel.appendLine(`---------------- [Stream Output Start] ----------------`);

            const stream = await client.sessions.createTurnStream(createdSessionId, {
                input: [
                    {
                        type: 'user.message',
                        content: 'Reply with exactly: PONG'
                    }
                ]
            });

            let streamedContent = '';
            for await (const event of stream) {
                if (event.type === 'model.message.delta' && event.content) {
                    streamedContent += event.content;
                    outputChannel.append(event.content);
                } else if (event.type === 'turn.done') {
                    outputChannel.appendLine(`\n----------------- [Stream Output End] -----------------`);
                    outputChannel.appendLine(`[Your +1] Turn completed with status: ${event.state.status}`);
                }
            }

            const trimmedResponse = streamedContent.trim();
            outputChannel.appendLine(`[Your +1] Full received response: "${trimmedResponse}"`);

            return {
                success: true,
                model: selectedModel,
                response: trimmedResponse,
                sessionId: createdSessionId
            };
        } catch (err: unknown) {
            const errorMsg = this._formatError(err, resolvedUrl);
            outputChannel.appendLine(`[Your +1] ERROR during connection test: ${errorMsg}`);
            return {
                success: false,
                error: errorMsg,
                sessionId: createdSessionId
            };
        } finally {
            // 4. Safe session cleanup
            if (createdSessionId) {
                try {
                    outputChannel.appendLine(`[Your +1] Step 4: Cleaning up temporary session (${createdSessionId})...`);
                    await client.sessions.delete(createdSessionId);
                    outputChannel.appendLine(`[Your +1] Temporary session deleted successfully.`);
                } catch (cleanupErr: unknown) {
                    outputChannel.appendLine(`[Your +1] Warning: Failed to clean up session ${createdSessionId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
                }
            }
        }
    }

    private async _probeHealth(baseUrl: string): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(`${baseUrl}/healthz`, {
                signal: controller.signal
            });
            clearTimeout(timeout);
            return res.ok;
        } catch {
            return false;
        }
    }

    private _formatError(err: unknown, url: string): string {
        if (!err) {
            return 'Unknown error occurred.';
        }
        const message = err instanceof Error ? err.message : String(err);
        
        if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
            return `Cannot connect to TrueForge at ${url}. Please ensure TrueForge is running ('npx @truefoundry/trueforge') and port 8790 is accessible.`;
        }
        if (message.includes('401') || message.includes('Unauthorized')) {
            return `TrueForge authentication failed (401 Unauthorized). Verify yourplusone.apiToken setting. Default standalone token is 'trueforge-standalone'.`;
        }
        if (message.includes('404') || message.includes('NotFound')) {
            return `TrueForge endpoint not found (404). Verify that the TrueForge server is running the expected v0.183+ API.`;
        }

        return message;
    }
}

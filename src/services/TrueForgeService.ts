import * as vscode from 'vscode';
import { McpServerService } from './McpServerService.js';

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

export interface TestMcpBridgeResult {
    success: boolean;
    model?: string;
    finalResponse?: string;
    toolCallsDetected: Array<{ tool: string; arguments: Record<string, unknown> }>;
    toolsDiscovered: string[];
    sessionId?: string;
    mcpServerUrl?: string;
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

    /**
     * Executes the read-only MCP bridge verification sequence:
     * 1. Starts embedded Streamable HTTP MCP server on loopback with bearer auth.
     * 2. Registers MCP server in TrueForge settings via verified SDK method.
     * 3. Verifies TrueForge tool discovery.
     * 4. Creates agent session with attached tools and inline specification.
     * 5. Dispatches task instructing the model to find a marker and read its file.
     * 6. Captures and streams model events and MCP server execution proofs.
     * 7. Safely cleans up session, unregisters MCP server, and stops local server.
     */
    public async testMcpBridge(
        workspaceRoot: string,
        outputChannel: vscode.OutputChannel,
        marker = 'YOUR_PLUS_ONE_MARKER_2026'
    ): Promise<TestMcpBridgeResult> {
        outputChannel.appendLine(`========================================================`);
        outputChannel.appendLine(`[Your +1] Initiating Read-only MCP Bridge Verification`);
        outputChannel.appendLine(`[Your +1] Workspace Root: ${workspaceRoot}`);
        outputChannel.appendLine(`[Your +1] Target Marker: ${marker}`);
        outputChannel.appendLine(`========================================================`);

        let resolvedUrl = this._config.runtimeUrl;
        try {
            resolvedUrl = await this.resolveBaseUrl(this._config.runtimeUrl, outputChannel);
        } catch {
            // fallback
        }

        outputChannel.appendLine(`[Your +1] Connecting to TrueForge runtime at: ${resolvedUrl}`);

        const TrueForgeClientClass = await this._getClientConstructor();
        const client = new TrueForgeClientClass({
            baseUrl: resolvedUrl,
            token: this._config.apiToken,
            timeoutInSeconds: this._config.timeoutInSeconds ?? 60
        });

        const mcpServerName = 'yourplusone-tools';
        let createdSessionId: string | undefined;
        let mcpRegistered = false;

        // 1. Initialize local MCP server service
        outputChannel.appendLine(`[Your +1] Step 1: Starting embedded MCP server inside Extension Host...`);
        const mcpService = new McpServerService({
            workspaceRoot,
            logger: (msg) => outputChannel.appendLine(`[MCP Log] ${msg}`)
        });

        let serverInfo: { port: number; url: string; authToken: string; host: string } | undefined;

        try {
            serverInfo = await mcpService.start();
            outputChannel.appendLine(`[Your +1] MCP Server running on loopback: ${serverInfo.url}`);

            // 2. Register MCP server in TrueForge
            outputChannel.appendLine(`[Your +1] Step 2: Registering MCP server "${mcpServerName}" with TrueForge...`);
            await client.settings.mcpServers.createOrUpdate({
                manifest: {
                    type: 'remote',
                    name: mcpServerName,
                    url: serverInfo.url,
                    description: 'Your +1 workspace tools (search_workspace, read_file)',
                    auth: {
                        type: 'header',
                        headers: {
                            Authorization: `Bearer ${serverInfo.authToken}`
                        }
                    }
                }
            });
            mcpRegistered = true;
            outputChannel.appendLine(`[Your +1] MCP Server "${mcpServerName}" registered successfully.`);

            // 3. Query tool definitions via TrueForge
            outputChannel.appendLine(`[Your +1] Step 3: Verifying tool discovery via TrueForge API...`);
            const toolsRes = await client.mcpServers.listTools(mcpServerName);
            const discoveredTools: string[] = (toolsRes.data ?? []).map((t: any) => t.name ?? 'unknown');
            outputChannel.appendLine(`[Your +1] TrueForge discovered tools: ${discoveredTools.join(', ')}`);

            // 4. Resolve model
            outputChannel.appendLine(`[Your +1] Step 4: Resolving configured model...`);
            const modelsResponse = await client.models.list();
            const availableModels = modelsResponse.data ?? [];
            let selectedModel = this._config.model;
            if (!selectedModel || !availableModels.some((m: any) => m.name === selectedModel)) {
                selectedModel = availableModels[0]?.name ?? 'google-gemini/gemini-3-1-flash-lite';
            }
            outputChannel.appendLine(`[Your +1] Using model: ${selectedModel}`);

            // 5. Create agent session with inline spec attaching MCP server
            outputChannel.appendLine(`[Your +1] Step 5: Creating agent session with attached tools...`);
            const sessionRes = await client.sessions.create({
                agent: {
                    spec: {
                        model: { name: selectedModel },
                        instructions: 'You are Your +1, an AI engineering companion. You have access to tools: search_workspace and read_file. When asked to locate or read code or files in the workspace, you MUST independently use the search_workspace tool to locate the file, then use the read_file tool to read its contents, and report your findings accurately based on the file content.',
                        mcp_servers: [
                            {
                                name: mcpServerName,
                                enable_tools: ['search_workspace', 'read_file'],
                                preload: true,
                                preload_tools: ['search_workspace', 'read_file'],
                                require_approval_for_tools: []
                            }
                        ]
                    }
                }
            });

            createdSessionId = sessionRes.data?.id;
            if (!createdSessionId) {
                throw new Error('TrueForge did not return a session ID.');
            }
            outputChannel.appendLine(`[Your +1] Session created: ${createdSessionId}`);

            // 6. Run autonomous turn instruction
            outputChannel.appendLine(`[Your +1] Step 6: Dispatching instruction to agent...`);
            const prompt = `Step 1: Use search_workspace to locate '${marker}'. Step 2: Use read_file on the discovered file to inspect its complete contents. Step 3: Report the filename and the exact secret verification phrase found inside.`;
            outputChannel.appendLine(`[Your +1] Instruction: "${prompt}"`);
            outputChannel.appendLine(`---------------- [Stream Output Start] ----------------`);

            const stream = await client.sessions.createTurnStream(createdSessionId, {
                input: [
                    {
                        type: 'user.message',
                        content: prompt
                    }
                ]
            });

            let fullContent = '';
            for await (const event of stream) {
                if (event.type === 'model.message.delta' && event.content) {
                    fullContent += event.content;
                    outputChannel.append(event.content);
                } else if (event.type === 'model.message' && event.toolCalls && event.toolCalls.length > 0) {
                    for (const tc of event.toolCalls) {
                        outputChannel.appendLine(`\n[Agent Event] Model requested tool "${tc.name}" with arguments: ${JSON.stringify(tc.arguments)}`);
                    }
                } else if (event.type === 'tool.response') {
                    outputChannel.appendLine(`\n[Agent Event] Tool result returned to model (Tool Call ID: ${event.toolCallId})`);
                } else if (event.type === 'turn.done') {
                    outputChannel.appendLine(`\n----------------- [Stream Output End] -----------------`);
                    outputChannel.appendLine(`[Your +1] Turn completed with status: ${event.state.status}`);
                }
            }

            const trimmedResponse = fullContent.trim();
            outputChannel.appendLine(`[Your +1] Final Model Response:\n${trimmedResponse}`);

            const capturedCalls = [...mcpService.toolCalls];
            outputChannel.appendLine(`[Your +1] MCP Server recorded ${capturedCalls.length} tool invocation(s):`);
            for (const call of capturedCalls) {
                outputChannel.appendLine(`  - ${call.tool}(${JSON.stringify(call.arguments)})`);
            }

            const searchCalled = capturedCalls.some((c) => c.tool === 'search_workspace');
            const readFileCalled = capturedCalls.some((c) => c.tool === 'read_file');

            return {
                success: searchCalled && readFileCalled,
                model: selectedModel,
                finalResponse: trimmedResponse,
                toolCallsDetected: capturedCalls.map((c) => ({ tool: c.tool, arguments: c.arguments })),
                toolsDiscovered: discoveredTools,
                sessionId: createdSessionId,
                mcpServerUrl: serverInfo.url
            };
        } catch (err: unknown) {
            const errorMsg = this._formatError(err, resolvedUrl);
            outputChannel.appendLine(`[Your +1] ERROR in MCP Bridge verification: ${errorMsg}`);
            return {
                success: false,
                error: errorMsg,
                toolCallsDetected: [...mcpService.toolCalls].map((c) => ({ tool: c.tool, arguments: c.arguments })),
                toolsDiscovered: [],
                sessionId: createdSessionId
            };
        } finally {
            // 7. Cleanup session, TrueForge MCP server registration, and local HTTP server
            outputChannel.appendLine(`[Your +1] Step 7: Cleaning up resources...`);

            if (createdSessionId) {
                try {
                    await client.sessions.delete(createdSessionId);
                    outputChannel.appendLine(`[Your +1] Deleted temporary session: ${createdSessionId}`);
                } catch (delErr: unknown) {
                    outputChannel.appendLine(`[Your +1] Warning deleting session: ${delErr instanceof Error ? delErr.message : String(delErr)}`);
                }
            }

            if (mcpRegistered) {
                try {
                    await client.settings.mcpServers.delete(mcpServerName);
                    outputChannel.appendLine(`[Your +1] Deregistered MCP server: ${mcpServerName}`);
                } catch (deregErr: unknown) {
                    outputChannel.appendLine(`[Your +1] Warning deregistering MCP server: ${deregErr instanceof Error ? deregErr.message : String(deregErr)}`);
                }
            }

            try {
                await mcpService.stop();
            } catch (stopErr: unknown) {
                outputChannel.appendLine(`[Your +1] Warning stopping MCP service: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
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

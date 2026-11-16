import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface McpServerConfig {
    workspaceRoot: string;
    port?: number;
    host?: string;
    authToken?: string;
    maxFileSize?: number;
    logger?: (message: string) => void;
}

export interface McpServerInfo {
    port: number;
    url: string;
    authToken: string;
    host: string;
}

export interface ToolCallRecord {
    tool: string;
    arguments: Record<string, unknown>;
    timestamp: number;
    success: boolean;
}

const DEFAULT_MAX_FILE_SIZE = 256 * 1024; // 256 KB

const EXCLUDED_DIRS = new Set([
    '.git',
    'node_modules',
    'out',
    'dist',
    '.vscode',
    '.vscode-test',
    '__pycache__',
    '.pytest_cache',
    '.venv',
    'venv',
    'coverage',
    '.next',
    '.nuxt',
    'build',
    'target'
]);

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.pyc', '.wasm',
    '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.avi', '.mov'
]);

const SENSITIVE_FILE_REGEXES = [
    /^\.env(\..+)?$/i,
    /\.(pem|key|pkcs12|pfx|p12|id_rsa|id_ed25519)$/i,
    /^(credentials|secrets|shadow|passwd)(\..+)?$/i
];

/**
 * Embedded Model Context Protocol (MCP) server hosted within the extension process.
 * Exposes strictly read-only tools (search_workspace, read_file) over Streamable HTTP.
 */
export class McpServerService {
    private readonly _workspaceRoot: string;
    private readonly _port: number;
    private readonly _host: string;
    private readonly _authToken: string;
    private readonly _maxFileSize: number;
    private readonly _logger?: (message: string) => void;

    private _httpServer: http.Server | undefined;
    private readonly _sessions = new Map<string, StreamableHTTPServerTransport>();
    private readonly _sockets = new Set<Socket>();
    private readonly _toolCalls: ToolCallRecord[] = [];
    private _isRunning = false;

    constructor(config: McpServerConfig) {
        this._workspaceRoot = path.resolve(config.workspaceRoot);
        this._port = config.port ?? 0;
        this._host = config.host ?? '127.0.0.1';
        this._authToken = config.authToken ?? crypto.randomBytes(32).toString('hex');
        this._maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
        this._logger = config.logger;
    }

    public get authToken(): string {
        return this._authToken;
    }

    public get isRunning(): boolean {
        return this._isRunning;
    }

    public get toolCalls(): readonly ToolCallRecord[] {
        return this._toolCalls;
    }

    public clearToolCalls(): void {
        this._toolCalls.length = 0;
    }

    /**
     * Initializes and starts the MCP HTTP server on loopback interface.
     */
    public async start(): Promise<McpServerInfo> {
        if (this._isRunning) {
            throw new Error('McpServerService is already running');
        }

        this._log(`Starting local MCP server on ${this._host}...`);

        this._httpServer = http.createServer((req, res) => {
            // Verify loopback authorization header
            const authHeader = req.headers['authorization'];
            if (!authHeader || authHeader !== `Bearer ${this._authToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Unauthorized: missing or invalid bearer token' } }));
                return;
            }

            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', async () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsedBody: unknown;
                try {
                    parsedBody = raw ? JSON.parse(raw) : undefined;
                } catch {
                    // Body might not be JSON (e.g. GET stream)
                }

                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                let transport: StreamableHTTPServerTransport | undefined;

                if (sessionId && this._sessions.has(sessionId)) {
                    transport = this._sessions.get(sessionId);
                } else if (!sessionId && req.method === 'POST') {
                    // New session initialization request
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => crypto.randomUUID(),
                        onsessioninitialized: (id) => {
                            this._sessions.set(id, transport!);
                            this._log(`MCP session initialized: ${id}`);
                        }
                    });

                    transport.onclose = () => {
                        const sid = transport?.sessionId;
                        if (sid && this._sessions.has(sid)) {
                            this._sessions.delete(sid);
                            this._log(`MCP session closed: ${sid}`);
                        }
                    };

                    const mcpInstance = this._createMcpServer();
                    await mcpInstance.connect(transport);
                } else if (sessionId) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
                    return;
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No session ID provided' }, id: null }));
                    return;
                }

                try {
                    await transport!.handleRequest(req, res, parsedBody);
                } catch (err: unknown) {
                    this._log(`Error in transport.handleRequest: ${err instanceof Error ? err.message : String(err)}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
                    }
                }
            });
        });

        this._httpServer.on('connection', (socket) => {
            this._sockets.add(socket);
            socket.on('close', () => this._sockets.delete(socket));
        });

        await new Promise<void>((resolve, reject) => {
            this._httpServer?.once('error', reject);
            this._httpServer?.listen(this._port, this._host, () => {
                this._isRunning = true;
                resolve();
            });
        });

        const address = this._httpServer.address();
        if (!address || typeof address === 'string') {
            throw new Error('Failed to obtain server listening address');
        }

        const boundPort = address.port;
        const endpointUrl = `http://${this._host}:${boundPort}/mcp`;
        this._log(`Local MCP server listening on ${endpointUrl}`);

        return {
            port: boundPort,
            url: endpointUrl,
            authToken: this._authToken,
            host: this._host
        };
    }

    /**
     * Safely stops the server, closing active sockets and unbinding listeners.
     */
    public async stop(): Promise<void> {
        if (!this._isRunning) {
            return;
        }

        this._log('Stopping local MCP server...');
        this._isRunning = false;

        // Destroy active sockets
        for (const socket of this._sockets) {
            socket.destroy();
        }
        this._sockets.clear();

        for (const [sid, transport] of this._sessions) {
            try {
                await transport.close();
            } catch (err: unknown) {
                this._log(`Notice: Error closing MCP transport for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        this._sessions.clear();

        if (this._httpServer) {
            await new Promise<void>((resolve) => {
                this._httpServer?.close(() => resolve());
            });
            this._httpServer = undefined;
        }

        this._log('Local MCP server stopped cleanly.');
    }

    /**
     * Creates and configures an McpServer instance with registered tools.
     */
    private _createMcpServer(): McpServer {
        const server = new McpServer({
            name: 'your-plus-one-tools',
            version: '0.1.0'
        });

        this._registerTools(server);
        return server;
    }

    /**
     * Registers the read_file and search_workspace tools on the MCP server.
     */
    private _registerTools(server: McpServer): void {
        // Tool 1: search_workspace
        server.tool(
            'search_workspace',
            'Search workspace source files for a text query. Returns matching file paths and line excerpts.',
            {
                query: z.string().describe('The search query or keyword to find in workspace source files'),
                maxResults: z.number().optional().describe('Maximum number of matching files to return (default: 20, max: 50)')
            },
            async ({ query, maxResults }) => {
                this._recordToolCall('search_workspace', { query, maxResults });
                try {
                    const results = this.executeSearchWorkspace(query, maxResults);
                    return {
                        content: [{ type: 'text', text: results }]
                    };
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Error searching workspace: ${errorMsg}` }]
                    };
                }
            }
        );

        // Tool 2: read_file
        server.tool(
            'read_file',
            'Read a text file using a workspace-relative path. Returns file contents with path and size metadata.',
            {
                path: z.string().describe('Workspace-relative path to the file to read (e.g. "src/helpers.ts")')
            },
            async ({ path: relPath }) => {
                this._recordToolCall('read_file', { path: relPath });
                try {
                    const content = this.executeReadFile(relPath);
                    return {
                        content: [{ type: 'text', text: content }]
                    };
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Error reading file: ${errorMsg}` }]
                    };
                }
            }
        );
    }

    /**
     * Executes read_file with path normalization, traversal checks, size enforcement, and binary validation.
     */
    public executeReadFile(rawPath: string): string {
        if (!rawPath || typeof rawPath !== 'string') {
            throw new Error('File path must be a non-empty string');
        }

        // 1. Reject absolute paths and drive letters
        if (path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath) || rawPath.startsWith('\\\\')) {
            throw new Error(`Absolute paths are not allowed: "${rawPath}". Use workspace-relative paths.`);
        }

        // 2. Reject path traversal
        const normalized = path.normalize(rawPath).replace(/^(\.[/\\])+/, '');
        const segments = normalized.split(/[/\\]/);
        if (segments.includes('..')) {
            throw new Error(`Directory traversal detected: "${rawPath}". Access outside workspace is denied.`);
        }

        // 3. Resolve inside workspace root
        const resolved = path.resolve(this._workspaceRoot, normalized);
        const rootWithSep = this._workspaceRoot.endsWith(path.sep) ? this._workspaceRoot : this._workspaceRoot + path.sep;
        if (!resolved.startsWith(rootWithSep) && resolved !== this._workspaceRoot) {
            throw new Error(`Access denied: path "${rawPath}" resolves outside workspace root.`);
        }

        // 4. Check for sensitive files
        const basename = path.basename(resolved);
        if (SENSITIVE_FILE_REGEXES.some((regex) => regex.test(basename))) {
            throw new Error(`Access to sensitive file denied: "${rawPath}".`);
        }
        if (resolved.includes(path.sep + '.git' + path.sep) || resolved.endsWith(path.sep + '.git')) {
            throw new Error(`Access to .git directory contents denied: "${rawPath}".`);
        }

        // 5. Verify file exists and is a regular file
        if (!fs.existsSync(resolved)) {
            throw new Error(`File not found: "${rawPath}".`);
        }

        // Verify symlinks don't escape workspace
        try {
            const realPath = fs.realpathSync(resolved);
            if (!realPath.startsWith(rootWithSep) && realPath !== this._workspaceRoot) {
                throw new Error(`Access denied: symlink "${rawPath}" targets outside workspace.`);
            }
        } catch {
            throw new Error(`Cannot resolve path: "${rawPath}".`);
        }

        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            throw new Error(`Target is not a regular file: "${rawPath}".`);
        }

        // 6. Enforce file size limit
        if (stat.size > this._maxFileSize) {
            throw new Error(`File "${rawPath}" exceeds maximum size limit (${this._maxFileSize} bytes; size is ${stat.size} bytes).`);
        }

        // 7. Reject known binary extensions
        const ext = path.extname(resolved).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
            throw new Error(`Binary file rejected: "${rawPath}". Only text files may be read.`);
        }

        // 8. Read buffer and check for null bytes (binary content detector)
        const buffer = fs.readFileSync(resolved);
        const sampleLimit = Math.min(buffer.length, 8000);
        for (let i = 0; i < sampleLimit; i++) {
            if (buffer[i] === 0) {
                throw new Error(`Binary content detected in file: "${rawPath}".`);
            }
        }

        const textContent = buffer.toString('utf8');
        return `[File: ${normalized} | Size: ${stat.size} bytes]\n${textContent}`;
    }

    /**
     * Executes search_workspace across workspace files respecting exclusions and bounds.
     */
    public executeSearchWorkspace(query: string, maxResults?: number): string {
        if (!query || query.trim().length === 0) {
            throw new Error('Search query must be a non-empty string');
        }

        const limit = Math.min(Math.max(1, maxResults ?? 20), 50);
        const normalizedQuery = query.toLowerCase();
        const matches: Array<{ file: string; line: number; excerpt: string }> = [];
        let matchingFilesCount = 0;

        const walk = (dir: string, depth = 0): void => {
            if (depth > 12 || matchingFilesCount >= limit) {
                return;
            }

            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                if (matchingFilesCount >= limit) {
                    break;
                }

                const entryName = entry.name;
                const fullPath = path.join(dir, entryName);

                if (entry.isDirectory()) {
                    if (EXCLUDED_DIRS.has(entryName) || entryName.startsWith('.')) {
                        continue;
                    }
                    walk(fullPath, depth + 1);
                } else if (entry.isFile()) {
                    // Skip sensitive files
                    if (SENSITIVE_FILE_REGEXES.some((re) => re.test(entryName))) {
                        continue;
                    }

                    // Skip binary extensions
                    const ext = path.extname(entryName).toLowerCase();
                    if (BINARY_EXTENSIONS.has(ext) || entryName === 'package-lock.json') {
                        continue;
                    }

                    // Check file size (< 256 KB for search)
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.size > this._maxFileSize || stat.size === 0) {
                            continue;
                        }

                        const buffer = fs.readFileSync(fullPath);
                        // Quick binary check
                        const sampleLimit = Math.min(buffer.length, 512);
                        let isBinary = false;
                        for (let i = 0; i < sampleLimit; i++) {
                            if (buffer[i] === 0) {
                                isBinary = true;
                                break;
                            }
                        }
                        if (isBinary) {
                            continue;
                        }

                        const content = buffer.toString('utf8');
                        const lines = content.split(/\r?\n/);
                        let fileMatched = false;
                        let matchesInFile = 0;

                        for (let lineIdx = 0; lineIdx < lines.length && matchesInFile < 5; lineIdx++) {
                            const line = lines[lineIdx];
                            if (line.toLowerCase().includes(normalizedQuery)) {
                                if (!fileMatched) {
                                    fileMatched = true;
                                    matchingFilesCount++;
                                }
                                matchesInFile++;
                                const relPath = path.relative(this._workspaceRoot, fullPath).replace(/\\/g, '/');
                                matches.push({
                                    file: relPath,
                                    line: lineIdx + 1,
                                    excerpt: line.trim().slice(0, 180)
                                });
                            }
                        }
                    } catch {
                        // Skip unreadable files
                    }
                }
            }
        };

        walk(this._workspaceRoot);

        if (matches.length === 0) {
            return `No matches found in workspace for query: "${query}"`;
        }

        const formatted = matches.map((m) => `  ${m.file}:${m.line} -> ${m.excerpt}`).join('\n');
        return `Found ${matches.length} match(es) across ${matchingFilesCount} file(s) for "${query}":\n${formatted}`;
    }

    private _recordToolCall(tool: string, args: Record<string, unknown>): void {
        this._toolCalls.push({
            tool,
            arguments: args,
            timestamp: Date.now(),
            success: true
        });
        this._log(`[MCP Server] Executed tool: ${tool} with args: ${JSON.stringify(args)}`);
    }

    private _log(msg: string): void {
        if (this._logger) {
            this._logger(msg);
        }
    }
}

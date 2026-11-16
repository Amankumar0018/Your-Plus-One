import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import { McpServerService } from '../services/McpServerService.js';
import { TrueForgeService } from '../services/TrueForgeService.js';
import * as vscode from 'vscode';

suite('McpServerService & Tool Security Test Suite', () => {
    let tempDir: string;
    let service: McpServerService;

    suiteSetup(() => {
        // Create an isolated temporary test workspace
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yourplusone-mcp-test-'));

        // Populate test workspace files
        fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'Hello from Your +1 MCP Test!\nLine 2 has marker YOUR_PLUS_ONE_MARKER_2026 for testing.\nLine 3 end.');
        fs.writeFileSync(path.join(tempDir, 'subfolder.txt'), 'Another text file in root.');
        
        fs.mkdirSync(path.join(tempDir, 'nested'));
        fs.writeFileSync(path.join(tempDir, 'nested', 'deep.ts'), 'export const SECRET = "nested-marker-data";\n// Line 2\n');

        // Create sensitive files
        fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET_API_KEY=super-secret-value');
        fs.writeFileSync(path.join(tempDir, '.env.local'), 'LOCAL_SECRET=local-value');
        fs.writeFileSync(path.join(tempDir, 'private.pem'), '-----BEGIN RSA PRIVATE KEY-----');
        fs.writeFileSync(path.join(tempDir, 'credentials.json'), '{"token": "secret"}');

        // Create fake .git folder
        fs.mkdirSync(path.join(tempDir, '.git'));
        fs.writeFileSync(path.join(tempDir, '.git', 'config'), '[core]\nrepositoryformatversion = 0');

        // Create fake binary file with null byte
        const binBuffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
        fs.writeFileSync(path.join(tempDir, 'binary.bin'), binBuffer);
        fs.writeFileSync(path.join(tempDir, 'image.png'), binBuffer);

        // Create oversized file (> 1000 bytes for custom limit test)
        fs.writeFileSync(path.join(tempDir, 'large.txt'), 'A'.repeat(2000));

        service = new McpServerService({
            workspaceRoot: tempDir,
            maxFileSize: 1000 // custom small limit for test
        });
    });

    suiteTeardown(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    test('read_file should successfully read a valid workspace-relative text file', () => {
        const content = service.executeReadFile('sample.txt');
        assert.ok(content.includes('[File: sample.txt'), 'Output should contain file header');
        assert.ok(content.includes('Hello from Your +1 MCP Test!'), 'Output should contain file body');
    });

    test('read_file should successfully read a nested relative text file', () => {
        const content = service.executeReadFile('nested/deep.ts');
        assert.ok(content.includes('nested-marker-data'), 'Should read nested file');
    });

    test('read_file should reject absolute paths', () => {
        assert.throws(
            () => service.executeReadFile(path.join(tempDir, 'sample.txt')),
            /Absolute paths are not allowed/
        );
    });

    test('read_file should reject directory traversal (..)', () => {
        assert.throws(
            () => service.executeReadFile('../outside.txt'),
            /Directory traversal detected/
        );
        assert.throws(
            () => service.executeReadFile('nested/../../escape.txt'),
            /Directory traversal detected/
        );
    });

    test('read_file should reject access to sensitive files (.env, .pem, credentials)', () => {
        assert.throws(
            () => service.executeReadFile('.env'),
            /Access to sensitive file denied/
        );
        assert.throws(
            () => service.executeReadFile('.env.local'),
            /Access to sensitive file denied/
        );
        assert.throws(
            () => service.executeReadFile('private.pem'),
            /Access to sensitive file denied/
        );
        assert.throws(
            () => service.executeReadFile('credentials.json'),
            /Access to sensitive file denied/
        );
    });

    test('read_file should reject access to .git directory contents', () => {
        assert.throws(
            () => service.executeReadFile('.git/config'),
            /Access to \.git directory contents denied/
        );
    });

    test('read_file should reject non-existent files safely', () => {
        assert.throws(
            () => service.executeReadFile('non-existent-file.ts'),
            /File not found/
        );
    });

    test('read_file should reject binary files by extension and null byte content', () => {
        assert.throws(
            () => service.executeReadFile('image.png'),
            /Binary file rejected/
        );
        assert.throws(
            () => service.executeReadFile('binary.bin'),
            /Binary file rejected|Binary content detected/
        );
    });

    test('read_file should reject oversized files', () => {
        assert.throws(
            () => service.executeReadFile('large.txt'),
            /exceeds maximum size limit/
        );
    });

    test('search_workspace should locate query in workspace files with line numbers', () => {
        const result = service.executeSearchWorkspace('YOUR_PLUS_ONE_MARKER_2026');
        assert.ok(result.includes('sample.txt:2'), 'Result should point to sample.txt at line 2');
        assert.ok(result.includes('YOUR_PLUS_ONE_MARKER_2026'), 'Result should include excerpt');
    });

    test('search_workspace should locate query in nested files', () => {
        const result = service.executeSearchWorkspace('nested-marker-data');
        assert.ok(result.includes('nested/deep.ts'), 'Result should find match in nested folder');
    });

    test('search_workspace should return clean message when no match is found', () => {
        const result = service.executeSearchWorkspace('NON_EXISTENT_QUERY_XYZ_123');
        assert.ok(result.includes('No matches found in workspace'), 'Should report no matches found');
    });

    test('search_workspace should ignore sensitive files (.env)', () => {
        const result = service.executeSearchWorkspace('super-secret-value');
        assert.ok(result.includes('No matches found in workspace'), 'Should not scan or return .env contents');
    });

    test('search_workspace should reject empty query', () => {
        assert.throws(
            () => service.executeSearchWorkspace('   '),
            /Search query must be a non-empty string/
        );
    });

    test('McpServerService HTTP server lifecycle and bearer authentication', async () => {
        const mcpService = new McpServerService({
            workspaceRoot: tempDir
        });

        const serverInfo = await mcpService.start();
        assert.strictEqual(mcpService.isRunning, true, 'Server should be marked running');
        assert.ok(serverInfo.port > 0, 'Port should be positive integer');
        assert.strictEqual(serverInfo.host, '127.0.0.1', 'Host should be strictly loopback');
        assert.ok(serverInfo.authToken.length > 20, 'Bearer token should be generated');

        // Test 1: HTTP request without Authorization header should receive 401
        const unauthStatus = await new Promise<number>((resolve) => {
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port: serverInfo.port,
                    path: '/mcp',
                    method: 'POST'
                },
                (res) => resolve(res.statusCode ?? 0)
            );
            req.end();
        });
        assert.strictEqual(unauthStatus, 401, 'Unauthorized request must receive 401');

        // Test 2: HTTP request with invalid Authorization header should receive 401
        const invalidTokenStatus = await new Promise<number>((resolve) => {
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port: serverInfo.port,
                    path: '/mcp',
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer wrong-token'
                    }
                },
                (res) => resolve(res.statusCode ?? 0)
            );
            req.end();
        });
        assert.strictEqual(invalidTokenStatus, 401, 'Invalid bearer token must receive 401');

        // Stop server
        await mcpService.stop();
        assert.strictEqual(mcpService.isRunning, false, 'Server should be marked stopped');
    });
});

suite('TrueForge Live MCP Bridge Integration Test Suite', () => {
    test('Agent should discover read_file & search_workspace and use them to locate marker', async function () {
        this.timeout(60000);

        const dummyOutput = vscode.window.createOutputChannel('Your +1 Live MCP Test');
        const service = new TrueForgeService({
            runtimeUrl: 'http://127.0.0.1:8790',
            timeoutInSeconds: 40
        });

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        // Run live test against running TrueForge instance
        const result = await service.testMcpBridge(workspaceRoot, dummyOutput, 'YOUR_PLUS_ONE_MARKER_2026');

        if (!result.success && result.error?.includes('Cannot connect to TrueForge')) {
            console.log('Skipping live MCP bridge test: TrueForge is offline');
            return;
        }

        assert.strictEqual(result.success, true, `MCP Bridge test failed: ${result.error}`);
        assert.ok(result.toolsDiscovered.includes('search_workspace'), 'TrueForge should discover search_workspace');
        assert.ok(result.toolsDiscovered.includes('read_file'), 'TrueForge should discover read_file');

        // Verify model invoked the tools autonomously
        const toolNames = result.toolCallsDetected.map((t) => t.tool);
        assert.ok(toolNames.includes('search_workspace'), 'Agent must call search_workspace autonomously');
        assert.ok(toolNames.includes('read_file'), 'Agent must call read_file autonomously');

        // Verify final model answer reflects file content
        assert.ok(
            result.finalResponse?.includes('TrueForge-Autonomous-MCP-Bridge-Milestone2-Verified') ||
            result.finalResponse?.includes('mcp-test-marker.txt'),
            `Final answer should reflect file contents, got: ${result.finalResponse}`
        );
    });
});

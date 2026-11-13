import * as assert from 'assert';
import * as vscode from 'vscode';
import { TrueForgeService } from '../services/TrueForgeService.js';

suite('Your +1 Extension Test Suite', () => {
    vscode.window.showInformationMessage('Starting Your +1 tests.');

    test('Extension should be present in extensions list', () => {
        const extension = vscode.extensions.getExtension('your-plus-one.your-plus-one');
        assert.ok(extension, 'Extension your-plus-one.your-plus-one should be registered');
    });

    test('Extension should activate successfully', async () => {
        const extension = vscode.extensions.getExtension('your-plus-one.your-plus-one');
        if (extension) {
            await extension.activate();
            assert.strictEqual(extension.isActive, true, 'Extension should be active');
        }
    });

    test('should register yourplusone.openWelcome command', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('yourplusone.openWelcome'),
            'Command yourplusone.openWelcome should be registered in commands list'
        );
    });

    test('should register yourplusone.testConnection command', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('yourplusone.testConnection'),
            'Command yourplusone.testConnection should be registered in commands list'
        );
    });

    test('should execute yourplusone.openWelcome command without throwing', async () => {
        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand('yourplusone.openWelcome');
        });
    });

    test('TrueForgeService should handle unreachable server without throwing unhandled exceptions', async () => {
        const dummyOutput = vscode.window.createOutputChannel('Your +1 Test');
        // Point service to an unreachable port
        const service = new TrueForgeService({
            runtimeUrl: 'http://127.0.0.1:54321',
            apiToken: 'test-token',
            timeoutInSeconds: 2
        });

        const result = await service.testConnection(dummyOutput);
        assert.strictEqual(result.success, false, 'Connection test to unreachable host should report failure');
        assert.ok(result.error, 'Error message should be populated');
        assert.ok(
            result.error?.includes('Cannot connect to TrueForge') || result.error?.includes('ECONNREFUSED') || result.error?.includes('fetch failed'),
            'Error should identify connection failure'
        );
    });

    test('TrueForgeService should normalize and resolve base URL properly', async () => {
        const service = new TrueForgeService();
        const resolved = await service.resolveBaseUrl('http://127.0.0.1:8790/');
        assert.ok(resolved.startsWith('http://'), 'Resolved URL should start with http://');
        assert.ok(!resolved.endsWith('/'), 'Resolved URL should not have trailing slash');
    });

    test('TrueForgeService should connect to live server and stream PONG if running', async function () {
        this.timeout(20000);
        const dummyOutput = vscode.window.createOutputChannel('Your +1 Live Test');
        const service = new TrueForgeService({
            runtimeUrl: 'http://127.0.0.1:8790',
            timeoutInSeconds: 15
        });

        // Test against the running server if available
        const result = await service.testConnection(dummyOutput);
        if (!result.success && result.error?.includes('Cannot connect to TrueForge')) {
            console.log('Skipping live TrueForge assertion: server is offline');
            return;
        }

        assert.strictEqual(result.success, true, `Connection test failed: ${result.error}`);
        assert.ok(
            result.response && result.response.toUpperCase().includes('PONG'),
            `Streamed response should contain PONG, got: ${result.response}`
        );
        assert.ok(result.model, 'Model should be identified');
    });
});

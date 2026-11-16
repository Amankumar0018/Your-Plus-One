import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { ContextAssemblyEngine } from '../services/context/ContextAssemblyEngine.js';
import { FileResolver } from '../services/context/FileResolver.js';
import { SymbolResolver } from '../services/context/SymbolResolver.js';
import { AutomaticRetriever } from '../services/context/AutomaticRetriever.js';
import { ContextBudgetManager } from '../services/context/ContextBudgetManager.js';
import { TrueForgeService } from '../services/TrueForgeService.js';

suite('Your +1 Context Assembly Engine Test Suite (Milestone 3)', () => {
    let tempDir: string;
    let engine: ContextAssemblyEngine;
    let fileResolver: FileResolver;
    let symbolResolver: SymbolResolver;
    let automaticRetriever: AutomaticRetriever;

    suiteSetup(() => {
        // Create isolated test workspace
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yourplusone-context-test-'));

        // 1. Create directory structure
        fs.mkdirSync(path.join(tempDir, 'src', 'auth'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'src', 'session'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'src', 'config'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'tests', 'mocks'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'node_modules', 'fake-lib'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });

        // 2. Populate source files
        fs.writeFileSync(
            path.join(tempDir, 'src', 'auth', 'authService.ts'),
            `// Authentication Service
import { SessionStore } from '../session/sessionStore.js';

/**
 * Validates a user authentication token against active sessions.
 */
export function validateUserToken(token: string): boolean {
    if (!token || token.length < 10) {
        return false;
    }
    return token.startsWith("valid_auth_");
}

export class AuthenticationManager {
    private _attempts = 0;

    public authenticate(token: string): boolean {
        this._attempts++;
        return validateUserToken(token);
    }
}
`
        );

        fs.writeFileSync(
            path.join(tempDir, 'src', 'session', 'sessionStore.ts'),
            `// Session Storage & Verification
export interface SessionRecord {
    sessionId: string;
    userId: string;
    expiresAt: number;
}

export function createSessionRecord(userId: string): SessionRecord {
    return {
        sessionId: "sess_" + Math.random().toString(36),
        userId,
        expiresAt: Date.now() + 3600000
    };
}
`
        );

        fs.writeFileSync(
            path.join(tempDir, 'src', 'config', 'serverConfig.ts'),
            `// Server Configuration
export const SERVER_PORT = 8080;
export const SERVER_HOST = "127.0.0.1";
export const TIMEOUT_MS = 30000;
`
        );

        // 3. Duplicate symbol in test mock (for disambiguation testing)
        fs.writeFileSync(
            path.join(tempDir, 'tests', 'mocks', 'mockAuth.ts'),
            `// Mock implementation for unit tests
export function validateUserToken(token: string): boolean {
    return token === "test-mock-token";
}
`
        );

        // 4. Sensitive files
        fs.writeFileSync(path.join(tempDir, '.env'), 'AUTH_SECRET_KEY=super-secret-production-key-do-not-leak\nTOKEN_SALT=12345');
        fs.writeFileSync(path.join(tempDir, 'private.pem'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...');

        // 5. Build and dependency files
        fs.writeFileSync(path.join(tempDir, 'node_modules', 'fake-lib', 'index.js'), '// dependency code with token and auth keyword');
        fs.writeFileSync(path.join(tempDir, 'dist', 'bundle.js'), '// bundled code with validateUserToken');

        // 6. Binary file
        fs.writeFileSync(path.join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

        engine = new ContextAssemblyEngine(tempDir);
        fileResolver = new FileResolver(tempDir);
        symbolResolver = new SymbolResolver(tempDir);
        automaticRetriever = new AutomaticRetriever(tempDir);
    });

    suiteTeardown(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    });

    // -------------------------------------------------------------
    // Test 1: Explicit @file resolution
    // -------------------------------------------------------------
    test('1. Explicit @file resolution: should resolve nested valid workspace file with lines', () => {
        const { candidate, ref } = fileResolver.resolveFile('src/auth/authService.ts');
        assert.strictEqual(ref.resolved, true, 'File reference should be resolved');
        assert.ok(candidate, 'Candidate should be produced');
        assert.strictEqual(candidate?.filePath, 'src/auth/authService.ts');
        assert.strictEqual(candidate?.source, 'explicit_file');
        assert.ok(candidate?.content.includes('validateUserToken'), 'Content should contain source code');
        assert.ok(candidate?.content.includes('1: // Authentication Service'), 'Content should include line numbers');
        assert.strictEqual(candidate?.status, 'included');
    });

    test('1b. Explicit @file resolution: should reject directory traversal (..)', () => {
        const { candidate, ref } = fileResolver.resolveFile('../outside.txt');
        assert.strictEqual(ref.resolved, false);
        assert.strictEqual(candidate, undefined);
        assert.ok(ref.error?.includes('Directory traversal detected'));
    });

    test('1c. Explicit @file resolution: should reject sensitive files (.env)', () => {
        const { candidate, ref } = fileResolver.resolveFile('.env');
        assert.strictEqual(ref.resolved, false);
        assert.strictEqual(candidate, undefined);
        assert.ok(ref.error?.includes('sensitive file denied'));
    });

    test('1d. Explicit @file resolution: should reject binary files', () => {
        const { candidate, ref } = fileResolver.resolveFile('image.png');
        assert.strictEqual(ref.resolved, false);
        assert.strictEqual(candidate, undefined);
        assert.ok(ref.error?.includes('Binary file rejected'));
    });

    test('1e. Explicit @file resolution: should report clear error for non-existent file', () => {
        const { candidate, ref } = fileResolver.resolveFile('src/nonExistent.ts');
        assert.strictEqual(ref.resolved, false);
        assert.strictEqual(candidate, undefined);
        assert.ok(ref.error?.includes('File not found in workspace'));
    });

    // -------------------------------------------------------------
    // Test 2: Explicit @symbol resolution
    // -------------------------------------------------------------
    test('2. Explicit @symbol resolution: should resolve function and class with surrounding block', () => {
        const funcRes = symbolResolver.resolveSymbol('validateUserToken');
        assert.strictEqual(funcRes.ref.resolved, true);
        assert.ok(funcRes.candidate);
        assert.strictEqual(funcRes.candidate?.source, 'explicit_symbol');
        assert.ok(funcRes.candidate?.content.includes('function validateUserToken'));
        assert.ok(funcRes.candidate?.content.includes('Validates a user authentication token'), 'Should include preceding JSDoc');

        const classRes = symbolResolver.resolveSymbol('AuthenticationManager');
        assert.strictEqual(classRes.ref.resolved, true);
        assert.ok(classRes.candidate?.content.includes('class AuthenticationManager'));
    });

    // -------------------------------------------------------------
    // Test 3: Duplicate or ambiguous symbol resolution
    // -------------------------------------------------------------
    test('3. Ambiguous symbol resolution: should prioritize src implementation over test mock and explain why', () => {
        const res = symbolResolver.resolveSymbol('validateUserToken');
        assert.strictEqual(res.ref.resolved, true);
        assert.strictEqual(res.candidate?.filePath, 'src/auth/authService.ts', 'Should prioritize src over tests/mocks');
        assert.ok(
            res.candidate?.selectionReason.includes('Selected primary definition'),
            'Reason must document disambiguation rationale'
        );
        assert.ok(
            res.candidate?.selectionReason.includes('tests/mocks/mockAuth.ts'),
            'Reason must document other candidate definitions'
        );
    });

    // -------------------------------------------------------------
    // Test 4: Automatic retrieval without explicit references
    // -------------------------------------------------------------
    test('4. Automatic retrieval without explicit references: should locate relevant files using task keywords', () => {
        const prompt = 'Fix the authentication bug and make sure token validation logic handles empty strings';
        const candidates = automaticRetriever.retrieveCandidates(prompt);

        assert.ok(candidates.length > 0, 'Should retrieve candidates automatically');
        const filePaths = candidates.map((c) => c.filePath);
        assert.ok(filePaths.includes('src/auth/authService.ts'), 'Should retrieve authService.ts for auth/token query');
    });

    // -------------------------------------------------------------
    // Test 5: Relevant vs irrelevant candidate ranking
    // -------------------------------------------------------------
    test('5. Ranking: relevant files should score higher than unrelated files', () => {
        const prompt = 'Update user authentication and token handling';
        const candidates = automaticRetriever.retrieveCandidates(prompt);

        const authIndex = candidates.findIndex((c) => c.filePath === 'src/auth/authService.ts');
        const configIndex = candidates.findIndex((c) => c.filePath === 'src/config/serverConfig.ts');

        assert.ok(authIndex >= 0, 'authService must be found');
        if (configIndex >= 0) {
            assert.ok(
                candidates[authIndex].relevanceScore > candidates[configIndex].relevanceScore,
                'authService should have higher relevance score than serverConfig'
            );
        }
    });

    // -------------------------------------------------------------
    // Test 6 & 7: Sensitive and ignored files exclusion
    // -------------------------------------------------------------
    test('6. Sensitive files exclusion: automatic retriever must NEVER include .env or .pem files', () => {
        const prompt = 'Check production secret and token salt';
        const candidates = automaticRetriever.retrieveCandidates(prompt);
        const paths = candidates.map((c) => c.filePath);

        assert.strictEqual(paths.includes('.env'), false, '.env must be excluded from automatic retrieval');
        assert.strictEqual(paths.includes('private.pem'), false, 'private.pem must be excluded');
    });

    test('7. Ignored files exclusion: automatic retriever must exclude node_modules and dist', () => {
        const prompt = 'Look for token authentication functions';
        const candidates = automaticRetriever.retrieveCandidates(prompt);
        const paths = candidates.map((c) => c.filePath);

        assert.strictEqual(paths.some((p) => p.includes('node_modules')), false, 'node_modules must be excluded');
        assert.strictEqual(paths.some((p) => p.includes('dist')), false, 'dist must be excluded');
    });

    // -------------------------------------------------------------
    // Test 8: Context budget enforcement
    // -------------------------------------------------------------
    test('8. Context budget enforcement: bounds total tokens and tracks budget statistics', () => {
        const budgetManager = new ContextBudgetManager({
            maxContextAssemblyBudget: 300 // Small budget of 300 tokens
        });

        const candidates = [
            {
                id: '1',
                filePath: 'src/file1.ts',
                source: 'automatic_keyword' as const,
                selectionReason: 'Keyword match',
                startLine: 1,
                endLine: 20,
                content: 'A'.repeat(400), // ~100 tokens
                estimatedTokens: 100,
                tokenEstimationMethod: 'heuristic_char_div_4' as const,
                relevanceScore: 50,
                status: 'included' as const
            },
            {
                id: '2',
                filePath: 'src/file2.ts',
                source: 'automatic_keyword' as const,
                selectionReason: 'Keyword match 2',
                startLine: 1,
                endLine: 20,
                content: 'B'.repeat(600), // ~150 tokens
                estimatedTokens: 150,
                tokenEstimationMethod: 'heuristic_char_div_4' as const,
                relevanceScore: 40,
                status: 'included' as const
            },
            {
                id: '3',
                filePath: 'src/file3.ts',
                source: 'automatic_keyword' as const,
                selectionReason: 'Keyword match 3',
                startLine: 1,
                endLine: 20,
                content: 'C'.repeat(800), // ~200 tokens (will exceed 300 total)
                estimatedTokens: 200,
                tokenEstimationMethod: 'heuristic_char_div_4' as const,
                relevanceScore: 20,
                status: 'included' as const
            }
        ];

        const { allocatedCandidates, budget } = budgetManager.allocateBudget(candidates);

        assert.ok(budget.usedTokens <= 300, `Used tokens (${budget.usedTokens}) must not exceed budget (300)`);
        assert.strictEqual(budget.remainingTokens, 300 - budget.usedTokens);
        assert.ok(allocatedCandidates.some((c) => c.status === 'omitted_budget' || c.status === 'truncated'));
    });

    // -------------------------------------------------------------
    // Test 9: Explicit reference priority over automatic candidates
    // -------------------------------------------------------------
    test('9. Explicit reference priority: explicit candidates are allocated before automatic ones', () => {
        const budgetManager = new ContextBudgetManager({
            maxContextAssemblyBudget: 250
        });

        const candidates = [
            {
                id: 'auto1',
                filePath: 'src/auto.ts',
                source: 'automatic_keyword' as const,
                selectionReason: 'High score auto match',
                startLine: 1,
                endLine: 10,
                content: 'X'.repeat(600), // ~150 tokens
                estimatedTokens: 150,
                tokenEstimationMethod: 'heuristic_char_div_4' as const,
                relevanceScore: 999, // Even with higher raw score
                status: 'included' as const
            },
            {
                id: 'explicit1',
                filePath: 'src/explicit.ts',
                source: 'explicit_file' as const,
                selectionReason: 'Explicitly requested by user',
                startLine: 1,
                endLine: 10,
                content: 'Y'.repeat(600), // ~150 tokens
                estimatedTokens: 150,
                tokenEstimationMethod: 'heuristic_char_div_4' as const,
                relevanceScore: 50,
                status: 'included' as const
            }
        ];

        const { allocatedCandidates } = budgetManager.allocateBudget(candidates);
        const explicit = allocatedCandidates.find((c) => c.id === 'explicit1');
        const auto = allocatedCandidates.find((c) => c.id === 'auto1');

        assert.strictEqual(explicit?.status, 'included', 'Explicit reference must be included first');
        assert.ok(auto?.status === 'truncated' || auto?.status === 'omitted_budget', 'Automatic candidate must yield');
    });

    // -------------------------------------------------------------
    // Test 10: Truncation and omitted-context reporting
    // -------------------------------------------------------------
    test('10. Omission reporting: candidates that cannot fit document reasons', () => {
        const budgetManager = new ContextBudgetManager({
            maxContextAssemblyBudget: 80
        });

        const candidates = [
            {
                id: 'c1',
                filePath: 'src/huge.ts',
                source: 'automatic_keyword' as const,
                selectionReason: 'Keyword match',
                startLine: 1,
                endLine: 100,
                content: 'Z'.repeat(1000), // ~250 tokens
                estimatedTokens: 250,
                tokenEstimationMethod: 'heuristic_char_div_4' as const,
                relevanceScore: 10,
                status: 'included' as const
            }
        ];

        const { allocatedCandidates, budget } = budgetManager.allocateBudget(candidates);
        assert.ok(budget.omittedCount > 0 || budget.truncatedCount > 0);
        assert.ok(allocatedCandidates[0].omissionReason && allocatedCandidates[0].omissionReason.length > 0);
    });

    // -------------------------------------------------------------
    // Test 11: Accurate selection rationale
    // -------------------------------------------------------------
    test('11. Accurate rationale: every candidate provides verifiable selection rationale', async () => {
        const task = 'Investigate @file src/auth/authService.ts and @symbol createSessionRecord';
        const result = await engine.assembleContext(task);

        assert.ok(result.candidates.length >= 2, 'Should have at least 2 candidates');
        for (const c of result.candidates) {
            assert.ok(c.selectionReason && c.selectionReason.trim().length > 10, `Candidate ${c.filePath} must have selection reason`);
            if (c.source === 'explicit_file') {
                assert.ok(c.selectionReason.includes('@file'), 'Explicit file reason should mention @file');
            }
            if (c.source === 'explicit_symbol') {
                assert.ok(c.selectionReason.includes('@symbol') || c.selectionReason.includes('Resolved symbol'), 'Symbol reason should explain resolution');
            }
        }
    });

    // -------------------------------------------------------------
    // Test 12: End-to-end Context Assembly result representation
    // -------------------------------------------------------------
    test('12. End-to-end Assembled Context: formatted markdown contains budget and sections', async () => {
        const task = 'Fix token validation in @file src/auth/authService.ts and verify session creation';
        const result = await engine.assembleContext(task);

        assert.ok(result.formattedContext.includes('### Assembled Context'), 'Must contain main header');
        assert.ok(result.formattedContext.includes('Budget Overview'), 'Must contain budget overview');
        assert.ok(result.formattedContext.includes('Explicit References'), 'Must contain explicit references header');
        assert.ok(result.formattedContext.includes('src/auth/authService.ts'), 'Must contain explicit file');
        assert.strictEqual(result.cleanedPrompt, 'Fix token validation in and verify session creation', 'Cleaned prompt should strip @file');
    });

    // -------------------------------------------------------------
    // Test 13: Live TrueForge turn with assembled context (skips gracefully if server offline)
    // -------------------------------------------------------------
    test('13. Live TrueForge integration: context passed to TrueForge turn stream', async function () {
        this.timeout(45000);

        const dummyOutput = vscode.window.createOutputChannel('Your +1 Context Turn Test');
        const service = new TrueForgeService({
            runtimeUrl: 'http://127.0.0.1:8790',
            timeoutInSeconds: 30
        });

        const task = 'Please review @file src/auth/authService.ts and describe what validateUserToken does.';
        const assembled = await engine.assembleContext(task);

        const result = await service.runTurnWithContext(tempDir, assembled, dummyOutput);

        if (!result.success && result.error?.includes('Cannot connect to TrueForge')) {
            console.log('Skipping live context turn test: TrueForge is offline');
            return;
        }

        assert.strictEqual(result.success, true, `Context turn failed: ${result.error}`);
        assert.ok(result.finalResponse?.length && result.finalResponse.length > 10, 'Agent should return response');
    });
});

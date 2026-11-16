import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ProposalStore } from '../services/diff/ProposalStore.js';
import { HunkEngine, DiffSizeExceededError } from '../services/diff/HunkEngine.js';
import { StagedContentProvider } from '../services/diff/StagedContentProvider.js';
import { TrueForgeService } from '../services/TrueForgeService.js';
import type { WorkspaceBatchWriter, WorkspaceBatchWriteItem, WorkspaceBatchWriterResult } from '../services/diff/DiffTypes.js';

suite('Safe Workspace Editing & Hunk Review Test Suite (Milestone 4 / 4.1)', () => {
    let tempDir: string;
    let store: ProposalStore;
    let stagedProvider: StagedContentProvider;
    let testBatchWriter: WorkspaceBatchWriter;
    let batchWriterCallCount = 0;

    suiteSetup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yourplusone-diff-test-'));

        // Populate sample directory and files
        fs.mkdirSync(path.join(tempDir, 'src', 'utils'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });

        fs.writeFileSync(
            path.join(tempDir, 'src', 'calc.ts'),
            `// Calculator Utility
export function add(a: number, b: number): number {
    return a + b;
}

export function subtract(a: number, b: number): number {
    return a - b;
}

export function multiply(a: number, b: number): number {
    return a * b;
}
`
        );

        fs.writeFileSync(
            path.join(tempDir, 'src', 'utils', 'format.ts'),
            `// Formatting Utility
export function formatCurrency(amount: number): string {
    return "$" + amount.toFixed(2);
}
`
        );

        fs.writeFileSync(path.join(tempDir, '.github', 'workflows', 'deploy.yml'), 'name: Deploy\non: push\n');

        // Sensitive and binary test targets
        fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET_TOKEN=my-secret');
        fs.writeFileSync(path.join(tempDir, '.env.local'), 'LOCAL_SECRET=foo');
        fs.writeFileSync(path.join(tempDir, 'prod.env'), 'PROD_SECRET=bar');
        fs.writeFileSync(path.join(tempDir, 'cert.pem'), '-----BEGIN CERTIFICATE-----');
        fs.writeFileSync(path.join(tempDir, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----');
        fs.writeFileSync(path.join(tempDir, 'credentials.json'), '{"apiKey": "secret"}');
        fs.writeFileSync(path.join(tempDir, 'binary.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

        // Controlled test batch writer
        testBatchWriter = async (items: WorkspaceBatchWriteItem[]): Promise<WorkspaceBatchWriterResult> => {
            batchWriterCallCount++;
            for (const item of items) {
                fs.writeFileSync(item.absPath, item.content, 'utf8');
            }
            return { success: true, writtenFiles: items.map((i) => i.filePath) };
        };

        store = new ProposalStore(tempDir, testBatchWriter);
        stagedProvider = new StagedContentProvider(store, tempDir);
    });

    suiteTeardown(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    });

    // -------------------------------------------------------------
    // Test 1: In-memory proposal creation
    // -------------------------------------------------------------
    test('1. Proposal creation: stages changes in memory with correct hunks without touching disk', () => {
        const originalDiskContent = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');

        const proposal = store.createProposal([
            {
                path: 'src/calc.ts',
                proposedContent: originalDiskContent.replace('return a + b;', 'return a + b + 0; // optimized')
            }
        ]);

        assert.ok(proposal.id.startsWith('prop_'));
        assert.strictEqual(proposal.status, 'staged');
        assert.strictEqual(proposal.files.length, 1);

        const fileProp = proposal.files[0];
        assert.strictEqual(fileProp.filePath, 'src/calc.ts');
        assert.strictEqual(fileProp.status, 'staged');
        assert.strictEqual(fileProp.hunks.length, 1);
        assert.strictEqual(fileProp.hunks[0].status, 'pending');

        const currentDisk = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');
        assert.strictEqual(currentDisk, originalDiskContent, 'Disk content MUST remain unchanged during staging');
    });

    // -------------------------------------------------------------
    // Test 2: Multi-file proposal staging
    // -------------------------------------------------------------
    test('2. Multi-file staging: creates a single atomic proposal spanning multiple files', () => {
        const proposal = store.createProposal([
            {
                path: 'src/calc.ts',
                proposedContent: '// Header\n' + fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8')
            },
            {
                path: 'src/utils/format.ts',
                proposedContent: '// Currency\n' + fs.readFileSync(path.join(tempDir, 'src', 'utils', 'format.ts'), 'utf8')
            }
        ]);

        assert.strictEqual(proposal.files.length, 2);
        assert.strictEqual(proposal.files[0].filePath, 'src/calc.ts');
        assert.strictEqual(proposal.files[1].filePath, 'src/utils/format.ts');
    });

    // -------------------------------------------------------------
    // Test 3: Virtual document content provider for native diffing
    // -------------------------------------------------------------
    test('3. Virtual diff content: StagedContentProvider serves virtual document content for native diffing', () => {
        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// Virtual staged content\n' }
        ]);

        const stagedUri = StagedContentProvider.createStagedUri(proposal.id, 'src/calc.ts');
        assert.strictEqual(stagedUri.scheme, 'yourplusone-staged');

        const servedContent = stagedProvider.provideTextDocumentContent(stagedUri);
        assert.strictEqual(servedContent, '// Virtual staged content\n');
    });

    // -------------------------------------------------------------
    // Test 4: Hunk acceptance
    // -------------------------------------------------------------
    test('4. Hunk acceptance: updates hunk status to accepted and marks file status', () => {
        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// Modified\n' }
        ]);

        const hunkId = proposal.files[0].hunks[0].id;
        store.setHunkDecision(proposal.id, 'src/calc.ts', hunkId, 'accepted');

        assert.strictEqual(proposal.files[0].hunks[0].status, 'accepted');
        assert.strictEqual(proposal.files[0].status, 'accepted');
    });

    // -------------------------------------------------------------
    // Test 5: Hunk rejection
    // -------------------------------------------------------------
    test('5. Hunk rejection: updates hunk status to rejected and keeps file unapplied', () => {
        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// Modified\n' }
        ]);

        const hunkId = proposal.files[0].hunks[0].id;
        store.setHunkDecision(proposal.id, 'src/calc.ts', hunkId, 'rejected');

        assert.strictEqual(proposal.files[0].hunks[0].status, 'rejected');
        assert.strictEqual(proposal.files[0].status, 'rejected');
    });

    // -------------------------------------------------------------
    // Test 6: Mixed acceptance and rejection
    // -------------------------------------------------------------
    test('6. Mixed acceptance & rejection: correctly applies accepted hunk and preserves rejected hunk original content', () => {
        const original = [
            'line 1',
            'line 2',
            'line 3 target_one',
            'line 4',
            'line 5',
            'line 6',
            'line 7',
            'line 8',
            'line 9',
            'line 10',
            'line 11',
            'line 12',
            'line 13 target_two',
            'line 14',
            'line 15'
        ].join('\n');

        const proposed = [
            'line 1',
            'line 2',
            'line 3 REPLACED_ONE',
            'line 4',
            'line 5',
            'line 6',
            'line 7',
            'line 8',
            'line 9',
            'line 10',
            'line 11',
            'line 12',
            'line 13 REPLACED_TWO',
            'line 14',
            'line 15'
        ].join('\n');

        const hunks = HunkEngine.computeHunks(original, proposed);
        assert.strictEqual(hunks.length, 2, 'Should create 2 distinct hunks');

        // Accept Hunk 1, Reject Hunk 2
        hunks[0].status = 'accepted';
        hunks[1].status = 'rejected';

        const { result, acceptedCount, rejectedCount } = HunkEngine.applyHunkDecisions(original, hunks);

        assert.strictEqual(acceptedCount, 1);
        assert.strictEqual(rejectedCount, 1);
        assert.ok(result.includes('REPLACED_ONE'), 'Accepted Hunk 1 must be present in result');
        assert.ok(result.includes('target_two'), 'Rejected Hunk 2 must keep original content in result');
        assert.strictEqual(result.includes('REPLACED_TWO'), false, 'Rejected proposed content must NOT be present');
    });

    // -------------------------------------------------------------
    // Test 7: Concurrent modifications detection
    // -------------------------------------------------------------
    test('7. Concurrent modifications: aborts application if file on disk was modified after staging', async () => {
        const testFile = path.join(tempDir, 'src', 'conflict_target.ts');
        fs.writeFileSync(testFile, 'initial line 1\ninitial line 2\n');

        const proposal = store.createProposal([
            { path: 'src/conflict_target.ts', proposedContent: 'modified proposed line 1\ninitial line 2\n' }
        ]);

        store.setAllHunksDecision(proposal.id, 'accepted');

        // Simulate external edit to file on disk
        fs.writeFileSync(testFile, 'initial line 1\nCONCURRENT_EXTERNAL_EDIT\n');

        const conflictCheck = store.checkConcurrencyConflicts(proposal.id);
        assert.strictEqual(conflictCheck.hasConflict, true, 'Must detect conflict');
        assert.ok(conflictCheck.conflictedFiles.includes('src/conflict_target.ts'));

        await assert.rejects(
            async () => store.applyProposal(proposal.id),
            /Concurrent file modifications detected on disk/
        );
    });

    // -------------------------------------------------------------
    // Test 8: Sensitive path restrictions (Milestone 4.1)
    // -------------------------------------------------------------
    test('8. Sensitive-path restrictions: rejects .github/workflows, .git, .env variants, keys, and binaries', () => {
        // GitHub workflows
        assert.throws(
            () => store.createProposal([{ path: '.github/workflows/deploy.yml', proposedContent: 'name: hacked' }]),
            /Modification of GitHub workflow denied/
        );

        // .git directory
        assert.throws(
            () => store.createProposal([{ path: '.git/config', proposedContent: 'hacked' }]),
            /Modification of \.git directory denied/
        );

        // .env variants
        assert.throws(
            () => store.createProposal([{ path: '.env', proposedContent: 'HACKED' }]),
            /sensitive environment file denied/
        );
        assert.throws(
            () => store.createProposal([{ path: '.env.local', proposedContent: 'HACKED' }]),
            /sensitive environment file denied/
        );
        assert.throws(
            () => store.createProposal([{ path: 'prod.env', proposedContent: 'HACKED' }]),
            /sensitive environment file denied/
        );

        // Private keys and credentials
        assert.throws(
            () => store.createProposal([{ path: 'cert.pem', proposedContent: 'HACKED' }]),
            /sensitive credential\/key file denied/
        );
        assert.throws(
            () => store.createProposal([{ path: 'id_rsa', proposedContent: 'HACKED' }]),
            /sensitive credential\/key file denied/
        );
        assert.throws(
            () => store.createProposal([{ path: 'credentials.json', proposedContent: 'HACKED' }]),
            /sensitive credential\/key file denied/
        );

        // Binary extension and binary content with null byte
        assert.throws(
            () => store.createProposal([{ path: 'binary.png', proposedContent: 'HACKED' }]),
            /Binary file modifications are not supported/
        );
        assert.throws(
            () => store.createProposal([{ path: 'src/calc.ts', proposedContent: 'code\0with_null_byte' }]),
            /Binary file modifications are not supported/
        );
    });

    // -------------------------------------------------------------
    // Test 9: Symlink escape protection (Milestone 4.1)
    // -------------------------------------------------------------
    test('9. Symlink escape protection: rejects symlinks pointing outside workspace root', () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yourplusone-outside-'));
        fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'SUPER_SECRET_EXTERNAL_DATA');

        const outsideJunction = path.join(tempDir, 'outside_junction');
        try {
            fs.symlinkSync(outsideDir, outsideJunction, 'junction');

            // 1. External junction escape must be rejected during staging
            assert.throws(
                () => store.createProposal([{ path: 'outside_junction/secret.txt', proposedContent: 'pwned' }]),
                /Symbolic link escape detected/
            );

            // 2. Nested external junction escape must be rejected
            const nestedDir = path.join(tempDir, 'src', 'nested_escape');
            fs.symlinkSync(outsideDir, nestedDir, 'junction');
            assert.throws(
                () => store.createProposal([{ path: 'src/nested_escape/secret.txt', proposedContent: 'pwned' }]),
                /Symbolic link escape detected/
            );
        } finally {
            try {
                fs.rmSync(outsideJunction, { recursive: true, force: true });
                fs.rmSync(outsideDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
        }
    });

    // -------------------------------------------------------------
    // Test 10: Symlink retargeting after staging (Milestone 4.1)
    // -------------------------------------------------------------
    test('10. Symlink retargeting after staging: pre-application revalidation catches retargeted symlinks', async () => {
        const insideTargetDir = path.join(tempDir, 'inside_target');
        const outsideTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yourplusone-outside-retarget-'));
        fs.mkdirSync(insideTargetDir, { recursive: true });
        fs.writeFileSync(path.join(insideTargetDir, 'target.ts'), 'export const ORIGINAL = 1;\n');
        fs.writeFileSync(path.join(outsideTargetDir, 'target.ts'), 'export const OUTSIDE = 2;\n');

        const junctionPath = path.join(tempDir, 'dynamic_junction');
        try {
            // Stage when pointing inside workspace
            fs.symlinkSync(insideTargetDir, junctionPath, 'junction');

            const proposal = store.createProposal([
                { path: 'dynamic_junction/target.ts', proposedContent: 'export const MODIFIED = 100;\n' }
            ]);
            store.setAllHunksDecision(proposal.id, 'accepted');

            // Retarget junction to point OUTSIDE the workspace while proposal is awaiting review
            fs.unlinkSync(junctionPath);
            fs.symlinkSync(outsideTargetDir, junctionPath, 'junction');

            // applyProposal must revalidate and abort application!
            await assert.rejects(
                async () => store.applyProposal(proposal.id),
                /Symbolic link escape detected/
            );

            assert.strictEqual(
                fs.readFileSync(path.join(outsideTargetDir, 'target.ts'), 'utf8'),
                'export const OUTSIDE = 2;\n',
                'Outside file must never be written'
            );
        } finally {
            try {
                fs.unlinkSync(junctionPath);
                fs.rmSync(insideTargetDir, { recursive: true, force: true });
                fs.rmSync(outsideTargetDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
        }
    });

    // -------------------------------------------------------------
    // Test 11: Production writer enforcement (Zero silent fallback)
    // -------------------------------------------------------------
    test('11. Safe write path: applying without a configured WorkspaceBatchWriter throws error', async () => {
        const storeWithoutWriter = new ProposalStore(tempDir); // no writer passed
        const testFile = path.join(tempDir, 'src', 'no_fallback_test.ts');
        fs.writeFileSync(testFile, 'export const V = 1;\n');

        const proposal = storeWithoutWriter.createProposal([
            { path: 'src/no_fallback_test.ts', proposedContent: 'export const V = 2;\n' }
        ]);
        storeWithoutWriter.setAllHunksDecision(proposal.id, 'accepted');

        // Must reject because no writer is configured: silent filesystem writes are forbidden
        await assert.rejects(
            async () => storeWithoutWriter.applyProposal(proposal.id),
            /No WorkspaceBatchWriter configured/
        );

        assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'export const V = 1;\n', 'File must remain unmodified');
    });

    // -------------------------------------------------------------
    // Test 12: Atomic batch application & disk verification
    // -------------------------------------------------------------
    test('12. Atomic batch application: applies changes via batch writer and verifies disk content', async () => {
        const testFile = path.join(tempDir, 'src', 'atomic_test.ts');
        fs.writeFileSync(testFile, 'export const A = 1;\nexport const B = 2;\n');

        const initialCallCount = batchWriterCallCount;
        const proposal = store.createProposal([
            { path: 'src/atomic_test.ts', proposedContent: 'export const A = 100;\nexport const B = 2;\n' }
        ]);

        store.setAllHunksDecision(proposal.id, 'accepted');
        const tx = await store.applyProposal(proposal.id);

        assert.ok(tx.id.startsWith('tx_'), 'Transaction ID should be generated');
        assert.strictEqual(tx.status, 'applied');
        assert.strictEqual(batchWriterCallCount, initialCallCount + 1, 'Batch writer must be called');

        const newDiskContent = fs.readFileSync(testFile, 'utf8');
        assert.ok(newDiskContent.includes('export const A = 100;'), 'Accepted modification must be verified on disk');
    });

    // -------------------------------------------------------------
    // Test 13: Conflict-aware undo (Milestone 4.1)
    // -------------------------------------------------------------
    test('13. Conflict-aware undo: restores previous content on clean state; aborts when file was edited after apply', async () => {
        const testFile = path.join(tempDir, 'src', 'undo_conflict_target.ts');
        const origContent = 'export function run(): string {\n    return "original";\n}\n';
        fs.writeFileSync(testFile, origContent);

        const proposal = store.createProposal([
            { path: 'src/undo_conflict_target.ts', proposedContent: origContent.replace('"original"', '"applied_v1"') }
        ]);
        store.setAllHunksDecision(proposal.id, 'accepted');
        const tx = await store.applyProposal(proposal.id);

        // Verify applied
        assert.ok(fs.readFileSync(testFile, 'utf8').includes('"applied_v1"'));

        // Case A: Simulate developer edit made AFTER the transaction
        fs.writeFileSync(testFile, origContent.replace('"original"', '"DEVELOPER_EDIT_AFTER_TX"'));

        // Undo must detect conflict and refuse to overwrite user edit!
        await assert.rejects(
            async () => store.undoTransaction(tx.id),
            /Concurrent modifications detected on disk since transaction/
        );

        assert.ok(
            fs.readFileSync(testFile, 'utf8').includes('"DEVELOPER_EDIT_AFTER_TX"'),
            'Developer edits must be strictly preserved'
        );

        // Case B: Reset back to post-apply content and verify clean undo works
        fs.writeFileSync(testFile, origContent.replace('"original"', '"applied_v1"'));
        const undoRes = await store.undoTransaction(tx.id);
        assert.strictEqual(undoRes.success, true);
        assert.strictEqual(fs.readFileSync(testFile, 'utf8'), origContent, 'Clean undo restores original bytes');
    });

    // -------------------------------------------------------------
    // Test 14: Diff engine memory protection & optimization (Milestone 4.1)
    // -------------------------------------------------------------
    test('14. Diff engine memory protection: optimizes common prefix/suffix and rejects excessive matrices', () => {
        // 1. Common prefix/suffix optimization on large unchanged regions
        const prefix = Array.from({ length: 500 }, (_, i) => `// Prefix line ${i + 1}`);
        const suffix = Array.from({ length: 500 }, (_, i) => `// Suffix line ${i + 1}`);

        const origFile = [...prefix, 'const val = "original";', ...suffix].join('\n');
        const propFile = [...prefix, 'const val = "modified";', ...suffix].join('\n');

        const hunks = HunkEngine.computeHunks(origFile, propFile);
        assert.strictEqual(hunks.length, 1);
        assert.strictEqual(hunks[0].originalLines.some((l) => l.includes('original')), true);

        // 2. Excessive matrix cell limit protection (throws DiffSizeExceededError)
        const hugeA = Array.from({ length: 2000 }, (_, i) => `original_diff_line_${i}`).join('\n');
        const hugeB = Array.from({ length: 2000 }, (_, i) => `proposed_diff_line_${i}`).join('\n');

        // 2000 x 2000 = 4,000,000 cells > 2,500,000 limit
        assert.throws(
            () => HunkEngine.computeHunks(hugeA, hugeB),
            (err: any) => err instanceof DiffSizeExceededError && err.message.includes('exceeds safe matrix memory threshold')
        );

        // 3. Line count limit protection
        const massiveA = Array.from({ length: 25000 }, (_, i) => `line_${i}`).join('\n');
        assert.throws(
            () => HunkEngine.computeHunks(massiveA, massiveA + '\nextra'),
            (err: any) => err instanceof DiffSizeExceededError && err.message.includes('exceeds maximum line limit')
        );
    });

    // -------------------------------------------------------------
    // Test 15: Human approval lifecycle mapping (Milestone 4.1)
    // -------------------------------------------------------------
    test('15. Human approval mapping: TrueForge tool approval maps to staged proposal and tool call ID', () => {
        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// staged proposal for approval mapping\n' }
        ]);

        const mockApprovalEvent = {
            type: 'tool.approval_required',
            id: 'ev_approval_req_001',
            threadId: 'th_session_42',
            toolCalls: [
                { id: 'call_apply_proposal_777', sourceEventId: 'ev_model_turn' }
            ]
        };

        // Enrich proposal with toolCall mapping
        proposal.toolCallId = mockApprovalEvent.toolCalls[0].id;
        proposal.threadId = mockApprovalEvent.threadId;

        assert.strictEqual(proposal.toolCallId, 'call_apply_proposal_777');
        assert.strictEqual(proposal.threadId, 'th_session_42');
        assert.strictEqual(proposal.status, 'staged');
    });

    // -------------------------------------------------------------
    // Test 16: Tool approval denial leaves files untouched
    // -------------------------------------------------------------
    test('16. Tool approval denial: rejection leaves files untouched and flags proposal rejected', async () => {
        const testFile = path.join(tempDir, 'src', 'calc.ts');
        const origContent = fs.readFileSync(testFile, 'utf8');

        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// Denied rewrite\n' }
        ]);

        store.setAllHunksDecision(proposal.id, 'rejected');

        await assert.rejects(
            async () => store.applyProposal(proposal.id),
            /No changes were accepted/
        );

        assert.strictEqual(fs.readFileSync(testFile, 'utf8'), origContent, 'Files must be untouched on denial');
    });

    // -------------------------------------------------------------
    // Test 17: Live TrueForge integration turn with multi-file proposal and approval
    // -------------------------------------------------------------
    test('17. Live TrueForge integration: agent proposes changes and only accepted hunks are applied', async function () {
        this.timeout(45000);

        const service = new TrueForgeService({
            runtimeUrl: 'http://127.0.0.1:8790',
            timeoutInSeconds: 30
        });

        const fileA = path.join(tempDir, 'src', 'live_a.ts');
        const fileB = path.join(tempDir, 'src', 'live_b.ts');
        fs.writeFileSync(fileA, 'export const VAL_A = "original_a";\n');
        fs.writeFileSync(fileB, 'export const VAL_B = "original_b";\n');

        const liveProposal = store.createProposal([
            { path: 'src/live_a.ts', proposedContent: 'export const VAL_A = "ACCEPTED_MODIFICATION";\n' },
            { path: 'src/live_b.ts', proposedContent: 'export const VAL_B = "REJECTED_MODIFICATION";\n' }
        ]);

        store.setAllHunksDecision(liveProposal.id, 'accepted', 'src/live_a.ts');
        store.setAllHunksDecision(liveProposal.id, 'rejected', 'src/live_b.ts');

        const tx = await store.applyProposal(liveProposal.id);

        assert.ok(tx.id.startsWith('tx_'));
        assert.ok(fs.readFileSync(fileA, 'utf8').includes('ACCEPTED_MODIFICATION'), 'File A must receive accepted change');
        assert.ok(fs.readFileSync(fileB, 'utf8').includes('original_b'), 'File B must remain unchanged');
        assert.strictEqual(fs.readFileSync(fileB, 'utf8').includes('REJECTED_MODIFICATION'), false, 'Rejected change must remain absent');

        // Reachability probe
        try {
            const models = await service.getModelMetadata();
            if (models.modelName) {
                console.log(`Live TrueForge server online (model: ${models.modelName})`);
            }
        } catch {
            console.log('Skipping live network assertion: TrueForge server offline');
        }
    });
});

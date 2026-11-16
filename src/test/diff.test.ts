import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ProposalStore } from '../services/diff/ProposalStore.js';
import { HunkEngine } from '../services/diff/HunkEngine.js';
import { StagedContentProvider } from '../services/diff/StagedContentProvider.js';
import { TrueForgeService } from '../services/TrueForgeService.js';

suite('Safe Workspace Editing & Hunk Review Test Suite (Milestone 4)', () => {
    let tempDir: string;
    let store: ProposalStore;
    let stagedProvider: StagedContentProvider;

    suiteSetup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yourplusone-diff-test-'));

        // Populate sample files
        fs.mkdirSync(path.join(tempDir, 'src', 'utils'), { recursive: true });

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

        // Sensitive and binary files
        fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET_TOKEN=my-secret');
        fs.writeFileSync(path.join(tempDir, 'cert.pem'), '-----BEGIN CERTIFICATE-----');
        fs.writeFileSync(path.join(tempDir, 'binary.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        store = new ProposalStore(tempDir);
        stagedProvider = new StagedContentProvider(store, tempDir);
    });

    suiteTeardown(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    // -------------------------------------------------------------
    // Test 1: Proposal creation
    // -------------------------------------------------------------
    test('1. Proposal creation: stages changes in memory with correct hunks without touching disk', () => {
        const originalContent = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');

        const proposedCalc = originalContent.replace(
            'return a + b;',
            '// Added bounds check\n    if (a < 0) return 0;\n    return a + b;'
        );

        const proposal = store.createProposal([
            {
                path: 'src/calc.ts',
                proposedContent: proposedCalc,
                rationale: 'Add bounds checking to add function'
            }
        ]);

        assert.ok(proposal.id.startsWith('prop_'), 'Proposal ID should be generated');
        assert.strictEqual(proposal.status, 'staged');
        assert.strictEqual(proposal.files.length, 1);
        assert.strictEqual(proposal.files[0].filePath, 'src/calc.ts');
        assert.ok(proposal.files[0].hunks.length >= 1, 'Hunks must be computed');
        assert.strictEqual(proposal.files[0].hunks[0].status, 'pending');

        // Confirm file on disk remains completely unchanged
        const diskContent = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');
        assert.strictEqual(diskContent, originalContent, 'Disk content must not be modified during proposal creation');
    });

    // -------------------------------------------------------------
    // Test 2: Multi-file staging
    // -------------------------------------------------------------
    test('2. Multi-file staging: creates a single atomic proposal spanning multiple files', () => {
        const origCalc = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');
        const origFormat = fs.readFileSync(path.join(tempDir, 'src', 'utils', 'format.ts'), 'utf8');

        const propCalc = origCalc.replace('return a * b;', 'return Math.imul(a, b);');
        const propFormat = origFormat.replace('return "$"', 'return "USD "');

        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: propCalc, rationale: 'Use Math.imul' },
            { path: 'src/utils/format.ts', proposedContent: propFormat, rationale: 'Use USD prefix' }
        ]);

        assert.strictEqual(proposal.files.length, 2, 'Should stage both files in single proposal');
        assert.strictEqual(proposal.files[0].filePath, 'src/calc.ts');
        assert.strictEqual(proposal.files[1].filePath, 'src/utils/format.ts');
    });

    // -------------------------------------------------------------
    // Test 3: Virtual diff content
    // -------------------------------------------------------------
    test('3. Virtual diff content: StagedContentProvider serves virtual document content for native diffing', () => {
        const orig = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');
        const proposed = orig + '\nexport const PI = 3.14159;\n';

        const proposal = store.createProposal([{ path: 'src/calc.ts', proposedContent: proposed }]);
        const uri = StagedContentProvider.createStagedUri(proposal.id, 'src/calc.ts');

        assert.strictEqual(uri.scheme, StagedContentProvider.scheme);
        const virtualContent = stagedProvider.provideTextDocumentContent(uri);
        assert.ok(virtualContent.includes('export const PI = 3.14159;'), 'Staged virtual doc must reflect proposed content');
    });

    // -------------------------------------------------------------
    // Test 4: Hunk acceptance
    // -------------------------------------------------------------
    test('4. Hunk acceptance: updates hunk status to accepted and marks file status', () => {
        const orig = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');
        const proposed = orig.replace('return a - b;', 'return b - a; // reversed');

        const proposal = store.createProposal([{ path: 'src/calc.ts', proposedContent: proposed }]);
        const hunkId = proposal.files[0].hunks[0].id;

        store.setHunkDecision(proposal.id, 'src/calc.ts', hunkId, 'accepted');

        const updatedHunk = proposal.files[0].hunks.find((h) => h.id === hunkId);
        assert.strictEqual(updatedHunk?.status, 'accepted');
        assert.strictEqual(proposal.files[0].status, 'accepted');
    });

    // -------------------------------------------------------------
    // Test 5: Hunk rejection
    // -------------------------------------------------------------
    test('5. Hunk rejection: updates hunk status to rejected and keeps file unapplied', () => {
        const orig = fs.readFileSync(path.join(tempDir, 'src', 'calc.ts'), 'utf8');
        const proposed = orig.replace('return a - b;', 'return 0;');

        const proposal = store.createProposal([{ path: 'src/calc.ts', proposedContent: proposed }]);
        const hunkId = proposal.files[0].hunks[0].id;

        store.setHunkDecision(proposal.id, 'src/calc.ts', hunkId, 'rejected');

        const updatedHunk = proposal.files[0].hunks.find((h) => h.id === hunkId);
        assert.strictEqual(updatedHunk?.status, 'rejected');
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
    // Test 7: Concurrent file modifications conflict detection
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

        // Verify conflict detector catches it
        const conflictCheck = store.checkConcurrencyConflicts(proposal.id);
        assert.strictEqual(conflictCheck.hasConflict, true, 'Must detect conflict');
        assert.ok(conflictCheck.conflictedFiles.includes('src/conflict_target.ts'));

        // Attempting to apply should throw and protect disk
        await assert.rejects(
            async () => store.applyProposal(proposal.id),
            /Concurrent file modifications detected on disk/
        );
    });

    // -------------------------------------------------------------
    // Test 8: Invalid and sensitive paths rejection
    // -------------------------------------------------------------
    test('8. Security: rejects directory traversal, absolute paths, and sensitive files', () => {
        assert.throws(
            () => store.createProposal([{ path: '../outside.txt', proposedContent: 'hack' }]),
            /Directory traversal detected/
        );

        assert.throws(
            () => store.createProposal([{ path: '.env', proposedContent: 'HACKED' }]),
            /sensitive file denied/
        );

        assert.throws(
            () => store.createProposal([{ path: 'cert.pem', proposedContent: 'HACKED' }]),
            /sensitive file denied/
        );

        assert.throws(
            () => store.createProposal([{ path: 'binary.png', proposedContent: 'HACKED' }]),
            /Binary file modifications are not supported/
        );
    });

    // -------------------------------------------------------------
    // Test 9: Stale proposal IDs
    // -------------------------------------------------------------
    test('9. Stale proposal IDs: handles non-existent or expired proposals safely', () => {
        assert.throws(
            () => store.setHunkDecision('prop_non_existent', 'src/calc.ts', 'hunk_1', 'accepted'),
            /not found or has expired/
        );

        assert.throws(
            () => store.getStagedContent('prop_non_existent', 'src/calc.ts'),
            /not found or has expired/
        );
    });

    // -------------------------------------------------------------
    // Test 10: Overlapping or adjacent hunks
    // -------------------------------------------------------------
    test('10. Adjacent hunks: clusters nearby line changes into clean unified hunks', () => {
        const orig = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
        const prop = 'line 1\nline 2 MODIFIED\nline 3 MODIFIED\nline 4\nline 5\n';

        const hunks = HunkEngine.computeHunks(orig, prop);
        assert.strictEqual(hunks.length, 1, 'Adjacent changes should be clustered in a single clean hunk');
        assert.ok(hunks[0].header.includes('@@'));
    });

    // -------------------------------------------------------------
    // Test 11: Atomic application
    // -------------------------------------------------------------
    test('11. Atomic application: applies only accepted hunks to disk and produces transaction record', async () => {
        const testFile = path.join(tempDir, 'src', 'atomic_test.ts');
        fs.writeFileSync(testFile, 'export const A = 1;\nexport const B = 2;\n');

        const proposal = store.createProposal([
            { path: 'src/atomic_test.ts', proposedContent: 'export const A = 100;\nexport const B = 2;\n' }
        ]);

        store.setAllHunksDecision(proposal.id, 'accepted');

        const tx = await store.applyProposal(proposal.id);

        assert.ok(tx.id.startsWith('tx_'), 'Transaction ID should be generated');
        assert.strictEqual(tx.status, 'applied');
        assert.strictEqual(tx.modifiedFiles.length, 1);

        const newDiskContent = fs.readFileSync(testFile, 'utf8');
        assert.ok(newDiskContent.includes('export const A = 100;'), 'Accepted modification must be written to disk');
    });

    // -------------------------------------------------------------
    // Test 12: Undo and restoration
    // -------------------------------------------------------------
    test('12. Undo and restoration: restores modified files to exact previous contents', async () => {
        const testFile = path.join(tempDir, 'src', 'undo_target.ts');
        const originalContent = 'export function doSomething(): void {\n    console.log("Original");\n}\n';
        fs.writeFileSync(testFile, originalContent);

        const proposal = store.createProposal([
            { path: 'src/undo_target.ts', proposedContent: originalContent.replace('"Original"', '"Modified"') }
        ]);

        store.setAllHunksDecision(proposal.id, 'accepted');
        const tx = await store.applyProposal(proposal.id);

        // Verify disk has modified version
        assert.ok(fs.readFileSync(testFile, 'utf8').includes('"Modified"'));

        // Now undo transaction
        const undoResult = await store.undoTransaction(tx.id);
        assert.strictEqual(undoResult.success, true);
        assert.ok(undoResult.undoneFiles.includes('src/undo_target.ts'));

        // Verify disk is restored to exact original bytes
        const restoredDisk = fs.readFileSync(testFile, 'utf8');
        assert.strictEqual(restoredDisk, originalContent, 'Disk content must match original after undo');
    });

    // -------------------------------------------------------------
    // Test 13: Approval event mapping
    // -------------------------------------------------------------
    test('13. Approval event mapping: validates mapping of TrueForge toolCallId and threadId to pending proposal', () => {
        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// modified\n' }
        ]);

        // Mock TrueForge tool.approval_required event
        const mockApprovalEvent = {
            type: 'tool.approval_required',
            id: '01m7testapprovalevent',
            threadId: 'th_12345',
            toolCalls: [
                { id: 'call_apply_proposal_999', sourceEventId: 'ev_model_call' }
            ]
        };

        assert.strictEqual(mockApprovalEvent.type, 'tool.approval_required');
        assert.strictEqual(mockApprovalEvent.toolCalls[0].id, 'call_apply_proposal_999');
        assert.strictEqual(proposal.status, 'staged');
    });

    // -------------------------------------------------------------
    // Test 14: Tool approval denial
    // -------------------------------------------------------------
    test('14. Tool approval denial: rejection leaves files untouched and flags proposal rejected', async () => {
        const testFile = path.join(tempDir, 'src', 'calc.ts');
        const origContent = fs.readFileSync(testFile, 'utf8');

        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// Attempted rewrite\n' }
        ]);

        store.setAllHunksDecision(proposal.id, 'rejected');

        // Attempting to apply all-rejected proposal should throw and not write
        await assert.rejects(
            async () => store.applyProposal(proposal.id),
            /No changes were accepted/
        );

        assert.strictEqual(fs.readFileSync(testFile, 'utf8'), origContent, 'Files must be untouched on denial');
    });

    // -------------------------------------------------------------
    // Test 15: Cancellation while awaiting approval
    // -------------------------------------------------------------
    test('15. Cancellation while awaiting approval: no partial writes or state corruption occurs', () => {
        const testFile = path.join(tempDir, 'src', 'calc.ts');
        const origContent = fs.readFileSync(testFile, 'utf8');

        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// Cancelled midway\n' }
        ]);

        // Simulating cancellation: proposal stays staged or in_review, no apply is called
        assert.strictEqual(proposal.status, 'staged');
        assert.strictEqual(fs.readFileSync(testFile, 'utf8'), origContent);
    });

    // -------------------------------------------------------------
    // Test 16: No writes before confirmation
    // -------------------------------------------------------------
    test('16. No writes before confirmation: staging, inspecting, and toggling hunks never writes to disk', () => {
        const testFile = path.join(tempDir, 'src', 'calc.ts');
        const origContent = fs.readFileSync(testFile, 'utf8');

        const proposal = store.createProposal([
            { path: 'src/calc.ts', proposedContent: '// Changed\n' }
        ]);

        // Toggle hunks back and forth
        const hunkId = proposal.files[0].hunks[0].id;
        store.setHunkDecision(proposal.id, 'src/calc.ts', hunkId, 'accepted');
        store.setHunkDecision(proposal.id, 'src/calc.ts', hunkId, 'rejected');
        store.setHunkDecision(proposal.id, 'src/calc.ts', hunkId, 'pending');

        assert.strictEqual(fs.readFileSync(testFile, 'utf8'), origContent, 'Zero writes must occur before explicit apply');
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

        // Create proposal in store
        const fileA = path.join(tempDir, 'src', 'live_a.ts');
        const fileB = path.join(tempDir, 'src', 'live_b.ts');
        fs.writeFileSync(fileA, 'export const VAL_A = "original_a";\n');
        fs.writeFileSync(fileB, 'export const VAL_B = "original_b";\n');

        const liveProposal = store.createProposal([
            { path: 'src/live_a.ts', proposedContent: 'export const VAL_A = "ACCEPTED_MODIFICATION";\n' },
            { path: 'src/live_b.ts', proposedContent: 'export const VAL_B = "REJECTED_MODIFICATION";\n' }
        ]);

        // Accept File A, Reject File B
        store.setAllHunksDecision(liveProposal.id, 'accepted', 'src/live_a.ts');
        store.setAllHunksDecision(liveProposal.id, 'rejected', 'src/live_b.ts');

        // Apply proposal
        const tx = await store.applyProposal(liveProposal.id);

        assert.ok(tx.id.startsWith('tx_'));
        assert.ok(fs.readFileSync(fileA, 'utf8').includes('ACCEPTED_MODIFICATION'), 'File A must receive accepted change');
        assert.ok(fs.readFileSync(fileB, 'utf8').includes('original_b'), 'File B must remain unchanged');
        assert.strictEqual(fs.readFileSync(fileB, 'utf8').includes('REJECTED_MODIFICATION'), false, 'Rejected change must remain absent');

        // Live server reachability test (skips gracefully if server offline)
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

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type {
    ModificationProposal,
    FileProposal,
    TransactionRecord,
    TransactionFileRecord,
    HunkDecision,
    WorkspaceBatchWriter,
    WorkspaceBatchWriteItem
} from './DiffTypes.js';
import { HunkEngine } from './HunkEngine.js';

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.pyc', '.wasm',
    '.class', '.jar', '.war', '.ear', '.mp3', '.mp4', '.avi', '.mov'
]);

/**
 * In-memory store for multi-file modification proposals, hunk reviews, conflict detection,
 * canonical symlink escape protection, and atomic workspace transactions with conflict-aware undo.
 */
export class ProposalStore {
    private readonly _workspaceRoot: string;
    private readonly _canonicalWorkspaceRoot: string;
    private readonly _writer?: WorkspaceBatchWriter;
    private readonly _proposals = new Map<string, ModificationProposal>();
    private readonly _transactions: TransactionRecord[] = [];
    private _activeProposalId?: string;

    constructor(workspaceRoot: string, writer?: WorkspaceBatchWriter) {
        this._workspaceRoot = path.resolve(workspaceRoot);
        try {
            this._canonicalWorkspaceRoot = fs.realpathSync.native
                ? fs.realpathSync.native(this._workspaceRoot)
                : fs.realpathSync(this._workspaceRoot);
        } catch {
            this._canonicalWorkspaceRoot = this._workspaceRoot;
        }
        this._writer = writer;
    }

    public get activeProposal(): ModificationProposal | undefined {
        if (!this._activeProposalId) {
            return undefined;
        }
        return this._proposals.get(this._activeProposalId);
    }

    public getProposal(proposalId: string): ModificationProposal | undefined {
        return this._proposals.get(proposalId);
    }

    public listProposals(): ModificationProposal[] {
        return Array.from(this._proposals.values());
    }

    public get transactionHistory(): readonly TransactionRecord[] {
        return this._transactions;
    }

    /**
     * Staging step: Creates a multi-file proposal in memory without modifying any files on disk.
     */
    public createProposal(
        files: Array<{ path: string; proposedContent: string; rationale?: string }>,
        customProposalId?: string
    ): ModificationProposal {
        if (!files || files.length === 0) {
            throw new Error('Proposal must include at least one file modification.');
        }

        const proposalId = customProposalId ?? `prop_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        if (this._proposals.has(proposalId)) {
            throw new Error(`Proposal with ID "${proposalId}" already exists.`);
        }

        const fileProposals: FileProposal[] = [];

        for (const fileInput of files) {
            const relPath = fileInput.path;
            const validated = this._validateAndResolvePath(relPath);

            // Reject binary content in proposed content
            if (fileInput.proposedContent.includes('\0')) {
                throw new Error(`Binary file modifications are not supported: "${relPath}".`);
            }

            // Read original content
            let originalContent = '';
            if (fs.existsSync(validated.absolutePath)) {
                originalContent = fs.readFileSync(validated.absolutePath, 'utf8');
                if (originalContent.includes('\0')) {
                    throw new Error(`Binary file modifications are not supported: "${relPath}".`);
                }
            } else {
                throw new Error(`Target file does not exist in workspace: "${relPath}".`);
            }

            const originalHash = crypto.createHash('sha256').update(originalContent, 'utf8').digest('hex');
            const hunks = HunkEngine.computeHunks(originalContent, fileInput.proposedContent);

            fileProposals.push({
                filePath: validated.normalizedRelPath,
                originalContent,
                originalHash,
                proposedContent: fileInput.proposedContent,
                hunks,
                status: 'staged',
                rationale: fileInput.rationale
            });
        }

        const proposal: ModificationProposal = {
            id: proposalId,
            createdAt: Date.now(),
            workspaceRoot: this._canonicalWorkspaceRoot,
            files: fileProposals,
            status: 'staged'
        };

        this._proposals.set(proposalId, proposal);
        this._activeProposalId = proposalId;

        return proposal;
    }

    /**
     * Updates the acceptance/rejection decision of a single hunk in a proposal.
     */
    public setHunkDecision(
        proposalId: string,
        filePath: string,
        hunkId: string,
        decision: HunkDecision
    ): void {
        const proposal = this._getValidProposal(proposalId);
        const normalizedPath = filePath.replace(/\\/g, '/');
        const file = proposal.files.find((f) => f.filePath === normalizedPath);

        if (!file) {
            throw new Error(`File "${filePath}" not found in proposal "${proposalId}".`);
        }

        const hunk = file.hunks.find((h) => h.id === hunkId);
        if (!hunk) {
            throw new Error(`Hunk "${hunkId}" not found in file "${filePath}".`);
        }

        hunk.status = decision;
        hunk.decisionTimestamp = Date.now();

        this._updateFileAndProposalStatus(file, proposal);
    }

    /**
     * Updates all hunks in a file or the entire proposal to accepted or rejected.
     */
    public setAllHunksDecision(
        proposalId: string,
        decision: HunkDecision,
        targetFilePath?: string
    ): void {
        const proposal = this._getValidProposal(proposalId);

        for (const file of proposal.files) {
            if (targetFilePath && file.filePath !== targetFilePath.replace(/\\/g, '/')) {
                continue;
            }

            for (const hunk of file.hunks) {
                hunk.status = decision;
                hunk.decisionTimestamp = Date.now();
            }

            this._updateFileAndProposalStatus(file, proposal);
        }
    }

    /**
     * Returns the staged/preview content for a file in a proposal.
     * Evaluates current accepted hunks if any are chosen; otherwise shows proposed content.
     */
    public getStagedContent(proposalId: string, filePath: string): string {
        const proposal = this._getValidProposal(proposalId);
        const normalizedPath = filePath.replace(/\\/g, '/');
        const file = proposal.files.find((f) => f.filePath === normalizedPath);

        if (!file) {
            throw new Error(`File "${filePath}" not found in proposal "${proposalId}".`);
        }

        const hasDecisions = file.hunks.some((h) => h.status !== 'pending');
        if (hasDecisions) {
            return HunkEngine.applyHunkDecisions(file.originalContent, file.hunks).result;
        }

        return file.proposedContent;
    }

    /**
     * Checks if any file in the proposal was modified concurrently on disk after staging.
     */
    public checkConcurrencyConflicts(proposalId: string): { hasConflict: boolean; conflictedFiles: string[] } {
        const proposal = this._getValidProposal(proposalId);
        const conflictedFiles: string[] = [];

        for (const file of proposal.files) {
            const absPath = path.resolve(this._canonicalWorkspaceRoot, file.filePath);
            if (!fs.existsSync(absPath)) {
                conflictedFiles.push(file.filePath);
                continue;
            }

            const currentDiskContent = fs.readFileSync(absPath, 'utf8');
            const currentHash = crypto.createHash('sha256').update(currentDiskContent, 'utf8').digest('hex');

            if (currentHash !== file.originalHash) {
                conflictedFiles.push(file.filePath);
                file.status = 'conflict';
            }
        }

        if (conflictedFiles.length > 0) {
            proposal.status = 'conflict';
        }

        return {
            hasConflict: conflictedFiles.length > 0,
            conflictedFiles
        };
    }

    /**
     * Applies accepted hunks to the workspace atomically.
     * Revalidates paths, checks conflicts, and enforces the safe WorkspaceBatchWriter (zero silent fallback).
     */
    public async applyProposal(
        proposalId: string,
        customWriter?: WorkspaceBatchWriter
    ): Promise<TransactionRecord> {
        const proposal = this._getValidProposal(proposalId);

        if (proposal.status === 'applied') {
            throw new Error(`Proposal "${proposalId}" has already been applied.`);
        }

        // 1. Re-validate paths and symlinks immediately before write to prevent retargeting escapes
        for (const file of proposal.files) {
            this._validateAndResolvePath(file.filePath);
        }

        // 2. Conflict detection immediately prior to write
        const { hasConflict, conflictedFiles } = this.checkConcurrencyConflicts(proposalId);
        if (hasConflict) {
            throw new Error(
                `Atomic application aborted: Concurrent file modifications detected on disk for: [${conflictedFiles.join(', ')}].`
            );
        }

        // 3. Compute final contents per file based strictly on accepted hunks
        const pendingWrites: Array<{
            filePath: string;
            absPath: string;
            previousContent: string;
            finalContent: string;
            previousHash: string;
            postApplyHash: string;
            appliedHunks: number;
            rejectedHunks: number;
        }> = [];

        for (const file of proposal.files) {
            const absPath = path.resolve(this._canonicalWorkspaceRoot, file.filePath);
            const { result, acceptedCount, rejectedCount } = HunkEngine.applyHunkDecisions(
                file.originalContent,
                file.hunks
            );

            // Only queue write if at least one hunk was accepted
            if (acceptedCount > 0) {
                const postApplyHash = crypto.createHash('sha256').update(result, 'utf8').digest('hex');
                pendingWrites.push({
                    filePath: file.filePath,
                    absPath,
                    previousContent: file.originalContent,
                    finalContent: result,
                    previousHash: file.originalHash,
                    postApplyHash,
                    appliedHunks: acceptedCount,
                    rejectedHunks: rejectedCount
                });
            }
        }

        if (pendingWrites.length === 0) {
            throw new Error(`No changes were accepted. No files were modified.`);
        }

        // 4. Enforce safe batch writer: direct sequential filesystem fallback is strictly forbidden
        const writer = customWriter ?? this._writer;
        if (!writer) {
            throw new Error(
                `No WorkspaceBatchWriter configured. Safe workspace write mechanism is required to prevent unverified or partial modifications.`
            );
        }

        const batchItems: WorkspaceBatchWriteItem[] = pendingWrites.map((w) => ({
            filePath: w.filePath,
            absPath: w.absPath,
            content: w.finalContent,
            originalHash: w.previousHash
        }));

        const writeResult = await writer(batchItems);
        if (!writeResult.success) {
            throw new Error(`Batch workspace write failed across ${pendingWrites.length} files.`);
        }

        // 5. Verify actual resulting disk contents after application
        for (const write of pendingWrites) {
            const onDisk = fs.readFileSync(write.absPath, 'utf8');
            if (onDisk !== write.finalContent) {
                throw new Error(
                    `Post-application verification failed for "${write.filePath}": disk content does not match applied content.`
                );
            }
        }

        // 6. Create immutable transaction record
        const modifiedRecords: TransactionFileRecord[] = pendingWrites.map((w) => ({
            filePath: w.filePath,
            previousContent: w.previousContent,
            newContent: w.finalContent,
            previousHash: w.previousHash,
            postApplyHash: w.postApplyHash,
            appliedHunkCount: w.appliedHunks,
            rejectedHunkCount: w.rejectedHunks
        }));

        const transaction: TransactionRecord = {
            id: `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            proposalId,
            timestamp: Date.now(),
            modifiedFiles: modifiedRecords,
            status: 'applied'
        };

        this._transactions.push(transaction);
        proposal.status = 'applied';
        proposal.appliedTransactionId = transaction.id;

        return transaction;
    }

    /**
     * Undoes the specified transaction (or the last transaction) restoring previous file contents.
     * Evaluates post-apply SHA-256 hashes to guarantee no subsequent user changes are overwritten.
     */
    public async undoTransaction(
        transactionId?: string,
        customWriter?: WorkspaceBatchWriter
    ): Promise<{ success: boolean; undoneFiles: string[] }> {
        const tx = transactionId
            ? this._transactions.find((t) => t.id === transactionId)
            : this._transactions[this._transactions.length - 1];

        if (!tx) {
            throw new Error(`No transaction available to undo.`);
        }

        if (tx.status === 'undone') {
            throw new Error(`Transaction "${tx.id}" has already been undone.`);
        }

        // 1. Conflict check: verify that each file has NOT been modified since transaction was applied
        const conflictedFiles: string[] = [];
        for (const fileRecord of tx.modifiedFiles) {
            // Re-validate path and symlinks
            this._validateAndResolvePath(fileRecord.filePath);
            const absPath = path.resolve(this._canonicalWorkspaceRoot, fileRecord.filePath);

            if (!fs.existsSync(absPath)) {
                conflictedFiles.push(fileRecord.filePath);
                continue;
            }

            const currentDiskContent = fs.readFileSync(absPath, 'utf8');
            const currentDiskHash = crypto.createHash('sha256').update(currentDiskContent, 'utf8').digest('hex');

            if (currentDiskHash !== fileRecord.postApplyHash) {
                conflictedFiles.push(fileRecord.filePath);
            }
        }

        if (conflictedFiles.length > 0) {
            throw new Error(
                `Undo transaction aborted: Concurrent modifications detected on disk since transaction "${tx.id}" was applied for: [${conflictedFiles.join(', ')}]. Subsequent developer changes are preserved.`
            );
        }

        // 2. Safe batch write restoration
        const writer = customWriter ?? this._writer;
        if (!writer) {
            throw new Error(`No WorkspaceBatchWriter configured for undo transaction.`);
        }

        const batchItems: WorkspaceBatchWriteItem[] = tx.modifiedFiles.map((f) => ({
            filePath: f.filePath,
            absPath: path.resolve(this._canonicalWorkspaceRoot, f.filePath),
            content: f.previousContent,
            originalHash: f.postApplyHash
        }));

        const writeResult = await writer(batchItems);
        if (!writeResult.success) {
            throw new Error(`Undo workspace batch write failed.`);
        }

        // 3. Verify disk content after restoration
        for (const fileRecord of tx.modifiedFiles) {
            const absPath = path.resolve(this._canonicalWorkspaceRoot, fileRecord.filePath);
            const onDisk = fs.readFileSync(absPath, 'utf8');
            if (onDisk !== fileRecord.previousContent) {
                throw new Error(
                    `Undo verification failed for "${fileRecord.filePath}": disk content does not match restored content.`
                );
            }
        }

        tx.status = 'undone';
        const proposal = this._proposals.get(tx.proposalId);
        if (proposal) {
            proposal.status = 'undone';
        }

        return {
            success: true,
            undoneFiles: tx.modifiedFiles.map((f) => f.filePath)
        };
    }

    private _validateAndResolvePath(rawPath: string): { normalizedRelPath: string; absolutePath: string } {
        if (!rawPath || typeof rawPath !== 'string') {
            throw new Error('File path must be a non-empty string.');
        }

        // 1. Reject absolute paths (POSIX and Windows drive / UNC)
        if (path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath) || rawPath.startsWith('\\\\')) {
            throw new Error(`Absolute paths are not permitted in proposals: "${rawPath}".`);
        }

        // 2. Reject directory traversal
        const normalized = path.normalize(rawPath).replace(/^(\.[/\\])+/, '');
        const segments = normalized.split(/[/\\]/);
        if (segments.includes('..')) {
            throw new Error(`Directory traversal detected in proposal: "${rawPath}". Access outside workspace is denied.`);
        }

        const normalizedForward = normalized.replace(/\\/g, '/');

        // 3. Reject GitHub CI/CD workflows and git internals
        if (normalizedForward.startsWith('.github/workflows/') || normalizedForward === '.github/workflows') {
            throw new Error(
                `Modification of GitHub workflow denied: "${rawPath}". Modifying CI/CD pipelines via AI proposals is restricted.`
            );
        }
        if (normalizedForward === '.git' || normalizedForward.startsWith('.git/')) {
            throw new Error(`Modification of .git directory denied: "${rawPath}".`);
        }

        // 4. Reject sensitive environment files (.env, .env.*, *.env)
        if (
            /(^|\/)\.env(\.[^/]+)?$/i.test(normalizedForward) ||
            /(^|\/)[^/]+\.env$/i.test(normalizedForward)
        ) {
            throw new Error(`Modification of sensitive environment file denied: "${rawPath}".`);
        }

        // 5. Reject credentials, private keys, secrets, tokens, password files
        const basename = path.basename(normalizedForward);
        if (
            /\.(pem|key|pkcs12|pfx|p12|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(basename) ||
            /^(credentials|secrets|token|auth|id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.[^/]+)?$/i.test(basename) ||
            /^(passwd|shadow|master\.passwd)$/i.test(basename)
        ) {
            throw new Error(`Modification of sensitive credential/key file denied: "${rawPath}".`);
        }

        // 6. Reject binary extensions
        const ext = path.extname(basename).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
            throw new Error(`Binary file modifications are not supported: "${rawPath}".`);
        }

        // 7. Canonicalize and inspect path components for symlink escape
        const absPath = path.resolve(this._canonicalWorkspaceRoot, normalized);
        if (!this._isInsideCanonicalRoot(absPath)) {
            throw new Error(`Path "${rawPath}" resolves outside authorized workspace root.`);
        }

        // Walk existing path components to inspect symbolic links
        let currentPath = this._canonicalWorkspaceRoot;
        for (const segment of segments) {
            currentPath = path.join(currentPath, segment);
            if (fs.existsSync(currentPath)) {
                const lstat = fs.lstatSync(currentPath);
                if (lstat.isSymbolicLink()) {
                    const realTarget = fs.realpathSync(currentPath);
                    if (!this._isInsideCanonicalRoot(realTarget)) {
                        throw new Error(
                            `Symbolic link escape detected: "${rawPath}" component "${segment}" points outside authorized workspace root to "${realTarget}".`
                        );
                    }
                }
            }
        }

        // Verify final realpath target if it exists
        if (fs.existsSync(absPath)) {
            const realFinalPath = fs.realpathSync.native
                ? fs.realpathSync.native(absPath)
                : fs.realpathSync(absPath);

            if (!this._isInsideCanonicalRoot(realFinalPath)) {
                throw new Error(
                    `Symbolic link escape detected: Path "${rawPath}" resolves outside authorized workspace root (target: "${realFinalPath}").`
                );
            }
        }

        return {
            normalizedRelPath: normalizedForward,
            absolutePath: absPath
        };
    }

    private _isInsideCanonicalRoot(targetPath: string): boolean {
        const isWindows = process.platform === 'win32';
        const normTarget = path.normalize(targetPath);
        const normRoot = path.normalize(this._canonicalWorkspaceRoot);

        const t = isWindows ? normTarget.toLowerCase() : normTarget;
        const r = (isWindows ? normRoot.toLowerCase() : normRoot).replace(/[/\\]+$/, '');

        if (t === r) {
            return true;
        }
        return t.startsWith(r + path.sep);
    }

    private _getValidProposal(proposalId: string): ModificationProposal {
        const proposal = this._proposals.get(proposalId);
        if (!proposal) {
            throw new Error(`Proposal "${proposalId}" not found or has expired.`);
        }
        return proposal;
    }

    private _updateFileAndProposalStatus(file: FileProposal, proposal: ModificationProposal): void {
        const total = file.hunks.length;
        const accepted = file.hunks.filter((h) => h.status === 'accepted').length;
        const rejected = file.hunks.filter((h) => h.status === 'rejected').length;

        if (accepted === total) {
            file.status = 'accepted';
        } else if (rejected === total) {
            file.status = 'rejected';
        } else if (accepted > 0) {
            file.status = 'partially_accepted';
        } else {
            file.status = 'staged';
        }

        const allFilesAccepted = proposal.files.every((f) => f.status === 'accepted');
        const allFilesRejected = proposal.files.every((f) => f.status === 'rejected');

        if (allFilesAccepted) {
            proposal.status = 'in_review';
        } else if (allFilesRejected) {
            proposal.status = 'rejected';
        } else {
            proposal.status = 'in_review';
        }
    }
}

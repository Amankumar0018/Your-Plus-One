import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type {
    ModificationProposal,
    FileProposal,
    TransactionRecord,
    TransactionFileRecord,
    HunkDecision
} from './DiffTypes.js';
import { HunkEngine } from './HunkEngine.js';

const SENSITIVE_REGEXES = [
    /^\.env(\..+)?$/i,
    /\.(pem|key|pkcs12|pfx|p12|id_rsa|id_ed25519)$/i,
    /^(credentials|secrets|shadow|passwd)(\..+)?$/i
];

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.pyc', '.wasm'
]);

/**
 * In-memory store for multi-file modification proposals, hunk reviews, conflict detection,
 * and atomic workspace transactions with undo capabilities.
 */
export class ProposalStore {
    private readonly _workspaceRoot: string;
    private readonly _proposals = new Map<string, ModificationProposal>();
    private readonly _transactions: TransactionRecord[] = [];
    private _activeProposalId?: string;

    constructor(workspaceRoot: string) {
        this._workspaceRoot = path.resolve(workspaceRoot);
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

            // Read original content
            let originalContent = '';
            if (fs.existsSync(validated.absolutePath)) {
                originalContent = fs.readFileSync(validated.absolutePath, 'utf8');
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
            workspaceRoot: this._workspaceRoot,
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

        // If any hunks are explicitly accepted or rejected, calculate resulting combination
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
            const absPath = path.resolve(this._workspaceRoot, file.filePath);
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
     * Validates hashes immediately before writing. Preserves full transaction record for undo.
     */
    public async applyProposal(
        proposalId: string,
        customWriter?: (filePath: string, content: string) => Promise<void>
    ): Promise<TransactionRecord> {
        const proposal = this._getValidProposal(proposalId);

        if (proposal.status === 'applied') {
            throw new Error(`Proposal "${proposalId}" has already been applied.`);
        }

        // 1. Conflict detection immediately prior to write
        const { hasConflict, conflictedFiles } = this.checkConcurrencyConflicts(proposalId);
        if (hasConflict) {
            throw new Error(
                `Atomic application aborted: Concurrent file modifications detected on disk for: [${conflictedFiles.join(', ')}].`
            );
        }

        // 2. Compute final contents per file based strictly on accepted hunks
        const pendingWrites: Array<{
            filePath: string;
            absPath: string;
            previousContent: string;
            finalContent: string;
            appliedHunks: number;
            rejectedHunks: number;
        }> = [];

        for (const file of proposal.files) {
            const absPath = path.resolve(this._workspaceRoot, file.filePath);
            const { result, acceptedCount, rejectedCount } = HunkEngine.applyHunkDecisions(
                file.originalContent,
                file.hunks
            );

            // Only queue write if at least one hunk was accepted
            if (acceptedCount > 0) {
                pendingWrites.push({
                    filePath: file.filePath,
                    absPath,
                    previousContent: file.originalContent,
                    finalContent: result,
                    appliedHunks: acceptedCount,
                    rejectedHunks: rejectedCount
                });
            }
        }

        if (pendingWrites.length === 0) {
            throw new Error(`No changes were accepted. No files were modified.`);
        }

        // 3. Perform atomic writes
        const modifiedRecords: TransactionFileRecord[] = [];

        for (const write of pendingWrites) {
            if (customWriter) {
                await customWriter(write.filePath, write.finalContent);
            } else {
                fs.writeFileSync(write.absPath, write.finalContent, 'utf8');
            }

            modifiedRecords.push({
                filePath: write.filePath,
                previousContent: write.previousContent,
                newContent: write.finalContent,
                appliedHunkCount: write.appliedHunks,
                rejectedHunkCount: write.rejectedHunks
            });
        }

        // 4. Create transaction record
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
     */
    public async undoTransaction(
        transactionId?: string,
        customWriter?: (filePath: string, content: string) => Promise<void>
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

        const undoneFiles: string[] = [];

        for (const fileRecord of tx.modifiedFiles) {
            const absPath = path.resolve(this._workspaceRoot, fileRecord.filePath);
            if (customWriter) {
                await customWriter(fileRecord.filePath, fileRecord.previousContent);
            } else {
                fs.writeFileSync(absPath, fileRecord.previousContent, 'utf8');
            }
            undoneFiles.push(fileRecord.filePath);
        }

        tx.status = 'undone';
        const proposal = this._proposals.get(tx.proposalId);
        if (proposal) {
            proposal.status = 'undone';
        }

        return {
            success: true,
            undoneFiles
        };
    }

    private _validateAndResolvePath(rawPath: string): { normalizedRelPath: string; absolutePath: string } {
        if (!rawPath || typeof rawPath !== 'string') {
            throw new Error('File path must be a non-empty string.');
        }

        // Reject absolute paths
        if (path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath) || rawPath.startsWith('\\\\')) {
            throw new Error(`Absolute paths are not permitted in proposals: "${rawPath}".`);
        }

        // Reject directory traversal
        const normalized = path.normalize(rawPath).replace(/^(\.[/\\])+/, '');
        const segments = normalized.split(/[/\\]/);
        if (segments.includes('..')) {
            throw new Error(`Directory traversal detected in proposal: "${rawPath}". Access outside workspace is denied.`);
        }

        const absPath = path.resolve(this._workspaceRoot, normalized);
        const rootWithSep = this._workspaceRoot.endsWith(path.sep) ? this._workspaceRoot : this._workspaceRoot + path.sep;
        if (!absPath.startsWith(rootWithSep) && absPath !== this._workspaceRoot) {
            throw new Error(`Path "${rawPath}" resolves outside authorized workspace root.`);
        }

        // Reject sensitive files
        const basename = path.basename(absPath);
        if (SENSITIVE_REGEXES.some((r) => r.test(basename))) {
            throw new Error(`Modification of sensitive file denied: "${rawPath}".`);
        }
        if (absPath.includes(path.sep + '.git' + path.sep) || absPath.endsWith(path.sep + '.git')) {
            throw new Error(`Modification of .git directory denied: "${rawPath}".`);
        }

        // Reject binary extensions
        const ext = path.extname(absPath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
            throw new Error(`Binary file modifications are not supported: "${rawPath}".`);
        }

        return {
            normalizedRelPath: normalized.replace(/\\/g, '/'),
            absolutePath: absPath
        };
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

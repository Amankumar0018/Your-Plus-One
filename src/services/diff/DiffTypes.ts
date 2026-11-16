/**
 * Core type definitions for safe workspace editing, hunk-level diff review,
 * and atomic transactions (Milestone 4 / 4.1).
 */

export type HunkDecision = 'pending' | 'accepted' | 'rejected';

export interface DiffHunk {
    id: string;
    originalStartLine: number; // 1-based line number in original file
    originalLineCount: number;
    proposedStartLine: number; // 1-based line number in proposed file
    proposedLineCount: number;
    originalLines: string[];
    proposedLines: string[];
    header: string; // e.g. @@ -10,5 +10,6 @@
    status: HunkDecision;
    decisionTimestamp?: number;
}

export type FileProposalStatus = 'staged' | 'partially_accepted' | 'accepted' | 'rejected' | 'conflict';

export interface FileProposal {
    filePath: string; // workspace-relative path
    originalContent: string;
    originalHash: string; // SHA-256 hash of original file content
    proposedContent: string;
    hunks: DiffHunk[];
    status: FileProposalStatus;
    rationale?: string;
}

export type ProposalStatus = 'staged' | 'in_review' | 'applied' | 'rejected' | 'conflict' | 'undone';

export interface ModificationProposal {
    id: string;
    createdAt: number;
    workspaceRoot: string;
    files: FileProposal[];
    status: ProposalStatus;
    appliedTransactionId?: string;
    toolCallId?: string;
    threadId?: string;
    turnId?: string;
    sessionId?: string;
}

export interface TransactionFileRecord {
    filePath: string;
    previousContent: string;
    newContent: string;
    previousHash: string; // SHA-256 hash before application
    postApplyHash: string; // SHA-256 hash immediately after application
    appliedHunkCount: number;
    rejectedHunkCount: number;
}

export interface TransactionRecord {
    id: string;
    proposalId: string;
    timestamp: number;
    modifiedFiles: TransactionFileRecord[];
    status: 'applied' | 'undone';
}

export interface ProposeModificationInput {
    proposalId?: string;
    files: Array<{
        path: string;
        proposedContent: string;
        rationale?: string;
    }>;
}

/**
 * Item passed to the safe atomic workspace batch writer.
 */
export interface WorkspaceBatchWriteItem {
    filePath: string;      // workspace-relative path
    absPath: string;       // verified absolute path
    content: string;       // reconstructed final content
    originalHash: string;  // expected baseline SHA-256 hash
}

export interface WorkspaceBatchWriterResult {
    success: boolean;
    writtenFiles: string[];
}

/**
 * Signature for the safe workspace batch writer.
 * Built to enforce multi-file WorkspaceEdit atomicity in VS Code.
 */
export type WorkspaceBatchWriter = (
    items: WorkspaceBatchWriteItem[]
) => Promise<WorkspaceBatchWriterResult>;

import type { DiffHunk } from './DiffTypes.js';

interface DiffOp {
    type: 'equal' | 'insert' | 'delete';
    line: string;
    originalIndex?: number;
    proposedIndex?: number;
}

/**
 * Computes unified diff hunks and applies selective hunk decisions to reconstruct file contents.
 */
export class HunkEngine {
    /**
     * Computes diff hunks between originalContent and proposedContent using LCS line diffing.
     */
    public static computeHunks(originalContent: string, proposedContent: string): DiffHunk[] {
        const origLines = originalContent.split('\n');
        const propLines = proposedContent.split('\n');

        if (originalContent === proposedContent) {
            return [];
        }

        const ops = this._computeLineDiff(origLines, propLines);
        return this._groupIntoHunks(ops);
    }

    /**
     * Applies selective hunk decisions to the original content.
     * Accepted hunks are applied; rejected and pending hunks are left as original lines.
     */
    public static applyHunkDecisions(
        originalContent: string,
        hunks: DiffHunk[]
    ): { result: string; acceptedCount: number; rejectedCount: number; pendingCount: number } {
        const origLines = originalContent.split('\n');
        let acceptedCount = 0;
        let rejectedCount = 0;
        let pendingCount = 0;

        // Sort hunks by originalStartLine ascending
        const sortedHunks = [...hunks].sort((a, b) => a.originalStartLine - b.originalStartLine);

        const resultLines: string[] = [];
        let currentOrigLine = 1; // 1-based original line pointer

        for (const hunk of sortedHunks) {
            const hunkStart = hunk.originalStartLine;
            const hunkOrigCount = hunk.originalLineCount;
            const hunkEnd = hunkStart + hunkOrigCount;

            // Copy unchanged original lines leading up to this hunk
            while (currentOrigLine < hunkStart && currentOrigLine <= origLines.length) {
                resultLines.push(origLines[currentOrigLine - 1]);
                currentOrigLine++;
            }

            if (hunk.status === 'accepted') {
                acceptedCount++;
                // Push proposed lines for this hunk
                resultLines.push(...hunk.proposedLines);
                currentOrigLine = hunkEnd;
            } else if (hunk.status === 'rejected') {
                rejectedCount++;
                // Keep original lines for this hunk
                resultLines.push(...hunk.originalLines);
                currentOrigLine = hunkEnd;
            } else {
                pendingCount++;
                // Pending hunks default to original content
                resultLines.push(...hunk.originalLines);
                currentOrigLine = hunkEnd;
            }
        }

        // Copy any remaining trailing original lines
        while (currentOrigLine <= origLines.length) {
            resultLines.push(origLines[currentOrigLine - 1]);
            currentOrigLine++;
        }

        return {
            result: resultLines.join('\n'),
            acceptedCount,
            rejectedCount,
            pendingCount
        };
    }

    /**
     * Generates a readable unified diff format with individual hunk status annotations.
     */
    public static formatUnifiedDiff(filePath: string, hunks: DiffHunk[]): string {
        const lines: string[] = [
            `--- a/${filePath}`,
            `+++ b/${filePath}`
        ];

        for (const hunk of hunks) {
            lines.push(hunk.header + ` [status: ${hunk.status}]`);
            for (const ol of hunk.originalLines) {
                lines.push(`-${ol}`);
            }
            for (const pl of hunk.proposedLines) {
                lines.push(`+${pl}`);
            }
        }

        return lines.join('\n');
    }

    private static _computeLineDiff(origLines: string[], propLines: string[]): DiffOp[] {
        const n = origLines.length;
        const m = propLines.length;

        // Dynamic programming table for Longest Common Subsequence
        // Optimized for typical code files up to 10,000 lines
        const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                if (origLines[i - 1] === propLines[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack to construct diff operations
        const ops: DiffOp[] = [];
        let i = n;
        let j = m;

        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && origLines[i - 1] === propLines[j - 1]) {
                ops.push({ type: 'equal', line: origLines[i - 1], originalIndex: i - 1, proposedIndex: j - 1 });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                ops.push({ type: 'insert', line: propLines[j - 1], proposedIndex: j - 1 });
                j--;
            } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
                ops.push({ type: 'delete', line: origLines[i - 1], originalIndex: i - 1 });
                i--;
            }
        }

        ops.reverse();
        return ops;
    }

    private static _groupIntoHunks(
        ops: DiffOp[],
        contextLines = 3
    ): DiffHunk[] {
        const hunks: DiffHunk[] = [];
        const changeIndices: number[] = [];

        for (let idx = 0; idx < ops.length; idx++) {
            if (ops[idx].type !== 'equal') {
                changeIndices.push(idx);
            }
        }

        if (changeIndices.length === 0) {
            return [];
        }

        // Cluster changes that are within 2 * contextLines of each other
        const clusters: Array<{ startIdx: number; endIdx: number }> = [];
        let currentClusterStart = changeIndices[0];
        let currentClusterEnd = changeIndices[0];

        for (let k = 1; k < changeIndices.length; k++) {
            const nextChange = changeIndices[k];
            if (nextChange - currentClusterEnd <= contextLines * 2 + 1) {
                currentClusterEnd = nextChange;
            } else {
                clusters.push({ startIdx: currentClusterStart, endIdx: currentClusterEnd });
                currentClusterStart = nextChange;
                currentClusterEnd = nextChange;
            }
        }
        clusters.push({ startIdx: currentClusterStart, endIdx: currentClusterEnd });

        // Convert each cluster to a DiffHunk
        let hunkIndex = 0;
        for (const cluster of clusters) {
            hunkIndex++;
            const startOpIdx = Math.max(0, cluster.startIdx - contextLines);
            const endOpIdx = Math.min(ops.length - 1, cluster.endIdx + contextLines);

            const clusterOps = ops.slice(startOpIdx, endOpIdx + 1);

            const originalHunkLines: string[] = [];
            const proposedHunkLines: string[] = [];
            let firstOrigLine = 1;
            let firstPropLine = 1;
            let foundOrigStart = false;
            let foundPropStart = false;

            for (const op of clusterOps) {
                if (op.type === 'equal') {
                    if (!foundOrigStart && op.originalIndex !== undefined) {
                        firstOrigLine = op.originalIndex + 1;
                        foundOrigStart = true;
                    }
                    if (!foundPropStart && op.proposedIndex !== undefined) {
                        firstPropLine = op.proposedIndex + 1;
                        foundPropStart = true;
                    }
                    originalHunkLines.push(op.line);
                    proposedHunkLines.push(op.line);
                } else if (op.type === 'delete') {
                    if (!foundOrigStart && op.originalIndex !== undefined) {
                        firstOrigLine = op.originalIndex + 1;
                        foundOrigStart = true;
                    }
                    originalHunkLines.push(op.line);
                } else if (op.type === 'insert') {
                    if (!foundPropStart && op.proposedIndex !== undefined) {
                        firstPropLine = op.proposedIndex + 1;
                        foundPropStart = true;
                    }
                    proposedHunkLines.push(op.line);
                }
            }

            if (!foundOrigStart) {
                firstOrigLine = 1;
            }
            if (!foundPropStart) {
                firstPropLine = 1;
            }

            const header = `@@ -${firstOrigLine},${originalHunkLines.length} +${firstPropLine},${proposedHunkLines.length} @@`;

            hunks.push({
                id: `hunk_${hunkIndex}`,
                originalStartLine: firstOrigLine,
                originalLineCount: originalHunkLines.length,
                proposedStartLine: firstPropLine,
                proposedLineCount: proposedHunkLines.length,
                originalLines: originalHunkLines,
                proposedLines: proposedHunkLines,
                header,
                status: 'pending'
            });
        }

        return hunks;
    }
}

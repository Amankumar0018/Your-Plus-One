import type { DiffHunk } from './DiffTypes.js';

interface DiffOp {
    type: 'equal' | 'insert' | 'delete';
    line: string;
    originalIndex?: number;
    proposedIndex?: number;
}

/**
 * Custom error thrown when diff inputs exceed memory-safe thresholds.
 */
export class DiffSizeExceededError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DiffSizeExceededError';
    }
}

/**
 * Computes unified diff hunks and applies selective hunk decisions to reconstruct file contents.
 * Includes common prefix/suffix optimization, flat typed-array memory layout, and safe matrix thresholds.
 */
export class HunkEngine {
    public static readonly MAX_DIFF_INPUT_LINES = 20_000;
    public static readonly MAX_DIFF_MATRIX_CELLS = 2_500_000; // e.g. ~1500 x 1500 modified lines

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

        if (n > this.MAX_DIFF_INPUT_LINES || m > this.MAX_DIFF_INPUT_LINES) {
            throw new DiffSizeExceededError(
                `Diff input exceeds maximum line limit: original has ${n} lines, proposed has ${m} lines (maximum allowed: ${this.MAX_DIFF_INPUT_LINES}). Fine-grained hunk review was refused to protect extension host memory.`
            );
        }

        // 1. Strip common prefix lines
        let prefixCount = 0;
        while (prefixCount < n && prefixCount < m && origLines[prefixCount] === propLines[prefixCount]) {
            prefixCount++;
        }

        // 2. Strip common suffix lines
        let suffixCount = 0;
        while (
            suffixCount < n - prefixCount &&
            suffixCount < m - prefixCount &&
            origLines[n - 1 - suffixCount] === propLines[m - 1 - suffixCount]
        ) {
            suffixCount++;
        }

        const trimmedOrig = origLines.slice(prefixCount, n - suffixCount);
        const trimmedProp = propLines.slice(prefixCount, m - suffixCount);
        const tN = trimmedOrig.length;
        const tM = trimmedProp.length;

        // Check trimmed matrix size
        const cellCount = (tN + 1) * (tM + 1);
        if (cellCount > this.MAX_DIFF_MATRIX_CELLS) {
            throw new DiffSizeExceededError(
                `Diff change region exceeds safe matrix memory threshold: ${tN} modified lines x ${tM} proposed lines (${cellCount.toLocaleString()} cells > limit of ${this.MAX_DIFF_MATRIX_CELLS.toLocaleString()}). Fine-grained hunk review was refused to protect extension host memory.`
            );
        }

        // 3. Compute LCS on trimmed region using flat Int32Array (4 bytes/cell)
        const stride = tM + 1;
        const dp = new Int32Array((tN + 1) * (tM + 1));

        for (let i = 1; i <= tN; i++) {
            const rowOffset = i * stride;
            const prevRowOffset = (i - 1) * stride;
            const oLine = trimmedOrig[i - 1];

            for (let j = 1; j <= tM; j++) {
                if (oLine === trimmedProp[j - 1]) {
                    dp[rowOffset + j] = dp[prevRowOffset + j - 1] + 1;
                } else {
                    const up = dp[prevRowOffset + j];
                    const left = dp[rowOffset + j - 1];
                    dp[rowOffset + j] = up >= left ? up : left;
                }
            }
        }

        // 4. Backtrack through trimmed region
        const trimmedOps: DiffOp[] = [];
        let i = tN;
        let j = tM;

        while (i > 0 || j > 0) {
            const rowOffset = i * stride;
            const prevRowOffset = (i - 1) * stride;

            if (i > 0 && j > 0 && trimmedOrig[i - 1] === trimmedProp[j - 1]) {
                trimmedOps.push({
                    type: 'equal',
                    line: trimmedOrig[i - 1],
                    originalIndex: prefixCount + i - 1,
                    proposedIndex: prefixCount + j - 1
                });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[rowOffset + j - 1] >= dp[prevRowOffset + j])) {
                trimmedOps.push({
                    type: 'insert',
                    line: trimmedProp[j - 1],
                    proposedIndex: prefixCount + j - 1
                });
                j--;
            } else if (i > 0 && (j === 0 || dp[rowOffset + j - 1] < dp[prevRowOffset + j])) {
                trimmedOps.push({
                    type: 'delete',
                    line: trimmedOrig[i - 1],
                    originalIndex: prefixCount + i - 1
                });
                i--;
            }
        }

        trimmedOps.reverse();

        // 5. Combine prefix ops + trimmed ops + suffix ops
        const allOps: DiffOp[] = [];

        for (let p = 0; p < prefixCount; p++) {
            allOps.push({
                type: 'equal',
                line: origLines[p],
                originalIndex: p,
                proposedIndex: p
            });
        }

        allOps.push(...trimmedOps);

        for (let s = 0; s < suffixCount; s++) {
            const origIdx = n - suffixCount + s;
            const propIdx = m - suffixCount + s;
            allOps.push({
                type: 'equal',
                line: origLines[origIdx],
                originalIndex: origIdx,
                proposedIndex: propIdx
            });
        }

        return allOps;
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

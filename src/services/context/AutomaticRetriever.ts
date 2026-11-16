import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ContextCandidate, ActiveEditorContext } from './ContextTypes.js';

const EXCLUDED_DIRS = new Set([
    '.git',
    'node_modules',
    'out',
    'dist',
    '.vscode',
    '.vscode-test',
    'build',
    'target',
    'coverage',
    '.next',
    '__pycache__',
    '.pytest_cache',
    '.venv',
    'venv'
]);

const SENSITIVE_REGEXES = [
    /^\.env(\..+)?$/i,
    /\.(pem|key|pkcs12|pfx|p12|id_rsa|id_ed25519)$/i,
    /^(credentials|secrets|shadow|passwd)(\..+)?$/i
];

const TEXT_CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.rb', '.php', '.swift', '.kt', '.scala',
    '.json', '.md', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.txt'
]);

const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
    'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
    'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
    'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
    'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most',
    'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
    'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such',
    'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
    'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn', 'we',
    'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'won', 'would',
    'you', 'your', 'yours', 'yourself', 'yourselves', 'make', 'sure', 'fix', 'update', 'check', 'please'
]);

export interface ScoredExcerpt {
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    matchedKeywords: string[];
    score: number;
    reason: string;
    symbolName?: string;
}

/**
 * Automatically retrieves and ranks relevant workspace code excerpts based on task semantics and active editor.
 */
export class AutomaticRetriever {
    private readonly _workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this._workspaceRoot = path.resolve(workspaceRoot);
    }

    /**
     * Extracts salient task keywords, splitting camelCase and snake_case and dropping stop words.
     */
    public extractTaskKeywords(taskPrompt: string): string[] {
        // Strip out explicit @file and @symbol tags first
        const stripped = taskPrompt
            .replace(/@file\s+(?:"[^"]+"|[^\s]+)/g, '')
            .replace(/@symbol\s+[A-Za-z0-9_$]+/g, '');

        // Tokenize words, symbols, paths
        const rawTokens = stripped.match(/[A-Za-z0-9_$-]+/g) || [];
        const keywords = new Set<string>();

        for (const token of rawTokens) {
            // Add whole token if not a stop word
            const lower = token.toLowerCase();
            if (lower.length >= 3 && !STOP_WORDS.has(lower) && !/^\d+$/.test(lower)) {
                keywords.add(lower);
            }

            // Split camelCase or PascalCase (e.g. sessionValidation -> session, validation)
            const subTokens = token
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/[_$-]/g, ' ')
                .split(/\s+/);

            for (const sub of subTokens) {
                const subLower = sub.toLowerCase();
                if (subLower.length >= 3 && !STOP_WORDS.has(subLower) && !/^\d+$/.test(subLower)) {
                    keywords.add(subLower);
                }
            }
        }

        return Array.from(keywords);
    }

    /**
     * Automatically retrieves the most relevant candidates across the workspace.
     */
    public retrieveCandidates(
        taskPrompt: string,
        activeEditor?: ActiveEditorContext,
        maxCandidates = 8
    ): ContextCandidate[] {
        const keywords = this.extractTaskKeywords(taskPrompt);
        if (keywords.length === 0) {
            return [];
        }

        const scoredExcerpts: ScoredExcerpt[] = [];

        // 1. Check active editor if provided
        if (activeEditor?.filePath) {
            this._scoreActiveEditor(activeEditor, keywords, scoredExcerpts);
        }

        // 2. Scan workspace files
        this._scanWorkspaceFiles(keywords, activeEditor?.filePath, scoredExcerpts);

        // 3. Sort by score descending and deduplicate overlapping ranges
        scoredExcerpts.sort((a, b) => b.score - a.score);

        const candidates: ContextCandidate[] = [];
        const seenFiles = new Map<string, number>();

        for (const excerpt of scoredExcerpts) {
            if (candidates.length >= maxCandidates) {
                break;
            }

            // Limit to at most 2 excerpts per file to prevent single-file dominance
            const countForFile = seenFiles.get(excerpt.filePath) ?? 0;
            if (countForFile >= 2) {
                continue;
            }
            seenFiles.set(excerpt.filePath, countForFile + 1);

            const source = excerpt.reason.includes('Active editor') ? 'automatic_active_editor' : 'automatic_keyword';

            candidates.push({
                id: `auto_${excerpt.filePath.replace(/[^a-zA-Z0-9]/g, '_')}_${excerpt.startLine}`,
                filePath: excerpt.filePath,
                symbolName: excerpt.symbolName,
                source,
                selectionReason: excerpt.reason,
                startLine: excerpt.startLine,
                endLine: excerpt.endLine,
                content: excerpt.content,
                estimatedTokens: Math.ceil(excerpt.content.length / 4),
                tokenEstimationMethod: 'heuristic_char_div_4',
                relevanceScore: excerpt.score,
                status: 'included'
            });
        }

        return candidates;
    }

    private _scoreActiveEditor(
        activeEditor: ActiveEditorContext,
        keywords: string[],
        out: ScoredExcerpt[]
    ): void {
        const relPath = path.isAbsolute(activeEditor.filePath)
            ? path.relative(this._workspaceRoot, activeEditor.filePath).replace(/\\/g, '/')
            : activeEditor.filePath.replace(/\\/g, '/');

        if (activeEditor.selectedText && activeEditor.selectedText.trim().length > 0) {
            const lines = activeEditor.selectedText.split('\n');
            const startLine = activeEditor.selectionRange?.startLine ?? 1;
            const endLine = activeEditor.selectionRange?.endLine ?? lines.length;

            const numbered = lines.map((l, i) => `${startLine + i}: ${l}`).join('\n');
            const matched = keywords.filter((k) => activeEditor.selectedText!.toLowerCase().includes(k));

            out.push({
                filePath: relPath,
                startLine,
                endLine,
                content: numbered,
                matchedKeywords: matched,
                score: 500 + matched.length * 20, // High priority for developer's active selection
                reason: `Active editor selection in "${relPath}" lines ${startLine}-${endLine} (matched keywords: [${matched.join(', ')}]).`
            });
        }
    }

    private _scanWorkspaceFiles(
        keywords: string[],
        activeEditorPath: string | undefined,
        out: ScoredExcerpt[]
    ): void {
        const walk = (dir: string, depth = 0): void => {
            if (depth > 12) {
                return;
            }

            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const entryName = entry.name;
                const fullPath = path.join(dir, entryName);

                if (entry.isDirectory()) {
                    if (EXCLUDED_DIRS.has(entryName) || entryName.startsWith('.')) {
                        continue;
                    }
                    walk(fullPath, depth + 1);
                } else if (entry.isFile()) {
                    if (SENSITIVE_REGEXES.some((r) => r.test(entryName))) {
                        continue;
                    }

                    const ext = path.extname(entryName).toLowerCase();
                    if (!TEXT_CODE_EXTENSIONS.has(ext) || entryName === 'package-lock.json') {
                        continue;
                    }

                    const relPath = path.relative(this._workspaceRoot, fullPath).replace(/\\/g, '/');
                    if (activeEditorPath && relPath === activeEditorPath) {
                        // Already handled separately
                    }

                    this._evaluateFile(fullPath, relPath, keywords, out);
                }
            }
        };

        walk(this._workspaceRoot);
    }

    private _evaluateFile(
        fullPath: string,
        relPath: string,
        keywords: string[],
        out: ScoredExcerpt[]
    ): void {
        let content: string;
        try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 256 * 1024) {
                return;
            }
            content = fs.readFileSync(fullPath, 'utf8');
        } catch {
            return;
        }

        const lines = content.split('\n');
        const lowerRelPath = relPath.toLowerCase();

        // 1. Check path matches
        const pathMatches = keywords.filter((k) => lowerRelPath.includes(k));
        const pathBonus = pathMatches.length * 35;

        // 2. Scan lines for keyword occurrences
        const lineScores: Array<{ lineIndex: number; matched: string[] }> = [];

        for (let i = 0; i < lines.length; i++) {
            const lineLower = lines[i].toLowerCase();
            const matchedOnLine: string[] = [];

            for (const kw of keywords) {
                if (lineLower.includes(kw)) {
                    matchedOnLine.push(kw);
                }
            }

            if (matchedOnLine.length > 0) {
                lineScores.push({ lineIndex: i, matched: matchedOnLine });
            }
        }

        if (lineScores.length === 0 && pathMatches.length === 0) {
            return;
        }

        // 3. Cluster line matches into relevant contiguous excerpts (max 30 lines)
        if (lineScores.length > 0) {
            // Find densest cluster
            let bestClusterStart = 0;
            let bestClusterEnd = Math.min(lines.length - 1, 30);
            let maxUniqueKeywords = 0;
            let maxHitCount = 0;

            for (const match of lineScores) {
                const windowStart = Math.max(0, match.lineIndex - 5);
                const windowEnd = Math.min(lines.length - 1, match.lineIndex + 20);

                const windowLines = lineScores.filter(
                    (m) => m.lineIndex >= windowStart && m.lineIndex <= windowEnd
                );

                const uniqueKws = new Set<string>();
                let hits = 0;
                for (const wl of windowLines) {
                    for (const kw of wl.matched) {
                        uniqueKws.add(kw);
                        hits++;
                    }
                }

                if (uniqueKws.size > maxUniqueKeywords || (uniqueKws.size === maxUniqueKeywords && hits > maxHitCount)) {
                    maxUniqueKeywords = uniqueKws.size;
                    maxHitCount = hits;
                    bestClusterStart = windowStart;
                    bestClusterEnd = windowEnd;
                }
            }

            const clusterLines = lines.slice(bestClusterStart, bestClusterEnd + 1);
            const numberedContent = clusterLines
                .map((l, idx) => `${bestClusterStart + idx + 1}: ${l}`)
                .join('\n');

            const allMatched = Array.from(
                new Set(
                    lineScores
                        .filter((m) => m.lineIndex >= bestClusterStart && m.lineIndex <= bestClusterEnd)
                        .flatMap((m) => m.matched)
                )
            );

            // Compute score
            let score = pathBonus + allMatched.length * 20 + maxHitCount * 5;
            if (relPath.startsWith('src/')) {
                score += 15;
            }
            if (/(test|mock|fixture)/i.test(relPath)) {
                score -= 20;
            }

            let reason = `Matched task keywords [${allMatched.join(', ')}] in lines ${bestClusterStart + 1}-${bestClusterEnd + 1} (score: ${score}).`;
            if (pathMatches.length > 0) {
                reason = `Filename matches [${pathMatches.join(', ')}] and contains relevant excerpts lines ${bestClusterStart + 1}-${bestClusterEnd + 1}.`;
            }

            out.push({
                filePath: relPath,
                startLine: bestClusterStart + 1,
                endLine: bestClusterEnd + 1,
                content: numberedContent,
                matchedKeywords: allMatched,
                score,
                reason
            });
        } else if (pathMatches.length > 0 && lines.length > 0) {
            // Path matched, include top of file
            const end = Math.min(lines.length - 1, 25);
            const numbered = lines.slice(0, end + 1).map((l, i) => `${i + 1}: ${l}`).join('\n');

            out.push({
                filePath: relPath,
                startLine: 1,
                endLine: end + 1,
                content: numbered,
                matchedKeywords: pathMatches,
                score: pathBonus,
                reason: `Filename "${relPath}" matches task terminology [${pathMatches.join(', ')}].`
            });
        }
    }
}

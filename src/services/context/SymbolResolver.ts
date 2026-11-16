import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ExplicitReference, ContextCandidate } from './ContextTypes.js';

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
    '.next'
]);

const SENSITIVE_REGEXES = [
    /^\.env(\..+)?$/i,
    /\.(pem|key|pkcs12|pfx|p12|id_rsa|id_ed25519)$/i,
    /^(credentials|secrets|shadow|passwd)(\..+)?$/i
];

const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.json'
]);

export interface SymbolMatch {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    declarationLine: number;
    declarationText: string;
    content: string;
    isExported: boolean;
    isTest: boolean;
    score: number;
    disambiguationRationale: string;
}

/**
 * Resolves @symbol references to source code definitions across workspace files.
 */
export class SymbolResolver {
    private readonly _workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this._workspaceRoot = path.resolve(workspaceRoot);
    }

    /**
     * Extracts all @symbol <name> patterns from the prompt.
     */
    public extractSymbolReferences(prompt: string): ExplicitReference[] {
        const regex = /@symbol\s+([A-Za-z0-9_$]+)/g;
        const refs: ExplicitReference[] = [];
        let match: RegExpExecArray | null;

        while ((match = regex.exec(prompt)) !== null) {
            refs.push({
                type: 'symbol',
                rawMatch: match[0],
                target: match[1],
                resolved: false
            });
        }

        return refs;
    }

    /**
     * Resolves a symbol name across workspace files, handling ambiguities and returning the best match.
     */
    public resolveSymbol(symbolName: string): { candidate?: ContextCandidate; ref: ExplicitReference } {
        const ref: ExplicitReference = {
            type: 'symbol',
            rawMatch: `@symbol ${symbolName}`,
            target: symbolName,
            resolved: false
        };

        const matches = this.findSymbolMatches(symbolName);

        if (matches.length === 0) {
            ref.error = `Symbol "${symbolName}" could not be found in workspace source files.`;
            return { ref };
        }

        // Sort by score descending (exported non-test files first)
        matches.sort((a, b) => b.score - a.score);

        const primary = matches[0];
        const count = matches.length;
        let disambiguationNote = `Symbol referenced using @symbol "${symbolName}".`;

        if (count > 1) {
            const others = matches.slice(1).map((m) => `${m.filePath}:${m.declarationLine}`).join(', ');
            disambiguationNote = `Selected primary definition in "${primary.filePath}" (${primary.declarationText.trim().slice(0, 40)}) among ${count} matches. Other candidates: [${others}].`;
        } else {
            disambiguationNote = `Resolved symbol "${symbolName}" in "${primary.filePath}" at line ${primary.declarationLine}.`;
        }

        ref.resolved = true;
        ref.resolvedPath = primary.filePath;
        ref.symbolName = symbolName;
        ref.lineRange = { start: primary.startLine, end: primary.endLine };
        ref.rationale = disambiguationNote;

        const candidate: ContextCandidate = {
            id: `symbol_${symbolName}_${primary.filePath.replace(/[^a-zA-Z0-9]/g, '_')}_${primary.startLine}`,
            filePath: primary.filePath,
            symbolName,
            source: 'explicit_symbol',
            selectionReason: disambiguationNote,
            startLine: primary.startLine,
            endLine: primary.endLine,
            content: primary.content,
            estimatedTokens: Math.ceil(primary.content.length / 4),
            tokenEstimationMethod: 'heuristic_char_div_4',
            relevanceScore: 1000 + primary.score, // Explicit symbols receive 1000+ base priority
            status: 'included'
        };

        return { candidate, ref };
    }

    /**
     * Scans workspace code files to locate symbol definitions.
     */
    public findSymbolMatches(symbolName: string): SymbolMatch[] {
        const matches: SymbolMatch[] = [];
        const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Regex patterns identifying definitions of functions, classes, interfaces, variables, types
        const defPatterns = [
            // export function / function
            new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
            // export class / class
            new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b`),
            // export interface / interface
            new RegExp(`^\\s*(?:export\\s+)?interface\\s+${escaped}\\b`),
            // export type / type
            new RegExp(`^\\s*(?:export\\s+)?type\\s+${escaped}\\s*=`),
            // export const/let/var name =
            new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*[:=]`),
            // Python def/class
            new RegExp(`^\\s*(?:def|class)\\s+${escaped}\\b`),
            // Method in object or class: name(...) { or name = (...) =>
            new RegExp(`^\\s*(?:public|private|protected|static|async|get|set)?\\s*${escaped}\\s*\\(`),
            new RegExp(`^\\s*(?:public|private|protected|static)?\\s*${escaped}\\s*=\\s*\\(`)
        ];

        this._walkCodeFiles(this._workspaceRoot, (filePath, content) => {
            const relPath = path.relative(this._workspaceRoot, filePath).replace(/\\/g, '/');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                for (const pattern of defPatterns) {
                    if (pattern.test(line)) {
                        const declLine = i + 1;
                        const isExported = /\bexport\b/.test(line);
                        const isTest = /(test|spec|mock|fixture)/i.test(relPath);

                        // Calculate surrounding block
                        const { startLine, endLine, blockContent } = this._extractSurroundingBlock(lines, i);

                        let score = 50;
                        if (isExported) {
                            score += 40;
                        }
                        if (!isTest) {
                            score += 30;
                        }
                        if (relPath.startsWith('src/')) {
                            score += 20;
                        }

                        matches.push({
                            name: symbolName,
                            filePath: relPath,
                            startLine,
                            endLine,
                            declarationLine: declLine,
                            declarationText: line.trim(),
                            content: blockContent,
                            isExported,
                            isTest,
                            score,
                            disambiguationRationale: isTest ? 'Test or mock implementation' : 'Source implementation'
                        });

                        break; // Only one pattern match per line
                    }
                }
            }
        });

        return matches;
    }

    private _extractSurroundingBlock(lines: string[], lineIndex: number): { startLine: number; endLine: number; blockContent: string } {
        const declLine = lineIndex;
        let startLine = Math.max(0, declLine - 2);

        // Include any preceding JSDoc / docstrings
        for (let j = declLine - 1; j >= Math.max(0, declLine - 8); j--) {
            const prev = lines[j].trim();
            if (prev.startsWith('*') || prev.startsWith('/**') || prev.startsWith('//') || prev.startsWith('*/')) {
                startLine = j;
            } else {
                break;
            }
        }

        // Trace forward for closing brace or natural boundary
        let openBraces = 0;
        let foundBrace = false;
        let endLine = Math.min(lines.length - 1, declLine + 25);

        for (let k = declLine; k < Math.min(lines.length, declLine + 60); k++) {
            const l = lines[k];
            for (const char of l) {
                if (char === '{') {
                    openBraces++;
                    foundBrace = true;
                } else if (char === '}') {
                    openBraces--;
                }
            }

            if (foundBrace && openBraces <= 0) {
                endLine = k;
                break;
            }
        }

        const selectedLines = lines.slice(startLine, endLine + 1);
        const blockContent = selectedLines
            .map((txt, idx) => `${startLine + idx + 1}: ${txt}`)
            .join('\n');

        return {
            startLine: startLine + 1,
            endLine: endLine + 1,
            blockContent
        };
    }

    private _walkCodeFiles(dir: string, onFile: (filePath: string, content: string) => void, depth = 0): void {
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
                this._walkCodeFiles(fullPath, onFile, depth + 1);
            } else if (entry.isFile()) {
                if (SENSITIVE_REGEXES.some((r) => r.test(entryName))) {
                    continue;
                }
                const ext = path.extname(entryName).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext)) {
                    continue;
                }

                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > 256 * 1024) {
                        continue;
                    } // Skip huge files
                    const content = fs.readFileSync(fullPath, 'utf8');
                    onFile(fullPath, content);
                } catch {
                    // Ignore unreadable files
                }
            }
        }
    }
}

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ExplicitReference, ContextCandidate } from './ContextTypes.js';

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
 * Resolves @file references to workspace files with strict security, path validation, and boundary checks.
 */
export class FileResolver {
    private readonly _workspaceRoot: string;
    private readonly _maxFileSize: number;

    constructor(workspaceRoot: string, maxFileSize = 256 * 1024) {
        this._workspaceRoot = path.resolve(workspaceRoot);
        this._maxFileSize = maxFileSize;
    }

    /**
     * Extracts @file <path> patterns from developer instructions.
     * Supports `@file "path with spaces/file.ts"` and `@file path/to/file.ts`.
     */
    public extractFileReferences(prompt: string): ExplicitReference[] {
        const regex = /@file\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
        const refs: ExplicitReference[] = [];
        let match: RegExpExecArray | null;

        while ((match = regex.exec(prompt)) !== null) {
            const rawTarget = match[1] || match[2] || match[3];
            refs.push({
                type: 'file',
                rawMatch: match[0],
                target: rawTarget,
                resolved: false
            });
        }

        return refs;
    }

    /**
     * Resolves an explicit file reference safely inside the workspace.
     */
    public resolveFile(targetPath: string): { candidate?: ContextCandidate; ref: ExplicitReference } {
        const ref: ExplicitReference = {
            type: 'file',
            rawMatch: `@file ${targetPath}`,
            target: targetPath,
            resolved: false
        };

        if (!targetPath || targetPath.trim().length === 0) {
            ref.error = 'File path cannot be empty.';
            return { ref };
        }

        // 1. Reject absolute paths
        if (path.isAbsolute(targetPath) || /^[a-zA-Z]:/.test(targetPath) || targetPath.startsWith('\\\\')) {
            ref.error = `Absolute paths are not permitted: "${targetPath}". Please use workspace-relative paths.`;
            return { ref };
        }

        // 2. Reject path traversal
        const normalized = path.normalize(targetPath).replace(/^(\.[/\\])+/, '');
        const segments = normalized.split(/[/\\]/);
        if (segments.includes('..')) {
            ref.error = `Directory traversal detected: "${targetPath}". Access outside workspace is denied.`;
            return { ref };
        }

        // 3. Resolve inside workspace root
        const resolved = path.resolve(this._workspaceRoot, normalized);
        const rootWithSep = this._workspaceRoot.endsWith(path.sep) ? this._workspaceRoot : this._workspaceRoot + path.sep;
        if (!resolved.startsWith(rootWithSep) && resolved !== this._workspaceRoot) {
            ref.error = `Path "${targetPath}" resolves outside authorized workspace root.`;
            return { ref };
        }

        // 4. Reject sensitive files
        const basename = path.basename(resolved);
        if (SENSITIVE_REGEXES.some((r) => r.test(basename))) {
            ref.error = `Access to sensitive file denied: "${targetPath}".`;
            return { ref };
        }
        if (resolved.includes(path.sep + '.git' + path.sep) || resolved.endsWith(path.sep + '.git')) {
            ref.error = `Access to .git directory contents denied: "${targetPath}".`;
            return { ref };
        }

        // 5. Verify existence
        if (!fs.existsSync(resolved)) {
            ref.error = `File not found in workspace: "${targetPath}".`;
            return { ref };
        }

        // Check symlink realpath
        try {
            const real = fs.realpathSync(resolved);
            if (!real.startsWith(rootWithSep) && real !== this._workspaceRoot) {
                ref.error = `Symlink targets outside workspace: "${targetPath}".`;
                return { ref };
            }
        } catch {
            ref.error = `Unable to resolve path: "${targetPath}".`;
            return { ref };
        }

        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            ref.error = `Target is not a regular file: "${targetPath}".`;
            return { ref };
        }

        if (stat.size > this._maxFileSize) {
            ref.error = `File exceeds size limit (${stat.size} > ${this._maxFileSize} bytes): "${targetPath}".`;
            return { ref };
        }

        // Check binary extension
        const ext = path.extname(resolved).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
            ref.error = `Binary file rejected: "${targetPath}". Only text/code files may be referenced.`;
            return { ref };
        }

        // Read buffer and check for null bytes
        const buffer = fs.readFileSync(resolved);
        const sampleLimit = Math.min(buffer.length, 8000);
        for (let i = 0; i < sampleLimit; i++) {
            if (buffer[i] === 0) {
                ref.error = `Binary content detected in file: "${targetPath}".`;
                return { ref };
            }
        }

        const textContent = buffer.toString('utf8');
        const lines = textContent.split('\n');
        const totalLines = lines.length;

        const relWorkspacePath = path.relative(this._workspaceRoot, resolved).replace(/\\/g, '/');
        const numberedContent = lines
            .map((line, idx) => `${idx + 1}: ${line}`)
            .join('\n');

        ref.resolved = true;
        ref.resolvedPath = relWorkspacePath;
        ref.lineRange = { start: 1, end: totalLines };
        ref.rationale = `Explicitly mentioned using @file "${targetPath}".`;

        const candidate: ContextCandidate = {
            id: `file_${relWorkspacePath.replace(/[^a-zA-Z0-9]/g, '_')}`,
            filePath: relWorkspacePath,
            source: 'explicit_file',
            selectionReason: `Explicitly mentioned using @file "${targetPath}".`,
            startLine: 1,
            endLine: totalLines,
            content: numberedContent,
            estimatedTokens: Math.ceil(numberedContent.length / 4),
            tokenEstimationMethod: 'heuristic_char_div_4',
            relevanceScore: 2000, // Explicit files receive maximum priority (2000)
            status: 'included'
        };

        return { candidate, ref };
    }
}

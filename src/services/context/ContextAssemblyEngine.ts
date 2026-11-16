import type {
    ContextAssemblyOptions,
    AssembledContextResult,
    ContextCandidate,
    ContextBudget
} from './ContextTypes.js';
import { FileResolver } from './FileResolver.js';
import { SymbolResolver } from './SymbolResolver.js';
import { AutomaticRetriever } from './AutomaticRetriever.js';
import { ContextBudgetManager } from './ContextBudgetManager.js';

/**
 * Intelligent, explainable context assembly engine for Your +1.
 * Assembles explicit and automatic context under bounded budgets, providing full selection rationales.
 */
export class ContextAssemblyEngine {
    private readonly _workspaceRoot: string;
    private readonly _fileResolver: FileResolver;
    private readonly _symbolResolver: SymbolResolver;
    private readonly _automaticRetriever: AutomaticRetriever;

    constructor(workspaceRoot: string) {
        this._workspaceRoot = workspaceRoot;
        this._fileResolver = new FileResolver(workspaceRoot);
        this._symbolResolver = new SymbolResolver(workspaceRoot);
        this._automaticRetriever = new AutomaticRetriever(workspaceRoot);
    }

    public get workspaceRoot(): string {
        return this._workspaceRoot;
    }

    /**
     * Executes the complete context assembly pipeline for a developer task.
     */
    public async assembleContext(
        taskPrompt: string,
        options?: ContextAssemblyOptions
    ): Promise<AssembledContextResult> {
        const rawCandidates: ContextCandidate[] = [];
        const unresolvedReferences: string[] = [];
        const warnings: string[] = [];

        // 1. Resolve explicit @file references
        const fileRefs = this._fileResolver.extractFileReferences(taskPrompt);
        const resolvedFilePaths = new Set<string>();

        for (const ref of fileRefs) {
            const { candidate, ref: resolvedRef } = this._fileResolver.resolveFile(ref.target);
            if (candidate) {
                rawCandidates.push(candidate);
                resolvedFilePaths.add(candidate.filePath);
            } else if (resolvedRef.error) {
                unresolvedReferences.push(`@file ${ref.target}: ${resolvedRef.error}`);
                warnings.push(`Unresolved reference: @file ${ref.target} (${resolvedRef.error})`);
            }
        }

        // 2. Resolve explicit @symbol references
        const symbolRefs = this._symbolResolver.extractSymbolReferences(taskPrompt);
        for (const ref of symbolRefs) {
            const { candidate, ref: resolvedRef } = this._symbolResolver.resolveSymbol(ref.target);
            if (candidate) {
                rawCandidates.push(candidate);
            } else if (resolvedRef.error) {
                unresolvedReferences.push(`@symbol ${ref.target}: ${resolvedRef.error}`);
                warnings.push(`Unresolved reference: @symbol ${ref.target} (${resolvedRef.error})`);
            }
        }

        // 3. Automatic retrieval based on task terminology and active editor
        const automaticCandidates = this._automaticRetriever.retrieveCandidates(
            taskPrompt,
            options?.activeEditor,
            options?.maxAutomaticCandidates ?? 8
        );

        // Filter out automatic candidates that duplicate already explicitly resolved whole files
        for (const auto of automaticCandidates) {
            if (resolvedFilePaths.has(auto.filePath)) {
                // Whole file is already explicitly attached
                continue;
            }
            rawCandidates.push(auto);
        }

        // 4. Budget allocation and priority enforcement
        const budgetManager = new ContextBudgetManager({
            modelContextLength: options?.modelContextLength,
            maxOutputTokens: options?.maxOutputTokens,
            maxContextAssemblyBudget: options?.maxBudgetTokens
        });

        const { allocatedCandidates, budget, warnings: budgetWarnings } = budgetManager.allocateBudget(rawCandidates);
        warnings.push(...budgetWarnings);

        // 5. Clean task prompt (remove explicit tags for display/model instruction clarity)
        const cleanedPrompt = taskPrompt
            .replace(/@file\s+(?:"[^"]+"|[^\s]+)/g, '')
            .replace(/@symbol\s+[A-Za-z0-9_$]+/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();

        // 6. Generate formatted markdown context representation
        const formattedContext = this._buildFormattedContext(allocatedCandidates, budget, unresolvedReferences);

        return {
            originalPrompt: taskPrompt,
            cleanedPrompt: cleanedPrompt.length > 0 ? cleanedPrompt : taskPrompt,
            candidates: allocatedCandidates,
            budget,
            formattedContext,
            unresolvedReferences,
            warnings
        };
    }

    private _buildFormattedContext(
        candidates: ContextCandidate[],
        budget: ContextBudget,
        unresolved: string[]
    ): string {
        const sections: string[] = [];

        sections.push(`### Assembled Context (Your +1 Context Assembly Engine)`);
        sections.push(
            `> **Budget Overview**: ${budget.usedTokens} / ${budget.maxContextAssemblyBudget} tokens used ` +
            `(${budget.remainingTokens} remaining). Explicit: ${budget.explicitTokens} tokens | Automatic: ${budget.automaticTokens} tokens.`
        );

        if (unresolved.length > 0) {
            sections.push(`\n> [!WARNING] Unresolved References:\n${unresolved.map((u) => `> - ${u}`).join('\n')}`);
        }

        const included = candidates.filter((c) => c.status === 'included' || c.status === 'truncated');
        const omitted = candidates.filter((c) => c.status === 'omitted_budget');

        // Explicit references section
        const explicitList = included.filter(
            (c) => c.source === 'explicit_file' || c.source === 'explicit_symbol'
        );

        if (explicitList.length > 0) {
            sections.push(`\n#### Explicit References:`);
            for (const item of explicitList) {
                const label = item.symbolName ? `Symbol \`${item.symbolName}\` in \`${item.filePath}\`` : `File \`${item.filePath}\``;
                const truncNote = item.status === 'truncated' ? ' (TRUNCATED TO FIT BUDGET)' : '';
                sections.push(
                    `\n##### ${label} (Lines ${item.startLine}-${item.endLine})${truncNote}\n` +
                    `- **Selection Reason**: ${item.selectionReason}\n` +
                    `- **Estimated Tokens**: ${item.estimatedTokens}\n` +
                    `\`\`\`\n${item.content}\n\`\`\``
                );
            }
        }

        // Automatic excerpts section
        const automaticList = included.filter(
            (c) => c.source !== 'explicit_file' && c.source !== 'explicit_symbol'
        );

        if (automaticList.length > 0) {
            sections.push(`\n#### Relevant Workspace Excerpts (Automatically Retrieved):`);
            for (const item of automaticList) {
                const truncNote = item.status === 'truncated' ? ' (TRUNCATED TO FIT BUDGET)' : '';
                sections.push(
                    `\n##### \`${item.filePath}\` (Lines ${item.startLine}-${item.endLine})${truncNote}\n` +
                    `- **Selection Reason**: ${item.selectionReason}\n` +
                    `- **Relevance Score**: ${item.relevanceScore} | **Tokens**: ${item.estimatedTokens}\n` +
                    `\`\`\`\n${item.content}\n\`\`\``
                );
            }
        }

        if (omitted.length > 0) {
            sections.push(`\n#### Context Omitted Due to Budget:`);
            for (const item of omitted) {
                sections.push(`- \`${item.filePath}\` (${item.source}): ${item.omissionReason}`);
            }
        }

        return sections.join('\n');
    }
}

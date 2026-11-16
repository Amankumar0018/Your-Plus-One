import type { ContextCandidate, ContextBudget } from './ContextTypes.js';

export interface BudgetManagerConfig {
    modelContextLength?: number;
    maxOutputTokens?: number;
    maxContextAssemblyBudget?: number;
    reservedForPromptAndHistory?: number;
}

/**
 * Manages the token budget for context assembly, enforcing explicit reference priority,
 * transparent heuristics, and graceful truncation/omission reporting.
 */
export class ContextBudgetManager {
    public static readonly DEFAULT_MODEL_CONTEXT_LENGTH = 128000;
    public static readonly DEFAULT_MAX_OUTPUT_TOKENS = 4096;
    public static readonly DEFAULT_RESERVED_PROMPT_HISTORY = 4096;
    public static readonly DEFAULT_ASSEMBLY_BUDGET = 16000; // Sensible default budget for context payload

    private readonly _modelContextLength: number;
    private readonly _maxOutputTokens: number;
    private readonly _reservedForPromptAndHistory: number;
    private readonly _maxAssemblyBudget: number;

    constructor(config?: BudgetManagerConfig) {
        this._modelContextLength = config?.modelContextLength ?? ContextBudgetManager.DEFAULT_MODEL_CONTEXT_LENGTH;
        this._maxOutputTokens = config?.maxOutputTokens ?? ContextBudgetManager.DEFAULT_MAX_OUTPUT_TOKENS;
        this._reservedForPromptAndHistory = config?.reservedForPromptAndHistory ?? ContextBudgetManager.DEFAULT_RESERVED_PROMPT_HISTORY;

        // If explicitly specified, use it; otherwise compute based on model context minus reservations
        if (config?.maxContextAssemblyBudget) {
            this._maxAssemblyBudget = config.maxContextAssemblyBudget;
        } else {
            const available = this._modelContextLength - this._maxOutputTokens - this._reservedForPromptAndHistory;
            this._maxAssemblyBudget = Math.min(Math.max(2000, available), ContextBudgetManager.DEFAULT_ASSEMBLY_BUDGET);
        }
    }

    /**
     * Estimates token count for text using the standard UTF-8 4-character-per-token heuristic.
     */
    public estimateTokens(text: string): number {
        if (!text || text.length === 0) {
            return 0;
        }
        return Math.ceil(text.length / 4);
    }

    /**
     * Allocates candidate excerpts within the bounded budget, strictly prioritizing explicit references.
     */
    public allocateBudget(candidates: ContextCandidate[]): {
        allocatedCandidates: ContextCandidate[];
        budget: ContextBudget;
        warnings: string[];
    } {
        const warnings: string[] = [];
        let usedTokens = 0;
        let explicitTokens = 0;
        let automaticTokens = 0;
        let omittedCount = 0;
        let truncatedCount = 0;

        // Separate explicit vs automatic candidates
        const explicitCandidates = candidates.filter((c) =>
            c.source === 'explicit_file' || c.source === 'explicit_symbol'
        );
        const automaticCandidates = candidates.filter((c) =>
            c.source !== 'explicit_file' && c.source !== 'explicit_symbol'
        );

        // Sort automatic candidates by relevance score descending
        automaticCandidates.sort((a, b) => b.relevanceScore - a.relevanceScore);

        const allocatedCandidates: ContextCandidate[] = [];

        // 1. Process explicit candidates first (Highest Priority)
        for (const candidate of explicitCandidates) {
            const tokens = candidate.estimatedTokens;

            if (usedTokens + tokens <= this._maxAssemblyBudget) {
                usedTokens += tokens;
                explicitTokens += tokens;
                candidate.status = 'included';
                allocatedCandidates.push(candidate);
            } else {
                // Explicit reference exceeds remaining budget
                const remaining = this._maxAssemblyBudget - usedTokens;
                if (remaining > 200) {
                    // Partially include with truncation notice
                    const allowedChars = remaining * 4;
                    const truncatedContent = candidate.content.slice(0, allowedChars) +
                        `\n\n[... Truncated by Your +1 Context Budget Engine (${tokens} tokens needed, ${remaining} available) ...]`;
                    candidate.content = truncatedContent;
                    candidate.estimatedTokens = remaining;
                    candidate.status = 'truncated';
                    candidate.omissionReason = `Partially included: explicit reference required ${tokens} tokens but only ${remaining} remained in budget.`;
                    usedTokens += remaining;
                    explicitTokens += remaining;
                    truncatedCount++;
                    allocatedCandidates.push(candidate);
                    warnings.push(`Explicit reference "${candidate.filePath}" was truncated due to budget constraints.`);
                } else {
                    candidate.status = 'omitted_budget';
                    candidate.omissionReason = `Cannot fit explicit reference into remaining budget (${tokens} needed, ${remaining} left).`;
                    omittedCount++;
                    allocatedCandidates.push(candidate);
                    warnings.push(`Explicit reference "${candidate.filePath}" could not fit in the context budget (${tokens} tokens required).`);
                }
            }
        }

        // 2. Process automatic candidates with remaining budget
        for (const candidate of automaticCandidates) {
            const tokens = candidate.estimatedTokens;
            const remaining = this._maxAssemblyBudget - usedTokens;

            if (remaining <= 50) {
                // Budget exhausted
                candidate.status = 'omitted_budget';
                candidate.omissionReason = `Omitted: Context assembly budget reached (${this._maxAssemblyBudget} tokens limit).`;
                omittedCount++;
                allocatedCandidates.push(candidate);
                continue;
            }

            if (tokens <= remaining) {
                usedTokens += tokens;
                automaticTokens += tokens;
                candidate.status = 'included';
                allocatedCandidates.push(candidate);
            } else if (remaining >= 150) {
                // Truncate automatic candidate to fit remaining tokens
                const allowedChars = remaining * 4;
                const truncatedContent = candidate.content.slice(0, allowedChars) +
                    `\n[... Truncated due to context budget: ${tokens - remaining} tokens omitted ...]`;
                candidate.content = truncatedContent;
                candidate.estimatedTokens = remaining;
                candidate.status = 'truncated';
                candidate.omissionReason = `Truncated to fit remaining ${remaining} budget tokens (originally ${tokens} tokens).`;
                usedTokens += remaining;
                automaticTokens += remaining;
                truncatedCount++;
                allocatedCandidates.push(candidate);
            } else {
                candidate.status = 'omitted_budget';
                candidate.omissionReason = `Omitted: Candidate required ${tokens} tokens but only ${remaining} tokens remained in budget.`;
                omittedCount++;
                allocatedCandidates.push(candidate);
            }
        }

        const budget: ContextBudget = {
            modelContextLength: this._modelContextLength,
            maxOutputTokens: this._maxOutputTokens,
            reservedForPromptAndHistory: this._reservedForPromptAndHistory,
            maxContextAssemblyBudget: this._maxAssemblyBudget,
            usedTokens,
            remainingTokens: Math.max(0, this._maxAssemblyBudget - usedTokens),
            explicitTokens,
            automaticTokens,
            omittedCount,
            truncatedCount
        };

        return {
            allocatedCandidates,
            budget,
            warnings
        };
    }
}

/**
 * Core type definitions for the Your +1 Context Assembly Engine (Milestone 3).
 */

export type ContextSourceType =
    | 'explicit_file'
    | 'explicit_symbol'
    | 'automatic_keyword'
    | 'automatic_symbol'
    | 'automatic_active_editor';

export type ContextCandidateStatus =
    | 'included'
    | 'truncated'
    | 'omitted_budget';

export interface ContextCandidate {
    id: string;
    filePath: string;
    symbolName?: string;
    source: ContextSourceType;
    selectionReason: string;
    startLine: number;
    endLine: number;
    content: string;
    estimatedTokens: number;
    tokenEstimationMethod: 'exact' | 'heuristic_char_div_4';
    relevanceScore: number;
    status: ContextCandidateStatus;
    omissionReason?: string;
}

export interface ContextBudget {
    modelContextLength: number;
    maxOutputTokens: number;
    reservedForPromptAndHistory: number;
    maxContextAssemblyBudget: number;
    usedTokens: number;
    remainingTokens: number;
    explicitTokens: number;
    automaticTokens: number;
    omittedCount: number;
    truncatedCount: number;
}

export interface ExplicitReference {
    type: 'file' | 'symbol';
    rawMatch: string;
    target: string;
    resolved: boolean;
    resolvedPath?: string;
    symbolName?: string;
    lineRange?: { start: number; end: number };
    error?: string;
    rationale?: string;
}

export interface ActiveEditorContext {
    filePath: string;
    visibleRange?: { startLine: number; endLine: number };
    selectedText?: string;
    selectionRange?: { startLine: number; endLine: number };
}

export interface ContextAssemblyOptions {
    workspaceRoot: string;
    maxBudgetTokens?: number;
    modelContextLength?: number;
    maxOutputTokens?: number;
    activeEditor?: ActiveEditorContext;
    maxAutomaticCandidates?: number;
    logger?: (message: string) => void;
}

export interface AssembledContextResult {
    originalPrompt: string;
    cleanedPrompt: string;
    candidates: ContextCandidate[];
    budget: ContextBudget;
    formattedContext: string;
    unresolvedReferences: string[];
    warnings: string[];
}

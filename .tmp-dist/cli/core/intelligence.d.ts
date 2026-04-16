import { ProviderResponse } from '../../providers/types.js';
type MemoryKind = 'tool' | 'summary';
interface MemoryItem {
    kind: MemoryKind;
    source: string;
    content: string;
    keywords: string[];
    ts: number;
}
export declare class HarnessMemory {
    private readonly maxItems;
    private items;
    constructor(maxItems?: number);
    addToolResult(toolName: string, args: any, result: string): void;
    addSummary(label: string, content: string): void;
    retrieve(query: string, limit?: number): MemoryItem[];
    private add;
}
export type ContinuityMode = 'general' | 'redesign' | 'create';
export declare class TaskContinuityTracker {
    private activeObjective;
    private mode;
    private focusedFiles;
    private explicitTurnFiles;
    private followupTurn;
    private turnAllowsCreate;
    private readonly maxFocusedFiles;
    reset(): void;
    onUserInput(input: string): void;
    setExplicitTurnFiles(files: string[]): void;
    onToolResult(toolName: string, args: any, result: string): void;
    getMode(): ContinuityMode;
    getFocusedFiles(): string[];
    getExplicitTurnFiles(): string[];
    buildHints(): string[];
    buildContextBlock(): string;
    validateToolCall(call: {
        name: string;
        args: any;
    }): string | null;
    private isFollowup;
    private addFocusedFile;
}
export declare function isHeavyTask(input: string): boolean;
export declare function buildPlanningRequest(userInput: string): string;
export declare function buildPolicyHints(userInput: string): string[];
export declare function buildMemoryContext(userInput: string, memory: HarnessMemory): string;
export declare function injectHarnessContext(userInput: string, memoryContext: string, policyHints: string[]): string;
export declare function shouldSelfCritique(response: ProviderResponse, userInput: string): boolean;
export declare function buildSelfCritiquePrompt(userInput: string, previousAnswer: string): string;
export declare function validateToolCall(call: {
    name: string;
    args: any;
}, toolDefs: any[]): string | null;
export {};
//# sourceMappingURL=intelligence.d.ts.map
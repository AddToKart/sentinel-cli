export declare function readProjectContext(): string;
export declare function composeSystemPrompt(projectContext: string, contextHeader: string): string;
export interface MentionContextResult {
    content: string;
    loadedFiles: string[];
}
export declare function injectMentionedContextWithMetadata(input: string): Promise<MentionContextResult>;
export declare function injectMentionedContext(input: string): Promise<string>;
//# sourceMappingURL=context.d.ts.map
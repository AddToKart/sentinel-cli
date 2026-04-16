export interface ToolDefinition {
    name: string;
    description: string;
    parameters: any;
    execute: (args: any) => Promise<string>;
    displayName?: string;
    getLabel?: (args: any) => string;
    requiresConfirmation?: boolean;
    getRiskSummary?: (args: any) => string;
}
/** Generate a simple inline diff between old and new content */
export declare function generateDiff(oldContent: string, newContent: string, filePath: string): string;
export declare const shellTool: ToolDefinition;
export declare const readFileTool: ToolDefinition;
export declare const writeFileTool: ToolDefinition;
export declare const editFileTool: ToolDefinition;
export declare const grepTool: ToolDefinition;
export declare const globTool: ToolDefinition;
export declare const webFetchTool: ToolDefinition;
export declare const listDirTool: ToolDefinition;
export declare const readCodebaseTool: ToolDefinition;
export declare const askUserTool: ToolDefinition;
export declare const tools: ToolDefinition[];
//# sourceMappingURL=index.d.ts.map
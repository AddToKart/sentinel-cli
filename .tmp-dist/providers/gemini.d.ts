import { AIProvider, Message, ProviderResponse } from './types.js';
export declare class GeminiProvider implements AIProvider {
    name: string;
    private genAI;
    private modelName;
    constructor(apiKey: string, modelName?: string);
    private buildModel;
    sendMessage(messages: Message[], tools?: any[]): Promise<ProviderResponse>;
    streamMessage(messages: Message[], tools: any[], onChunk: (text: string) => void): Promise<ProviderResponse>;
}
//# sourceMappingURL=gemini.d.ts.map
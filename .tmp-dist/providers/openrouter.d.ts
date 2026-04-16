import { AIProvider, Message, ProviderResponse } from './types.js';
export declare class OpenRouterProvider implements AIProvider {
    name: string;
    private apiKey;
    private modelName;
    constructor(apiKey: string, modelName: string);
    sendMessage(messages: Message[], tools?: any[]): Promise<ProviderResponse>;
    streamMessage(messages: Message[], tools: any[], onChunk: (text: string) => void): Promise<ProviderResponse>;
}
//# sourceMappingURL=openrouter.d.ts.map
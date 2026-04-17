export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface ProviderResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    args: any;
    id: string;
  }>;
}

export interface ProviderRequestOptions {
  maxRetries?: number;
}

export interface AIProvider {
  name: string;
  sendMessage(messages: Message[], tools?: any[], options?: ProviderRequestOptions): Promise<ProviderResponse>;
  streamMessage?(
    messages: Message[],
    tools: any[],
    onChunk: (text: string) => void,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse>;
}

import axios from 'axios';
import chalk from 'chalk';
import { AIProvider, Message, ProviderRequestOptions, ProviderResponse } from './types.js';
import { formatOpenAIToolMessages, formatOpenAITools, normalizeToolCall, withProviderRetries } from './utils.js';

export interface CustomProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class CustomProvider implements AIProvider {
  name: string;
  private baseUrl: string;
  private modelName: string;
  private apiKey: string;

  constructor(config: CustomProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.modelName = config.model;
    this.apiKey = config.apiKey;

    // Security: warn if using plain HTTP (API keys sent in cleartext)
    if (this.baseUrl.startsWith('http://') && !this.baseUrl.includes('localhost') && !this.baseUrl.includes('127.0.0.1')) {
      process.stderr.write(chalk.yellow(`\n  ⚠ Security warning: ${this.name} uses HTTP (not HTTPS).`));
      process.stderr.write(chalk.yellow(`\n    API keys will be sent in cleartext over the network.`));
      process.stderr.write(chalk.yellow(`\n    Consider using HTTPS or a local connection.\n\n`));
    }
  }

  private getEndpoint(): string {
    const chatEndpoint = this.baseUrl.includes('chat/completions')
      ? this.baseUrl
      : `${this.baseUrl}/chat/completions`;
    // Normalize: if base already has /v1, don't double it
    if (!chatEndpoint.includes('chat/completions')) {
      // Try common patterns
      if (this.baseUrl.endsWith('/v1')) return `${this.baseUrl}/chat/completions`;
      return `${this.baseUrl}/v1/chat/completions`;
    }
    return chatEndpoint;
  }

  private getHeaders() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Sentinel-CLI/1.0',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildPayload(messages: Message[], tools?: any[], stream: boolean = false) {
    const payload: any = {
      model: this.modelName,
      messages: formatOpenAIToolMessages(messages),
      ...(stream ? { stream: true } : {}),
    };
    const formattedTools = formatOpenAITools(tools);
    if (formattedTools && formattedTools.length > 0) {
      payload.tools = formattedTools;
      payload.tool_choice = 'auto';
    }
    return payload;
  }

  private normalizeChoiceResponse(message: any): ProviderResponse {
    if (!message) throw new Error('Custom provider returned an empty message payload.');
    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        content: message.content || '',
        toolCalls: message.tool_calls.map((call: any, index: number) =>
          normalizeToolCall(call.function?.name, call.function?.arguments, call.id, this.name, index)
        ),
      };
    }
    return { content: message.content || '' };
  }

  private wrapError(error: any): never {
    if (axios.isAxiosError(error) && error.response) {
      const data = error.response.data as any;
      const msg = data?.error?.message || JSON.stringify(data).slice(0, 200);
      const code = data?.error?.code || error.response.status;
      throw new Error(`${this.name} [${code}]: ${msg}`);
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
      throw new Error(`${this.name}: Connection refused — check that the base URL is correct and the service is running.`);
    }
    throw error;
  }

  async sendMessage(messages: Message[], tools?: any[], options: ProviderRequestOptions = {}): Promise<ProviderResponse> {
    return withProviderRetries(async () => {
      try {
        const response = await axios.post(
          this.getEndpoint(),
          this.buildPayload(messages, tools, false),
          { headers: this.getHeaders(), timeout: 60_000 }
        );
        const choice = response.data?.choices?.[0];
        if (!choice) throw new Error(`${this.name}: no choices returned. Raw: ${JSON.stringify(response.data).slice(0, 200)}`);
        return this.normalizeChoiceResponse(choice.message);
      } catch (error: any) {
        this.wrapError(error);
      }
    }, options.maxRetries ?? 2);
  }

  async streamMessage(messages: Message[], tools: any[], onChunk: (text: string) => void, options: ProviderRequestOptions = {}): Promise<ProviderResponse> {
    return withProviderRetries(async () => {
      try {
        const response = await axios.post(
          this.getEndpoint(),
          this.buildPayload(messages, tools, true),
          { headers: this.getHeaders(), responseType: 'stream', timeout: 120_000 }
        );

        let fullText = '';
        const toolAccum: Map<number, { id: string; name: string; arguments: string }> = new Map();
        let buffer = '';

        const applyDelta = (delta: any) => {
          if (!delta) return;
          if (delta.content) { onChunk(delta.content); fullText += delta.content; }
          if (delta.tool_calls) {
            for (const call of delta.tool_calls) {
              const index = call.index ?? 0;
              if (!toolAccum.has(index)) toolAccum.set(index, { id: '', name: '', arguments: '' });
              const acc = toolAccum.get(index)!;
              if (call.id) acc.id = call.id;
              if (call.function?.name) acc.name = call.function.name;
              if (call.function?.arguments) acc.arguments += call.function.arguments;
            }
          }
        };

        const handleLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) return;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          try { applyDelta(JSON.parse(data).choices?.[0]?.delta); } catch { /* skip */ }
        };

        for await (const raw of response.data) {
          buffer += raw.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) handleLine(line);
        }
        if (buffer.trim().length > 0) handleLine(buffer);

        if (toolAccum.size > 0) {
          return {
            content: fullText,
            toolCalls: [...toolAccum.values()].map((call, i) =>
              normalizeToolCall(call.name, call.arguments, call.id, `${this.name}-stream`, i)
            ),
          };
        }
        return { content: fullText };
      } catch (error: any) { this.wrapError(error); }
    }, options.maxRetries ?? 2);
  }

  /**
   * Validates the connection by sending a simple test message.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const testMessages: Message[] = [{ role: 'user', content: 'Reply with exactly "OK" if you receive this.' }];
      const resp = await this.sendMessage(testMessages, [], { maxRetries: 0 });
      if (resp.content && resp.content.length > 0) return { ok: true, message: resp.content.slice(0, 100) };
      return { ok: false, message: 'Empty response received.' };
    } catch (err: any) {
      return { ok: false, message: err.message || String(err) };
    }
  }
}

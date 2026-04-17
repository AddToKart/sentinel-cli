import axios from 'axios';
import { AIProvider, Message, ProviderRequestOptions, ProviderResponse } from './types.js';
import { formatOpenAIToolMessages, formatOpenAITools, normalizeToolCall, withProviderRetries } from './utils.js';

export class OpenRouterProvider implements AIProvider {
  name = 'openrouter';
  private apiKey: string;
  private modelName: string;

  constructor(apiKey: string, modelName: string) {
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  private getHeaders() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/sentinel/sentinel-cli',
      'X-Title': 'Sentinel CLI',
      'Content-Type': 'application/json'
    };
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
    if (!message) {
      throw new Error('OpenRouter returned an empty message payload.');
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        content: message.content || '',
        toolCalls: message.tool_calls.map((call: any, index: number) =>
          normalizeToolCall(call.function?.name, call.function?.arguments, call.id, 'openrouter', index)
        ),
      };
    }

    return { content: message.content || '' };
  }

  private wrapError(error: any): never {
    if (error.response) {
      const data = error.response.data;
      const msg = data?.error?.message || JSON.stringify(data);
      const code = data?.error?.code || error.response.status;
      throw new Error(`OpenRouter [${code}]: ${msg}`);
    }
    throw error;
  }

  async sendMessage(messages: Message[], tools?: any[], options: ProviderRequestOptions = {}): Promise<ProviderResponse> {
    return withProviderRetries(async () => {
      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          this.buildPayload(messages, tools, false),
          { headers: this.getHeaders() }
        );

        const choice = response.data?.choices?.[0];
        if (!choice) {
          throw new Error(`OpenRouter returned no choices. Raw: ${JSON.stringify(response.data)}`);
        }

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
          'https://openrouter.ai/api/v1/chat/completions',
          this.buildPayload(messages, tools, true),
          {
            headers: this.getHeaders(),
            responseType: 'stream',
          }
        );

        let fullText = '';
        const toolAccum: Map<number, { id: string; name: string; arguments: string }> = new Map();
        let buffer = '';

        const applyDelta = (delta: any) => {
          if (!delta) return;
          if (delta.content) {
            onChunk(delta.content);
            fullText += delta.content;
          }
          if (delta.tool_calls) {
            for (const call of delta.tool_calls) {
              const index = call.index ?? 0;
              if (!toolAccum.has(index)) {
                toolAccum.set(index, { id: call.id || '', name: '', arguments: '' });
              }
              const acc = toolAccum.get(index)!;
              if (call.id) acc.id = call.id;
              if (call.function?.name) acc.name = call.function.name;
              if (call.function?.arguments) acc.arguments += call.function.arguments;
            }
          }
        };

        const handleDataLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) return;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            applyDelta(delta);
          } catch {
            return;
          }
        };

        for await (const raw of response.data) {
          buffer += raw.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            handleDataLine(line);
          }
        }

        // Some providers may end without a trailing newline; parse remaining buffered line.
        if (buffer.trim().length > 0) {
          handleDataLine(buffer);
        }

        if (toolAccum.size > 0) {
          return {
            content: fullText,
            toolCalls: [...toolAccum.values()].map((call, index) =>
              normalizeToolCall(call.name, call.arguments, call.id, 'openrouter-stream', index)
            ),
          };
        }

        return { content: fullText };
      } catch (error: any) {
        this.wrapError(error);
      }
    }, options.maxRetries ?? 2);
  }
}

import { Message } from './types.js';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatOpenAIToolMessages(messages: Message[]) {
  return messages.map(msg => {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.tool_call_id || msg.name,
      };
    }

    return {
      role: msg.role,
      content: msg.content || '',
      ...(msg.tool_calls && msg.tool_calls.length > 0 ? {
        tool_calls: msg.tool_calls.map((call: any, index: number) => ({
          id: call.id || `${call.name || 'tool'}-${index}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args || {}),
          }
        }))
      } : {})
    };
  });
}

export function formatOpenAITools(tools?: any[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }
  }));
}

export function parseToolArguments(raw: unknown): any {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { _raw: trimmed };
  }
}

export function normalizeToolCall(name: string, args: unknown, id: string | undefined, fallbackPrefix: string, index: number) {
  return {
    name,
    args: parseToolArguments(args),
    id: id || `${fallbackPrefix}-${name}-${index}`,
  };
}

export function isRetryableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(408|409|425|429|500|502|503|504)\b/.test(message)
    || /\b(timeout|timed out|temporar|rate limit|connection reset|econnreset|socket hang up|network)\b/i.test(message);
}

export async function withProviderRetries<T>(task: () => Promise<T>, maxRetries: number = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableProviderError(error)) {
        throw error;
      }
      await sleep(350 * (attempt + 1));
    }
  }

  throw lastError;
}

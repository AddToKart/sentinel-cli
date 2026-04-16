import axios from 'axios';
export class OpenRouterProvider {
    name = 'openrouter';
    apiKey;
    modelName;
    constructor(apiKey, modelName) {
        this.apiKey = apiKey;
        this.modelName = modelName;
    }
    async sendMessage(messages, tools) {
        const formattedMessages = messages.map(msg => {
            if (msg.role === 'tool') {
                return {
                    role: 'tool',
                    content: msg.content,
                    tool_call_id: msg.tool_call_id || msg.name, // OpenRouter requires tool_call_id
                };
            }
            return {
                role: msg.role,
                content: msg.content || '',
                ...(msg.tool_calls && msg.tool_calls.length > 0 ? {
                    tool_calls: msg.tool_calls.map((c) => ({
                        id: c.id,
                        type: 'function',
                        function: {
                            name: c.name,
                            arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {})
                        }
                    }))
                } : {})
            };
        });
        const openRouterTools = tools ? tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            }
        })) : undefined;
        const payload = {
            model: this.modelName,
            messages: formattedMessages,
        };
        if (openRouterTools && openRouterTools.length > 0) {
            payload.tools = openRouterTools;
            payload.tool_choice = 'auto';
        }
        try {
            const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', payload, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': 'https://github.com/sentinel/sentinel-cli', // Optional, for OpenRouter rankings
                    'X-Title': 'Sentinel CLI', // Optional, for OpenRouter rankings
                    'Content-Type': 'application/json'
                }
            });
            const choices = response.data.choices;
            if (!choices || choices.length === 0) {
                throw new Error(`OpenRouter returned no choices. Potential moderation filter or model error. Raw: ${JSON.stringify(response.data)}`);
            }
            const choice = choices[0];
            const message = choice.message;
            if (!message) {
                throw new Error(`OpenRouter choice has no message body. Raw: ${JSON.stringify(choice)}`);
            }
            if (message.tool_calls && message.tool_calls.length > 0) {
                return {
                    content: message.content || '',
                    toolCalls: message.tool_calls.map((c) => ({
                        name: c.function.name,
                        args: JSON.parse(c.function.arguments),
                        id: c.id,
                    })),
                };
            }
            return {
                content: message.content || '',
            };
        }
        catch (error) {
            if (error.response) {
                const data = error.response.data;
                const msg = data?.error?.message || JSON.stringify(data);
                const code = data?.error?.code || error.response.status;
                throw new Error(`OpenRouter [${code}]: ${msg}`);
            }
            throw error;
        }
    }
    async streamMessage(messages, tools, onChunk) {
        const formattedMessages = messages.map(msg => {
            if (msg.role === 'tool')
                return { role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id || msg.name };
            return {
                role: msg.role, content: msg.content || '',
                ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}) } })) } : {}),
            };
        });
        const openRouterTools = tools?.length ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined;
        const payload = { model: this.modelName, messages: formattedMessages, stream: true };
        if (openRouterTools?.length) {
            payload.tools = openRouterTools;
            payload.tool_choice = 'auto';
        }
        try {
            const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', payload, {
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'X-Title': 'Sentinel CLI', 'Content-Type': 'application/json' },
                responseType: 'stream',
            });
            let fullText = '';
            const toolAccum = new Map();
            let buffer = '';
            for await (const raw of response.data) {
                buffer += raw.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? ''; // keep incomplete line
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: '))
                        continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]')
                        continue;
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        if (!delta)
                            continue;
                        if (delta.content) {
                            onChunk(delta.content);
                            fullText += delta.content;
                        }
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                if (!toolAccum.has(idx))
                                    toolAccum.set(idx, { id: tc.id || '', name: '', arguments: '' });
                                const acc = toolAccum.get(idx);
                                if (tc.id)
                                    acc.id = tc.id;
                                if (tc.function?.name)
                                    acc.name = tc.function.name;
                                if (tc.function?.arguments)
                                    acc.arguments += tc.function.arguments;
                            }
                        }
                    }
                    catch { /* skip malformed */ }
                }
            }
            if (toolAccum.size > 0) {
                const toolCalls = [...toolAccum.values()].map(tc => {
                    let args = {};
                    try {
                        args = JSON.parse(tc.arguments);
                    }
                    catch {
                        args = tc.arguments;
                    }
                    return { name: tc.name, args, id: tc.id };
                });
                return { content: fullText, toolCalls };
            }
            return { content: fullText };
        }
        catch (error) {
            if (error.response) {
                const data = error.response.data;
                const msg = data?.error?.message || JSON.stringify(data);
                const code = data?.error?.code || error.response.status;
                throw new Error(`OpenRouter [${code}]: ${msg}`);
            }
            throw error;
        }
    }
}
//# sourceMappingURL=openrouter.js.map
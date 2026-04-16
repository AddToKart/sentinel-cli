import { GoogleGenerativeAI, Tool, Content } from '@google/generative-ai';
import { AIProvider, Message, ProviderResponse } from './types.js';

export class GeminiProvider implements AIProvider {
  name = 'gemini';
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(apiKey: string, modelName: string = 'gemini-1.5-pro') {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  private buildModel(messages: Message[], tools: any[]) {
    const geminiTools: Tool[] = tools?.length ? [{
      functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
    }] : [];
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');
    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      tools: geminiTools,
      ...(systemMsg ? { systemInstruction: { role: 'system', parts: [{ text: systemMsg.content }] } } : {}),
    });
    const history: Content[] = chatMessages.slice(0, -1).map(msg => {
      if (msg.role === 'tool') {
        return { role: 'function', parts: [{ functionResponse: { name: msg.name || '', response: { content: msg.content } } }] };
      }
      return { role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] };
    });
    const lastMessage = chatMessages[chatMessages.length - 1];
    if (!lastMessage) throw new Error('No messages provided');
    return { model, history, lastMessage };
  }

  async sendMessage(messages: Message[], tools: any[] = []): Promise<ProviderResponse> {
    const { model, history, lastMessage } = this.buildModel(messages, tools);
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage.content);
    const response = await result.response;
    const calls = response.functionCalls();
    if (calls && calls.length > 0) {
      return {
        content: response.text() || '',
        toolCalls: calls.map((c: any) => ({ name: c.name, args: c.args, id: c.name })),
      };
    }
    return { content: response.text() };
  }

  async streamMessage(messages: Message[], tools: any[], onChunk: (text: string) => void): Promise<ProviderResponse> {
    const { model, history, lastMessage } = this.buildModel(messages, tools);
    const chat = model.startChat({ history });
    const streamResult = await chat.sendMessageStream(lastMessage.content);

    let fullText = '';
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) { onChunk(text); fullText += text; }
    }

    const finalResponse = await streamResult.response;
    const calls = finalResponse.functionCalls();
    if (calls && calls.length > 0) {
      return { content: fullText, toolCalls: calls.map((c: any) => ({ name: c.name, args: c.args, id: c.name })) };
    }
    return { content: fullText };
  }
}

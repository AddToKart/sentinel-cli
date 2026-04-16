import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { AIProvider } from './types.js';
import { Config } from '../config/index.js';

export class ProviderFactory {
  static getProvider(providerName: string, config: Config, modelOverride?: string): AIProvider {
    switch (providerName) {
      case 'gemini':
        if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
        const geminiModel = modelOverride || config.GEMINI_MODEL || 'gemini-1.5-pro';
        return new GeminiProvider(config.GEMINI_API_KEY, geminiModel);
      case 'openrouter':
        if (!(config as any).OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
        const openrouterModel = modelOverride || (config as any).OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
        return new OpenRouterProvider((config as any).OPENROUTER_API_KEY, openrouterModel);
      case 'openai':
        if (!(config as any).OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
        throw new Error(`Coming soon! Provider ${providerName} is not yet implemented.`);
      case 'anthropic':
        if (!(config as any).ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
        throw new Error(`Coming soon! Provider ${providerName} is not yet implemented.`);
      default:
        throw new Error(`Unsupported provider: ${providerName}`);
    }
  }
}

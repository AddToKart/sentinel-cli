import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { AIProvider } from './types.js';
import { Config } from '../config/index.js';

export const SUPPORTED_PROVIDERS = ['gemini', 'openrouter'] as const;
export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

export function isSupportedProvider(providerName: string): providerName is SupportedProvider {
  return SUPPORTED_PROVIDERS.includes(providerName as SupportedProvider);
}

export class ProviderFactory {
  static getProvider(providerName: string, config: Config, modelOverride?: string): AIProvider {
    if (!isSupportedProvider(providerName)) {
      throw new Error(`Unsupported provider: ${providerName}. Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
    }

    switch (providerName) {
      case 'gemini':
        if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
        const geminiModel = modelOverride || config.GEMINI_MODEL || 'gemini-1.5-pro';
        return new GeminiProvider(config.GEMINI_API_KEY, geminiModel);
      case 'openrouter':
        if (!(config as any).OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
        const openrouterModel = modelOverride || (config as any).OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
        return new OpenRouterProvider((config as any).OPENROUTER_API_KEY, openrouterModel);
      default:
        throw new Error(`Unsupported provider: ${providerName}. Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`);
    }
  }
}

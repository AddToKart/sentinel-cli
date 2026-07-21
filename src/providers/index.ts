import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { CustomProvider, CustomProviderConfig } from './custom.js';
import { AIProvider } from './types.js';
import { Config, getCustomProvider } from '../config/index.js';

export { CustomProvider } from './custom.js';
export type { CustomProviderConfig } from './custom.js';

export const SUPPORTED_PROVIDERS = ['gemini', 'openrouter'] as const;
export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

export function isSupportedProvider(providerName: string): boolean {
  if (SUPPORTED_PROVIDERS.includes(providerName as SupportedProvider)) return true;
  // Check if it's a registered custom provider
  const custom = getCustomProvider(providerName);
  return custom !== undefined;
}

export class ProviderFactory {
  static getProvider(providerName: string, config: Config, modelOverride?: string): AIProvider {
    // Check built-in providers first
    switch (providerName) {
      case 'gemini':
        if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
        const geminiModel = modelOverride || config.GEMINI_MODEL || 'gemini-1.5-pro';
        return new GeminiProvider(config.GEMINI_API_KEY, geminiModel);
      case 'openrouter':
        if (!(config as any).OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
        const openrouterModel = modelOverride || (config as any).OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
        return new OpenRouterProvider((config as any).OPENROUTER_API_KEY, openrouterModel);
    }

    // Check custom providers
    const customEntry = getCustomProvider(providerName);
    if (customEntry) {
      const customConfig: CustomProviderConfig = {
        name: customEntry.name,
        baseUrl: customEntry.baseUrl,
        model: modelOverride || customEntry.model,
        apiKey: customEntry.apiKey,
      };
      return new CustomProvider(customConfig);
    }

    throw new Error(`Unknown provider: "${providerName}". Use /connect to add custom providers. Supported built-in: ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
}

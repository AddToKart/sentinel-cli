import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
export class ProviderFactory {
    static getProvider(providerName, config, modelOverride) {
        switch (providerName) {
            case 'gemini':
                if (!config.GEMINI_API_KEY)
                    throw new Error('GEMINI_API_KEY not set');
                const geminiModel = modelOverride || config.GEMINI_MODEL || 'gemini-1.5-pro';
                return new GeminiProvider(config.GEMINI_API_KEY, geminiModel);
            case 'openrouter':
                if (!config.OPENROUTER_API_KEY)
                    throw new Error('OPENROUTER_API_KEY not set');
                const openrouterModel = modelOverride || config.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
                return new OpenRouterProvider(config.OPENROUTER_API_KEY, openrouterModel);
            case 'openai':
                if (!config.OPENAI_API_KEY)
                    throw new Error('OPENAI_API_KEY not set');
                throw new Error(`Coming soon! Provider ${providerName} is not yet implemented.`);
            case 'anthropic':
                if (!config.ANTHROPIC_API_KEY)
                    throw new Error('ANTHROPIC_API_KEY not set');
                throw new Error(`Coming soon! Provider ${providerName} is not yet implemented.`);
            default:
                throw new Error(`Unsupported provider: ${providerName}`);
        }
    }
}
//# sourceMappingURL=index.js.map
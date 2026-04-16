import { z } from 'zod';
declare const configSchema: z.ZodObject<{
    GEMINI_API_KEY: z.ZodOptional<z.ZodString>;
    OPENAI_API_KEY: z.ZodOptional<z.ZodString>;
    ANTHROPIC_API_KEY: z.ZodOptional<z.ZodString>;
    OPENROUTER_API_KEY: z.ZodOptional<z.ZodString>;
    OLLAMA_HOST: z.ZodDefault<z.ZodString>;
    DEFAULT_PROVIDER: z.ZodDefault<z.ZodEnum<{
        gemini: "gemini";
        openai: "openai";
        anthropic: "anthropic";
        openrouter: "openrouter";
        ollama: "ollama";
    }>>;
    GEMINI_MODEL: z.ZodDefault<z.ZodString>;
    OPENAI_MODEL: z.ZodDefault<z.ZodString>;
    ANTHROPIC_MODEL: z.ZodDefault<z.ZodString>;
    OPENROUTER_MODEL: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type Config = z.infer<typeof configSchema>;
export declare function loadConfig(): Config;
export declare function saveConfig(newConfig: Partial<Config>): void;
export {};
//# sourceMappingURL=index.d.ts.map
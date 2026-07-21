/**
 * Tracks token usage and estimated costs across the session.
 */

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface CostEntry {
  provider: string;
  model: string;
  usage: TokenUsage;
  estimatedCost: number;
  timestamp: number;
}

// Cost per 1K tokens (approximate, varies by provider/model)
const COST_TABLE: Record<string, { input: number; output: number }> = {
  'gemini-2.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
  'gemini-3.1-pro-preview': { input: 0.00125, output: 0.005 },
  'gemini-3-flash-preview': { input: 0.00015, output: 0.0006 },
  'gemini-3.1-flash-lite-preview': { input: 0.000075, output: 0.0003 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
  // OpenRouter rates vary — use a default
  'openrouter-default': { input: 0.0005, output: 0.0015 },
};

const sessionHistory: CostEntry[] = [];
let sessionPromptTokens = 0;
let sessionCompletionTokens = 0;

function getCostRate(model: string): { input: number; output: number } {
  return COST_TABLE[model] ?? COST_TABLE['openrouter-default']!;
}

/**
 * Record token usage from a response.
 */
export function recordUsage(provider: string, model: string, promptTokens: number, completionTokens: number): void {
  const rates = getCostRate(model);
  const estimatedCost = (promptTokens / 1000) * rates.input + (completionTokens / 1000) * rates.output;

  sessionPromptTokens += promptTokens;
  sessionCompletionTokens += completionTokens;

  sessionHistory.push({
    provider,
    model,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    estimatedCost,
    timestamp: Date.now(),
  });
}

/**
 * Get total session token usage.
 */
export function getSessionTokens(): { prompt: number; completion: number; total: number } {
  return {
    prompt: sessionPromptTokens,
    completion: sessionCompletionTokens,
    total: sessionPromptTokens + sessionCompletionTokens,
  };
}

/**
 * Get total estimated cost for the session.
 */
export function getSessionCost(): number {
  return sessionHistory.reduce((sum, e) => sum + e.estimatedCost, 0);
}

/**
 * Get the number of API calls made.
 */
export function getApiCallCount(): number {
  return sessionHistory.length;
}

/**
 * Estimate tokens from text (rough: 4 chars ≈ 1 token).
 */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Estimate cost for a given text and model.
 */
export function estimateCost(text: string, model: string, isOutput: boolean = true): number {
  const tokens = estimateTokens(text);
  const rates = getCostRate(model);
  const rate = isOutput ? rates.output : rates.input;
  return (tokens / 1000) * rate;
}

/**
 * Get a formatted cost summary string.
 */
export function getCostSummary(model: string): string {
  const { prompt, completion, total } = getSessionTokens();
  const cost = getSessionCost();
  const calls = getApiCallCount();
  const costStr = cost < 0.01 ? '<$0.01' : `$${cost.toFixed(4)}`;
  return `${calls} calls | ${(total / 1000).toFixed(1)}K tokens | ~${costStr}`;
}

/**
 * Reset session tracking.
 */
export function resetTracker(): void {
  sessionHistory.length = 0;
  sessionPromptTokens = 0;
  sessionCompletionTokens = 0;
}

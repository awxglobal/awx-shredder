/**
 * Per-token pricing for OpenAI models.
 * Prices are USD per single token (not per 1 000 or 1 M tokens).
 *
 * Update these when OpenAI changes rates — a constants file is intentional,
 * so a 1-line change here ripples through both estimate and finalize.
 *
 * Sources (2025-04):
 *   https://openai.com/pricing
 */

export interface ModelPricing {
  /** USD per input token  */
  input: number;
  /** USD per output / completion token */
  output: number;
}

/**
 * Known model prices. Keys are the exact model strings OpenAI accepts,
 * including common aliases.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // GPT-4o family  — $2.50 / $10.00 per 1M tokens
  'gpt-4o':                  { input: 0.0000025,  output: 0.000010 },
  'gpt-4o-2024-11-20':       { input: 0.0000025,  output: 0.000010 },
  'gpt-4o-2024-08-06':       { input: 0.0000025,  output: 0.000010 },
  'gpt-4o-2024-05-13':       { input: 0.000005,   output: 0.000015 },

  // GPT-4o mini  — $0.15 / $0.60 per 1M tokens
  'gpt-4o-mini':             { input: 0.00000015, output: 0.0000006 },
  'gpt-4o-mini-2024-07-18':  { input: 0.00000015, output: 0.0000006 },

  // GPT-4 Turbo  — $10 / $30 per 1M tokens
  'gpt-4-turbo':             { input: 0.000010,   output: 0.000030 },
  'gpt-4-turbo-preview':     { input: 0.000010,   output: 0.000030 },

  // GPT-3.5 Turbo  — $0.50 / $1.50 per 1M tokens
  'gpt-3.5-turbo':           { input: 0.0000005,  output: 0.0000015 },
  'gpt-3.5-turbo-0125':      { input: 0.0000005,  output: 0.0000015 },
};

/** Fallback when the model is not in the table (use gpt-4o rates — conservative). */
const FALLBACK_PRICING: ModelPricing = { input: 0.0000025, output: 0.000010 };

export function getPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? FALLBACK_PRICING;
}

/**
 * Rough input-token count from raw message text.
 * Rule of thumb: 4 chars ≈ 1 token (works well for English prose).
 */
export function estimateInputTokens(
  messages: Array<{ role: string; content: unknown }>,
): number {
  const totalChars = messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return (
        sum +
        (m.content as Array<{ text?: string }>).reduce(
          (s, part) => s + (part.text?.length ?? 0),
          0,
        )
      );
    }
    return sum;
  }, 0);
  return Math.max(1, Math.ceil(totalChars / 4));
}

/** Pre-call cost estimate: only input tokens × input rate (output unknown yet). */
export function estimateCost(model: string, inputTokens: number): number {
  return inputTokens * getPricing(model).input;
}

/** Post-call cost from OpenAI's usage object. */
export function computeActualCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = getPricing(model);
  return promptTokens * p.input + completionTokens * p.output;
}

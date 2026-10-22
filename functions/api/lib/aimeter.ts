/**
 * The AI token ledger (/admin → AI). Every model call lands in `ai_usage`: who asked, which feature, which model,
 * how many tokens, how many neurons, what it cost us.
 *
 * Adding an AI feature later needs ONE thing: call the model through `ask()` in lib/ai.ts (or call recordAiUsage()
 * yourself next to your own env.AI.run). To say who the spend belongs to, wrap env first:
 *     const e = withAiContext(env, { userId, tool: 'my-feature' });
 * Without a context the call is still counted, under the tool "unattributed".
 *
 * Metering is best effort: a failure to write the ledger never breaks the AI feature itself.
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface AiContext {
  userId: string | null;
  tool: string;
}

/** Returns a copy of env that carries who / what the AI calls made with it are for. */
export function withAiContext<E extends object>(env: E, ctx: AiContext): E & { __ai: AiContext } {
  return { ...env, __ai: ctx };
}
export const contextOf = (env: unknown): AiContext | undefined => (env as { __ai?: AiContext }).__ai;

interface Price {
  inputUsdPerM: number;
  outputUsdPerM: number;
  inputNeuronsPerM: number;
  outputNeuronsPerM: number;
}
let prices: { at: number; map: Map<string, Price> } | null = null;
export const invalidateAiPrices = (): void => {
  prices = null;
};

export async function priceOf(env: { DB: D1Database }, model: string): Promise<Price | null> {
  if (!prices || Date.now() - prices.at > 60_000) {
    const map = new Map<string, Price>();
    try {
      const { results } = await env.DB
        .prepare('SELECT model, input_usd_per_m, output_usd_per_m, input_neurons_per_m, output_neurons_per_m FROM ai_prices')
        .all<{ model: string; input_usd_per_m: number; output_usd_per_m: number; input_neurons_per_m: number; output_neurons_per_m: number }>();
      for (const r of results) map.set(r.model, { inputUsdPerM: r.input_usd_per_m, outputUsdPerM: r.output_usd_per_m, inputNeuronsPerM: r.input_neurons_per_m, outputNeuronsPerM: r.output_neurons_per_m });
    } catch {
      /* table missing: tokens are still counted, just without a price */
    }
    prices = { at: Date.now(), map };
  }
  return prices.map.get(model) ?? null;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
/** ~4 characters per token: only used when the provider reports nothing. */
const guess = (chars: number): number => Math.ceil(chars / 4);

export interface AiCall {
  model: string;
  /** what the provider answered with, to read its `usage` { prompt_tokens, completion_tokens } from */
  output?: unknown;
  /** characters sent / received, for the guess when there is no `usage` */
  inputChars: number;
  outputChars: number;
  /** false = the feature got no usable answer (tokens that were reported still count as spend) */
  ok: boolean;
  ms: number;
}

export async function recordAiUsage(env: { DB: D1Database }, ctx: AiContext | undefined, call: AiCall): Promise<void> {
  try {
    const u = call.output && typeof call.output === 'object' ? ((call.output as { usage?: unknown }).usage as Record<string, unknown> | undefined) : undefined;
    const reportedIn = count(u?.prompt_tokens);
    const reportedOut = count(u?.completion_tokens);
    const answered = call.ok || call.outputChars > 0 || reportedIn !== null || reportedOut !== null;
    // no answer at all (error / timeout): nothing is known to have been billed
    const estimated = answered && (reportedIn === null || reportedOut === null);
    const input = !answered ? 0 : (reportedIn ?? guess(call.inputChars));
    const output = !answered ? 0 : (reportedOut ?? guess(call.outputChars));

    const p = await priceOf(env, call.model);
    const neurons = p ? (input * p.inputNeuronsPerM + output * p.outputNeuronsPerM) / 1e6 : 0;
    const costMicro = p ? Math.round(input * p.inputUsdPerM + output * p.outputUsdPerM) : 0; // tokens × ($ per 1M) = micro-dollars

    await env.DB
      .prepare(
        `INSERT INTO ai_usage (ts, user_id, tool, model, input_tokens, output_tokens, estimated, neurons, cost_micro, ok, ms)
         VALUES (unixepoch(), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(ctx?.userId ?? null, (ctx?.tool ?? 'unattributed').slice(0, 40), call.model, input, output, estimated ? 1 : 0, neurons, costMicro, call.ok ? 1 : 0, Math.round(call.ms))
      .run();
  } catch (err) {
    console.error('ai usage not recorded', err instanceof Error ? err.message : 'unknown');
  }
}

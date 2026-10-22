/**
 * Vane AI Pass: who has it, and how many of its monthly credits are used. The price, the credits and the extra-credit rate come from
 * the catalog row 'ai-pass' (plans.ts → aiPassOffer). Nobody pays for it online yet: an admin switches it on (admin → user → AI credits);
 * a payment webhook will do the same by writing the row below.
 */
import type { Env } from '../../../types';

export interface AiPassState { active: boolean; endsAt: number | null; used: number }

export const passPeriod = (now: number): string => new Date(now * 1000).toISOString().slice(0, 7);

/** Active when the row says so and its period has not ended. A missing table (schema.sql not re-run) means no pass. */
export async function loadAiPass(env: Env, userId: string, now: number): Promise<AiPassState> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT p.status, p.current_period_end, COALESCE(u.used, 0) used
           FROM ai_pass p LEFT JOIN ai_pass_usage u ON u.user_id = p.user_id AND u.period = ?2
          WHERE p.user_id = ?1`,
      )
      .bind(userId, passPeriod(now))
      .first<{ status: string; current_period_end: number | null; used: number }>();
    if (!row) return { active: false, endsAt: null, used: 0 };
    const active = row.status === 'active' && (row.current_period_end === null || row.current_period_end > now);
    return { active, endsAt: row.current_period_end, used: row.used };
  } catch {
    return { active: false, endsAt: null, used: 0 };
  }
}

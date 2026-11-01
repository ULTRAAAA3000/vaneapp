/**
 * "What do I bill for going over the quota?": the extra posts and extra AI credits an account used in one month, in one row per account.
 * Nothing in Vane charges these automatically yet (checkout sells plans, not usage), so this is the list to invoice from.
 *
 * usage_counters.overage_micro_usd adds extra POSTS and extra AI credits into one number; the AI share is read from the usage log
 * (kind 'ai_post', overage = 1), so posts = counter - AI. Money is in micro-USD (millionths of a dollar) until it is shown.
 */
export interface CounterRow { user_id: string; email: string; overage_posts: number; overage_micro_usd: number }
export interface AiRow { user_id: string; email: string; n: number; micro: number }

export interface ExtraUsageRow {
  userId: string;
  email: string;
  posts: number;
  postsMicro: number;
  aiUses: number;
  aiMicro: number;
  totalMicro: number;
}

export function combineExtraUsage(counters: CounterRow[], ai: AiRow[]): { rows: ExtraUsageRow[]; totalMicro: number } {
  const byUser = new Map<string, ExtraUsageRow>();
  const row = (userId: string, email: string): ExtraUsageRow => {
    let r = byUser.get(userId);
    if (!r) { r = { userId, email, posts: 0, postsMicro: 0, aiUses: 0, aiMicro: 0, totalMicro: 0 }; byUser.set(userId, r); }
    return r;
  };
  for (const a of ai) { const r = row(a.user_id, a.email); r.aiUses += a.n; r.aiMicro += a.micro; }
  for (const c of counters) {
    const r = row(c.user_id, c.email);
    r.posts += c.overage_posts;
    r.postsMicro += Math.max(c.overage_micro_usd - r.aiMicro, 0); // the counter holds posts + AI; take the AI share out
  }
  const rows = [...byUser.values()].filter((r) => r.posts > 0 || r.aiUses > 0 || r.postsMicro > 0 || r.aiMicro > 0);
  for (const r of rows) r.totalMicro = r.postsMicro + r.aiMicro;
  rows.sort((a, b) => b.totalMicro - a.totalMicro || a.email.localeCompare(b.email));
  return { rows, totalMicro: rows.reduce((n, r) => n + r.totalMicro, 0) };
}

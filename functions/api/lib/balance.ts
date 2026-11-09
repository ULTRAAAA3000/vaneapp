/**
 * The prepaid balance ("Extra usage"). A user pays in advance with a normal checkout (plan id `balance`, from $10), and the money is
 * spent on anything beyond the plan's quota: extra posts, extra AI credits, extra Vane Studio AI. There is no debt anywhere:
 * if the balance is too small the request is refused, so nothing is ever owed.
 *
 * Money is in micro-USD (millionths of a dollar), like every other price in Vane. 1 cent = 10,000 micro.
 *
 * Why this is safe under parallel requests:
 *   - spending is ONE statement, `UPDATE ... SET micro_usd = micro_usd - ?  WHERE micro_usd >= ?`: two requests can never both spend
 *     the same money, and the table's CHECK (micro_usd >= 0) makes a negative balance impossible even if this code had a bug;
 *   - a top-up is credited exactly once per order: the ledger has a UNIQUE index on the order id for kind 'topup', and the credit
 *     and the ledger row are written in one batch (all or nothing), so a repeated payment report adds nothing.
 * The ledger (balance_ledger) is the audit trail; user_balance is the number that counts.
 */
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import type { Plan } from './catalog';

export const MICRO_PER_CENT = 10_000;
export const MICRO_PER_USD = 1_000_000;
/** The smallest and largest single top-up, in cents. The minimum keeps card fees from eating a small payment. */
export const MIN_TOPUP_CENTS = 1000;
export const MAX_TOPUP_CENTS = 50_000;

export const centsToMicro = (cents: number): number => Math.round(cents) * MICRO_PER_CENT;
export const microToUsd = (micro: number): number => micro / MICRO_PER_USD;

/** What the balance was spent on, for the ledger. */
export type SpendKind = 'post' | 'ai' | 'video_ai';

/** The balance in micro-USD. 0 when there is none (or the table does not exist yet): never an error for a page. */
export async function getBalanceMicro(env: Env, userId: string): Promise<number> {
  try {
    const row = await env.DB.prepare('SELECT micro_usd FROM user_balance WHERE user_id = ?1').bind(userId).first<{ micro_usd: number }>();
    return row?.micro_usd ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Spends `micro` from the balance if it is all there. Returns false (and changes nothing) when the balance is too small.
 * Throws only when the database itself fails, and the callers refuse the request in that case too.
 */
export async function chargeBalance(env: Env, userId: string, micro: number, what: SpendKind, now: number): Promise<boolean> {
  if (!(micro > 0)) return true;
  let res;
  try {
    res = await env.DB
      .prepare('UPDATE user_balance SET micro_usd = micro_usd - ?2, updated_at = ?3 WHERE user_id = ?1 AND micro_usd >= ?2')
      .bind(userId, micro, now)
      .run();
  } catch (err) {
    // The balance tables are not in the database yet (right after a deploy, before `npm run db:migrate:balance`): there is no balance, so no extra use.
    if (/no such table/i.test(err instanceof Error ? err.message : '')) return false;
    throw err;
  }
  if (!(res.meta?.changes ?? 0)) return false;
  // The audit row can fail without losing money: the balance above is the source of truth.
  await env.DB
    .prepare(`INSERT INTO balance_ledger (user_id, kind, delta_micro, what, created_at) VALUES (?1, 'charge', ?2, ?3, ?4)`)
    .bind(userId, -micro, what, now)
    .run()
    .catch((e: unknown) => console.error('balance ledger (charge) failed:', e instanceof Error ? e.message : 'unknown'));
  return true;
}

/** Gives money back (the request that was charged for failed or was cancelled). Never loses the money: it creates the row if needed. */
export async function refundBalance(env: Env, userId: string, micro: number, what: SpendKind, now: number): Promise<void> {
  if (!(micro > 0)) return;
  await env.DB
    .prepare(
      `INSERT INTO user_balance (user_id, micro_usd, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET micro_usd = micro_usd + ?2, updated_at = ?3`,
    )
    .bind(userId, micro, now)
    .run();
  await env.DB
    .prepare(`INSERT INTO balance_ledger (user_id, kind, delta_micro, what, created_at) VALUES (?1, 'refund', ?2, ?3, ?4)`)
    .bind(userId, micro, what, now)
    .run()
    .catch((e: unknown) => console.error('balance ledger (refund) failed:', e instanceof Error ? e.message : 'unknown'));
}

/**
 * Credits a paid top-up order, exactly once. The two statements run as one batch: the balance is raised only when the order has no
 * ledger row yet, then the ledger row is written (its UNIQUE index would refuse a second one). Returns true when money was added.
 */
export async function creditTopUp(env: Env, userId: string, orderId: string, amountCents: number, now: number): Promise<boolean> {
  const micro = centsToMicro(amountCents);
  if (!(micro > 0)) return false;
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `INSERT INTO user_balance (user_id, micro_usd, updated_at)
         SELECT ?1, ?2, ?4 WHERE NOT EXISTS (SELECT 1 FROM balance_ledger WHERE kind = 'topup' AND ref = ?3)
         ON CONFLICT(user_id) DO UPDATE SET micro_usd = micro_usd + ?2, updated_at = ?4`,
      )
      .bind(userId, micro, orderId, now),
    env.DB
      .prepare(`INSERT OR IGNORE INTO balance_ledger (user_id, kind, delta_micro, what, ref, created_at) VALUES (?1, 'topup', ?2, 'order', ?3, ?4)`)
      .bind(userId, micro, orderId, now),
  ];
  const [credit] = await env.DB.batch(statements);
  return (credit.meta?.changes ?? 0) > 0;
}

/** Adds (or, with a negative amount, takes away) money by hand: support, a refund outside the card, a gift. Never below zero. */
export async function adjustBalance(env: Env, userId: string, deltaMicro: number, note: string, now: number): Promise<boolean> {
  if (!Number.isFinite(deltaMicro) || deltaMicro === 0) return false;
  const res = deltaMicro > 0
    ? await env.DB
        .prepare(
          `INSERT INTO user_balance (user_id, micro_usd, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(user_id) DO UPDATE SET micro_usd = micro_usd + ?2, updated_at = ?3`,
        )
        .bind(userId, deltaMicro, now)
        .run()
    : await env.DB
        .prepare('UPDATE user_balance SET micro_usd = micro_usd + ?2, updated_at = ?3 WHERE user_id = ?1 AND micro_usd + ?2 >= 0')
        .bind(userId, deltaMicro, now)
        .run();
  if (!(res.meta?.changes ?? 0)) return false;
  await env.DB
    .prepare(`INSERT INTO balance_ledger (user_id, kind, delta_micro, what, note, created_at) VALUES (?1, 'adjust', ?2, 'admin', ?3, ?4)`)
    .bind(userId, deltaMicro, note.slice(0, 200), now)
    .run()
    .catch(() => undefined);
  return true;
}

export interface LedgerEntry { kind: 'topup' | 'charge' | 'refund' | 'adjust'; usd: number; what: string; note: string | null; at: number }

/** The latest movements, newest first, for the balance page. */
export async function recentLedger(env: Env, userId: string, limit = 20): Promise<LedgerEntry[]> {
  try {
    const { results } = await env.DB
      .prepare('SELECT kind, delta_micro, what, note, created_at FROM balance_ledger WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2')
      .bind(userId, limit)
      .all<{ kind: LedgerEntry['kind']; delta_micro: number; what: string; note: string | null; created_at: number }>();
    return results.map((r) => ({ kind: r.kind, usd: microToUsd(r.delta_micro), what: r.what, note: r.note, at: r.created_at }));
  } catch {
    return [];
  }
}

// ───────────────────────── the top-up "plan" ─────────────────────────

/** The id an order carries when it buys balance instead of a plan. */
export const BALANCE_PLAN_ID = 'balance';

/** A whole-dollar amount from the user ("25", 25) in cents, or null when it is not an amount we sell ($10 to $500, no cents). */
export function parseTopUpCents(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,4}(\.0{1,2})?$/.test(v.trim()) ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  const cents = n * 100;
  return cents >= MIN_TOPUP_CENTS && cents <= MAX_TOPUP_CENTS ? cents : null;
}

/** What the checkout sees: a one-off purchase of `amountCents` of balance. It is not in the plans table, so there is nothing to misprice. */
export function topUpPlan(amountCents: number): Plan {
  const usd = amountCents / 100;
  return {
    id: BALANCE_PLAN_ID, kind: 'addon', name: 'Balance top-up', tagline: 'Pays for extra use beyond your plan', badge: '',
    priceCents: amountCents, comparePriceCents: null, yearlyPriceCents: null, currency: 'USD', interval: 'once', trialDays: 0,
    features: [
      `$${usd} is added to your Vane balance`,
      'Spent only on extra posts, extra AI credits and extra Studio AI, and only if you switch paying for extra use on',
      'No subscription: it never renews or charges you again',
    ],
    limits: {}, ctaLabel: 'Add funds', highlight: false, comingSoon: false, isPublic: false, isActive: true, sort: 0, providerRefs: {}, createdAt: 0, updatedAt: 0,
  };
}

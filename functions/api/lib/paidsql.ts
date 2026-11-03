/**
 * The SQL side of "paid account" (see paid.ts), with no imports at all: the cron worker asks about many accounts in one statement and
 * must not bundle the rest of the app to do it.
 */
/**
 * `<column> IN (paid accounts)` for a SQL statement; `nowParam` is the placeholder (e.g. "?1") that holds the current unix time.
 * Mirrors isDashboardPlan() in paid.ts: an active, unexpired subscription to a plan that includes dashboard posts a month ('pro' always; any other plan whose catalog row says postsPerMonth > 0; the Developer API plan has none). Written in SQL because the cron worker asks about many accounts at once.
 */
export const paidUsersSql = (column: string, nowParam: string): string =>
  `${column} IN (SELECT user_id FROM subscriptions
      WHERE COALESCE(status, 'active') = 'active' AND (current_period_end IS NULL OR current_period_end > ${nowParam})
        AND plan <> 'free'
        AND (plan = 'pro' OR plan IN (SELECT id FROM plans WHERE COALESCE(CAST(json_extract(limits, '$.postsPerMonth') AS INTEGER), 0) > 0 AND json_extract(limits, '$.postsLifetime') IS NULL)))`;

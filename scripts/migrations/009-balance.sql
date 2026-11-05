-- Run ONCE on an existing database:  npm run db:migrate:balance
-- The prepaid balance ("Extra usage"): money a user puts in with a normal checkout, spent on anything beyond the plan's quota
-- (extra posts, extra AI credits, extra Studio AI). Safe to run twice (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS user_balance (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  micro_usd  INTEGER NOT NULL DEFAULT 0 CHECK (micro_usd >= 0),   -- millionths of a dollar; the CHECK makes a negative balance impossible
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Every change, never edited: what the balance was built from. delta_micro > 0 adds money, < 0 spends it.
CREATE TABLE IF NOT EXISTS balance_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('topup', 'charge', 'refund', 'adjust')),
  delta_micro INTEGER NOT NULL,
  what        TEXT    NOT NULL DEFAULT '',                        -- post | ai | video_ai | order | admin
  ref         TEXT,                                               -- the order id for a top-up
  note        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
-- A paid order can only ever be credited once, however many times the payment is reported.
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_topup_ref ON balance_ledger(ref) WHERE kind = 'topup';
CREATE INDEX IF NOT EXISTS idx_balance_ledger_user ON balance_ledger(user_id, created_at DESC);

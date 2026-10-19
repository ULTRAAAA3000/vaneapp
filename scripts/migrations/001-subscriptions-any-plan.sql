-- Run ONCE on a database created before the admin panel:
--   npx wrangler d1 execute vane-db --remote --file=./scripts/migrations/001-subscriptions-any-plan.sql
-- SQLite cannot drop a CHECK constraint, so the table is rebuilt (same columns, same data) without
-- the `plan IN ('free','api','pro')` check. After this, plans made in /admin can be given to users.
-- Safe to skip if you only use free / api / pro: everything keeps working without it.
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS subscriptions_new (
  user_id             TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT    NOT NULL DEFAULT 'free',
  api_addon           INTEGER NOT NULL DEFAULT 0 CHECK (api_addon IN (0, 1)),
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_end  INTEGER,
  overage_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (overage_enabled IN (0, 1)),
  provider            TEXT    NOT NULL DEFAULT 'manual',
  provider_ref        TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO subscriptions_new SELECT user_id, plan, api_addon, status, current_period_end, overage_enabled, provider, provider_ref, created_at, updated_at FROM subscriptions;
DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;
PRAGMA foreign_keys = ON;

PRAGMA foreign_keys = OFF;

CREATE TABLE orders_new (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       TEXT    NOT NULL,
  plan_name     TEXT    NOT NULL DEFAULT '',
  interval      TEXT    NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency      TEXT    NOT NULL DEFAULT 'USD',
  provider      TEXT    NOT NULL CHECK (provider IN ('monobank', 'crypto', 'paypal', 'csob')),
  provider_ref  TEXT,
  pay_url       TEXT,
  pay_micro     INTEGER,
  tx_ref        TEXT    UNIQUE,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed', 'canceled')),
  billing       TEXT    NOT NULL DEFAULT '{}',
  note          TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at    INTEGER NOT NULL,
  paid_at       INTEGER
);
INSERT INTO orders_new SELECT id, user_id, plan_id, plan_name, interval, amount_cents, currency, provider, provider_ref, pay_url, pay_micro, tx_ref, status, billing, note, created_at, expires_at, paid_at FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, provider, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice ON orders(provider_ref) WHERE provider = 'monobank' AND provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_paypal ON orders(provider_ref) WHERE provider = 'paypal';
CREATE INDEX IF NOT EXISTS idx_orders_csob ON orders(provider_ref) WHERE provider = 'csob';

PRAGMA foreign_keys = ON;

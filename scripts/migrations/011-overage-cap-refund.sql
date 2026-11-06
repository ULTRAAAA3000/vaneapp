ALTER TABLE subscriptions ADD COLUMN overage_cap_micro_usd INTEGER NOT NULL DEFAULT 20000000;
ALTER TABLE usage_logs ADD COLUMN refunded_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_usage_logs_open_overage ON usage_logs(created_at) WHERE kind = 'post' AND overage = 1 AND refunded_at IS NULL;

-- Which parts of the schema are MISSING in this database. It only reads, it changes nothing.
-- Run it in Cloudflare -> D1 -> vane-db -> Console (or: npm run db:check). It answers one row per problem:
--   problem | what is missing | the file that fixes it (run THAT file, not the whole schema.sql)
-- One row "ok" means nothing is missing. Do not paste the whole schema.sql into an existing database: it stops at the first
-- statement that needs a column the old table does not have yet. Run the migrations first, then schema.sql is safe to run again.
--
-- Kept in step with schema.sql by scripts/dbcheck-unit.mjs (a table added to schema.sql without being listed here fails the tests).
WITH expected(name, fix) AS (VALUES
  ('waitlist', 'its CREATE TABLE in schema.sql'),
  ('users', 'its CREATE TABLE in schema.sql'),
  ('oauth_identities', 'its CREATE TABLE in schema.sql'),
  ('channels', 'its CREATE TABLE in schema.sql'),
  ('posts', 'its CREATE TABLE in schema.sql'),
  ('logs', 'its CREATE TABLE in schema.sql'),
  ('sessions', 'its CREATE TABLE in schema.sql'),
  ('rate_limits', 'its CREATE TABLE in schema.sql'),
  ('telegram_verifications', 'its CREATE TABLE in schema.sql'),
  ('email_verifications', 'its CREATE TABLE in schema.sql'),
  ('user_activity', 'its CREATE TABLE in schema.sql'),
  ('subscriptions', 'its CREATE TABLE in schema.sql'),
  ('api_keys', 'its CREATE TABLE in schema.sql'),
  ('usage_counters', 'its CREATE TABLE in schema.sql'),
  ('usage_logs', 'its CREATE TABLE in schema.sql'),
  ('video_subscriptions', 'its CREATE TABLE in schema.sql'),
  ('videos', 'its CREATE TABLE in schema.sql'),
  ('video_parts', 'its CREATE TABLE in schema.sql'),
  ('settings', 'its CREATE TABLE in schema.sql'),
  ('plans', 'its CREATE TABLE in schema.sql'),
  ('media_assets', 'its CREATE TABLE in schema.sql'),
  ('social_links', 'its CREATE TABLE in schema.sql'),
  ('user_flags', 'its CREATE TABLE in schema.sql'),
  ('web_views', 'its CREATE TABLE in schema.sql'),
  ('user_attribution', 'its CREATE TABLE in schema.sql'),
  ('auth_attempts', 'its CREATE TABLE in schema.sql'),
  ('ip_blocks', 'its CREATE TABLE in schema.sql'),
  ('ip_intel', 'its CREATE TABLE in schema.sql'),
  ('admin_sessions', 'its CREATE TABLE in schema.sql'),
  ('admin_audit', 'its CREATE TABLE in schema.sql'),
  ('idempotency_keys', 'its CREATE TABLE in schema.sql'),
  ('mastodon_apps', 'its CREATE TABLE in schema.sql'),
  ('oauth_states', 'its CREATE TABLE in schema.sql'),
  ('video_assets', 'its CREATE TABLE in schema.sql'),
  ('video_covers', 'its CREATE TABLE in schema.sql'),
  ('video_checks', 'its CREATE TABLE in schema.sql'),
  ('video_links', 'its CREATE TABLE in schema.sql'),
  ('post_previews', 'scripts/migrations/006-post-previews.sql'),
  ('webhook_subscriptions', 'its CREATE TABLE in schema.sql'),
  ('webhook_deliveries', 'its CREATE TABLE in schema.sql'),
  ('video_channels', 'its CREATE TABLE in schema.sql'),
  ('video_ai_usage', 'its CREATE TABLE in schema.sql'),
  ('user_ai_bonus', 'its CREATE TABLE in schema.sql'),
  ('video_publications', 'its CREATE TABLE in schema.sql'),
  ('video_publication_options', 'its CREATE TABLE in schema.sql'),
  ('ai_pass', 'its CREATE TABLE in schema.sql'),
  ('ai_pass_usage', 'its CREATE TABLE in schema.sql'),
  ('email_optouts', 'its CREATE TABLE in schema.sql'),
  ('post_drafts', 'its CREATE TABLE in schema.sql'),
  ('post_snippets', 'its CREATE TABLE in schema.sql'),
  ('post_metrics', 'its CREATE TABLE in schema.sql'),
  ('channel_followers', 'its CREATE TABLE in schema.sql'),
  ('analytics_subscriptions', 'its CREATE TABLE in schema.sql'),
  ('analytics_reports', 'its CREATE TABLE in schema.sql'),
  ('analytics_bot', 'its CREATE TABLE in schema.sql'),
  ('analytics_bot_links', 'its CREATE TABLE in schema.sql'),
  ('analytics_bot_hot', 'its CREATE TABLE in schema.sql'),
  ('ai_history', 'its CREATE TABLE in schema.sql'),
  ('orders', 'its CREATE TABLE in schema.sql'),
  ('network_flags', 'its CREATE TABLE in schema.sql'),
  ('ai_usage', 'its CREATE TABLE in schema.sql'),
  ('ai_prices', 'its CREATE TABLE in schema.sql'),
  ('video_ai_settings', 'its CREATE TABLE in schema.sql'),
  ('video_ai_overage', 'its CREATE TABLE in schema.sql'),
  ('integration_settings', 'its CREATE TABLE in schema.sql'),
  ('api_usage_daily', 'its CREATE TABLE in schema.sql'),
  ('oauth_clients', 'its CREATE TABLE in schema.sql'),
  ('oauth_grants', 'its CREATE TABLE in schema.sql'),
  ('oauth_codes', 'its CREATE TABLE in schema.sql'),
  ('oauth_tokens', 'its CREATE TABLE in schema.sql'),
  ('feedback_items', 'scripts/migrations/005-feedback.sql'),
  ('feedback_votes', 'scripts/migrations/005-feedback.sql'),
  ('contact_messages', 'its CREATE TABLE in schema.sql'),
  ('age_confirmations', 'its CREATE TABLE in schema.sql'),
  ('ai_voice', 'its CREATE TABLE in schema.sql'),
  ('agent_events', 'scripts/migrations/008-agent-log.sql'),
  ('onboarding_progress', 'scripts/migrations/007-onboarding.sql'),
  ('password_resets', 'scripts/migrations/009-password-reset.sql'),
  ('user_balance', 'scripts/migrations/009-balance.sql'),
  ('balance_ledger', 'scripts/migrations/009-balance.sql'),
  ('paypal_plans', 'scripts/migrations/012-paypal.sql'),
  ('feeds', 'scripts/migrations/015-feeds.sql'),
  ('feed_items', 'scripts/migrations/015-feeds.sql')
),
problems(problem, what, fix) AS (
  SELECT 'missing table', name, fix FROM expected WHERE name NOT IN (SELECT name FROM sqlite_master WHERE type = 'table')
  UNION ALL SELECT 'missing column', 'usage_logs.refunded_at', 'scripts/migrations/011-overage-cap-refund.sql (the ALTER of usage_logs, then its index)' WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('usage_logs') WHERE name = 'refunded_at')
  UNION ALL SELECT 'missing column', 'subscriptions.overage_cap_micro_usd', 'scripts/migrations/011-overage-cap-refund.sql (the ALTER of subscriptions)' WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('subscriptions') WHERE name = 'overage_cap_micro_usd')
  UNION ALL SELECT 'missing column', 'api_keys.integration', 'scripts/migrations/002-api-key-integration.sql' WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('api_keys') WHERE name = 'integration')
  UNION ALL SELECT 'channel type not allowed', 'discord', 'migrations/0002-channel-types-discord-devto.sql' WHERE (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels') NOT LIKE '%''discord''%'
UNION ALL SELECT 'channel type not allowed', 'devto', 'migrations/0002-channel-types-discord-devto.sql' WHERE (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels') NOT LIKE '%''devto''%'
UNION ALL SELECT 'channel type not allowed', 'reddit', 'migrations/0003-channel-types-reddit-facebook.sql' WHERE (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels') NOT LIKE '%''reddit''%'
UNION ALL SELECT 'channel type not allowed', 'facebook', 'migrations/0003-channel-types-reddit-facebook.sql' WHERE (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels') NOT LIKE '%''facebook''%'
UNION ALL SELECT 'channel type not allowed', 'pinterest', 'migrations/0004-channel-types-pinterest.sql' WHERE (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels') NOT LIKE '%''pinterest''%'
)
SELECT problem, what, fix FROM problems
UNION ALL SELECT 'ok', 'nothing is missing', '' WHERE NOT EXISTS (SELECT 1 FROM problems);

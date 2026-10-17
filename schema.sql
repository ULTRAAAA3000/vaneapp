-- Vane — D1 schema (SQLite)
-- Apply:  npx wrangler d1 execute vane-db --file=./schema.sql            (local: add --local)
-- Timestamps are unix epoch seconds (UTC).

PRAGMA foreign_keys = ON;

-- ───────────────────────── Waitlist ─────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ───────────────────────── Users ─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT    PRIMARY KEY,                  -- uuid
  email               TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT,                                 -- null if passwordless / OAuth
  name                TEXT,
  timezone            TEXT    NOT NULL DEFAULT 'UTC',
  plan                TEXT    NOT NULL DEFAULT 'free'
                      CHECK (plan IN ('free', 'pro')),
  stripe_customer_id  TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ───────────────────────── Channels ─────────────────────────
-- One row = one connected destination (Telegram chat, X account, LinkedIn profile, webhook URL)
CREATE TABLE IF NOT EXISTS channels (
  id           TEXT    PRIMARY KEY,                         -- uuid
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL
               CHECK (type IN ('telegram', 'x', 'linkedin', 'webhook')),
  name         TEXT    NOT NULL,                            -- display label, e.g. "@vane_dev"
  credentials  TEXT    NOT NULL,                            -- JSON, encrypted at app level (tokens, chat_id, url, secret)
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

-- ───────────────────────── Posts ─────────────────────────
-- One row = one delivery to one channel.
-- A multi-channel post shares a group_id, so the UI can show it as one item.
CREATE TABLE IF NOT EXISTS posts (
  id            TEXT    PRIMARY KEY,                        -- uuid
  group_id      TEXT    NOT NULL,
  user_id       TEXT    NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  channel_id    TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  content       TEXT    NOT NULL,
  media_keys    TEXT    NOT NULL DEFAULT '[]',              -- JSON array of R2 object keys
  scheduled_at  INTEGER NOT NULL,                           -- when to publish
  status        TEXT    NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('draft', 'scheduled', 'processing', 'sent', 'failed', 'cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  external_id   TEXT,                                       -- id of the post on the remote network
  error         TEXT,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
-- The cron worker runs every minute: this index makes "what is due?" an index range scan.
CREATE INDEX IF NOT EXISTS idx_posts_due   ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_user  ON posts(user_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id);

-- ───────────────────────── Logs ─────────────────────────
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    REFERENCES users(id)    ON DELETE CASCADE,
  post_id     TEXT    REFERENCES posts(id)    ON DELETE CASCADE,
  channel_id  TEXT    REFERENCES channels(id) ON DELETE SET NULL,
  level       TEXT    NOT NULL DEFAULT 'info'
              CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event       TEXT    NOT NULL,                             -- e.g. 'post.sent', 'post.failed', 'cron.tick'
  message     TEXT,
  meta        TEXT,                                         -- JSON
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_logs_post ON logs(post_id);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id, created_at);

-- ───────────────────────── Sessions (stage 3) ─────────────────────────
-- The browser holds a random token in an HttpOnly cookie; we store only its SHA-256,
-- so a leaked database can't be replayed as live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,                          -- sha256 hex of the cookie token
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- ───────────────────────── Rate limits (stage 3) ─────────────────────────
-- Tiny fixed-window counters: login brute force, signup spam, upload spam.
CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT    PRIMARY KEY,                            -- e.g. 'login:em:a@b.co', 'reg:1.2.3.4'
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL
);

-- ───────────────────────── Telegram ownership proof (Quick Connect) ─────────────────────────
-- The shared Vane bot is admin in MANY channels, so "the bot can post there" does not prove the
-- Vane user owns the channel. The user must post a one-time code in it (only admins can); the bot
-- sees it through its webhook and marks the row verified.
CREATE TABLE IF NOT EXISTS telegram_verifications (
  id          TEXT    PRIMARY KEY,                          -- uuid
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     TEXT    NOT NULL,                             -- canonical numeric id (from getChat)
  chat_title  TEXT,
  chat_type   TEXT    NOT NULL,
  code        TEXT    NOT NULL UNIQUE,                      -- 'VANE-XXXXXXXX'
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tgv_user ON telegram_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_tgv_lookup ON telegram_verifications(chat_id, code);

-- ───────────────────────── Email verification (6-digit codes) ─────────────────────────
-- A code is needed (a) to finish signing up and (b) to sign in after more than 3 days away.
-- It is enforced only when RESEND_API_KEY + EMAIL_FROM are set (see README), and it lives in NEW
-- tables: SQLite has no "ADD COLUMN IF NOT EXISTS", so touching `users` would break re-running this file.
--   signup : the account does not exist yet. `payload` holds the pending sign-up and the users row is
--            created only once the right code is entered.
--   login  : the password was already right; the code is the second step.
CREATE TABLE IF NOT EXISTS email_verifications (
  email       TEXT    NOT NULL COLLATE NOCASE,
  purpose     TEXT    NOT NULL CHECK (purpose IN ('signup', 'login')),
  code_hash   TEXT    NOT NULL,                             -- HMAC of the code; the code itself is never stored
  payload     TEXT,                                         -- signup only: JSON { passwordHash, name, timezone }
  attempts    INTEGER NOT NULL DEFAULT 0,                   -- wrong guesses against the current code
  created_at  INTEGER NOT NULL,                             -- when the current code was sent (resend cooldown)
  expires_at  INTEGER NOT NULL,                             -- the code stops working here
  PRIMARY KEY (email, purpose)
);
CREATE INDEX IF NOT EXISTS idx_email_ver_exp ON email_verifications(expires_at);

-- When each user was last active, to spot accounts nobody has opened for more than 3 days.
CREATE TABLE IF NOT EXISTS user_activity (
  user_id       TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at  INTEGER NOT NULL
);

-- ───────────────────────── Public API: subscriptions, keys, metering (API part 1) ─────────────────────────
-- ECONOMY_AND_FINANCE.md §2 (plans) and §6 (key scoping). Only NEW tables: `users` is never altered (see the note above).

-- One row per user: what they pay for. No row = the Free Trial.
-- A paid row whose period has ended (or that is not 'active') is treated as the Free Trial until a payment renews it.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id             TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT    NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'api', 'pro')),
  api_addon           INTEGER NOT NULL DEFAULT 0 CHECK (api_addon IN (0, 1)),   -- Pro + API Add-on (+180 API posts)
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_end  INTEGER,                                                  -- NULL = no expiry (granted by hand)
  overage_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (overage_enabled IN (0, 1)),  -- 0: over quota -> 402; 1: bill per post
  provider            TEXT    NOT NULL DEFAULT 'manual',                        -- 'manual' | 'monobank' | 'crypto'
  provider_ref        TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- API keys. Only the SHA-256 of a key is stored; the key itself is shown once, when it is created.
--   scope: 'post' -> cpost_… keys (text/media endpoints)   'video' -> cvid_… keys (Video Engine, later)
--   mode:  'live' -> real posts, counted against the quota   'test' -> answers are simulated, nothing is posted or counted
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT    PRIMARY KEY,                                            -- uuid
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,                                               -- label, e.g. "Make.com"
  scope         TEXT    NOT NULL CHECK (scope IN ('post', 'video')),
  mode          TEXT    NOT NULL CHECK (mode IN ('live', 'test')),
  key_hash      TEXT    NOT NULL UNIQUE,                                        -- sha256 hex of the whole key
  hint          TEXT    NOT NULL,                                               -- last 4 characters, to recognise a key in the list
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- Metered usage per user and period ('lifetime' for the Free Trial, 'YYYY-MM' (UTC) for paid plans).
-- Quota checks are ONE conditional upsert on this row, so two parallel requests can never both take the last unit.
-- ai_* columns are used by the AI endpoints (a later part).
CREATE TABLE IF NOT EXISTS usage_counters (
  user_id            TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period             TEXT    NOT NULL,
  api_posts          INTEGER NOT NULL DEFAULT 0,
  ui_posts           INTEGER NOT NULL DEFAULT 0,
  ai_posts           INTEGER NOT NULL DEFAULT 0,       -- how many of the API posts were AI-generated
  ai_generations     INTEGER NOT NULL DEFAULT 0,
  overage_posts      INTEGER NOT NULL DEFAULT 0,       -- posts beyond the quota (only when overage_enabled)
  overage_micro_usd  INTEGER NOT NULL DEFAULT 0,       -- what those cost, in millionths of a dollar ($0.03 = 30000)
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, period)
);

-- Audit trail of every metered API call (also what an invoice is built from).
CREATE TABLE IF NOT EXISTS usage_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id      TEXT    REFERENCES api_keys(id) ON DELETE SET NULL,
  source          TEXT    NOT NULL CHECK (source IN ('api', 'ui')),
  kind            TEXT    NOT NULL CHECK (kind IN ('post', 'ai_post')),
  units           INTEGER NOT NULL DEFAULT 1,
  overage         INTEGER NOT NULL DEFAULT 0 CHECK (overage IN (0, 1)),
  cost_micro_usd  INTEGER NOT NULL DEFAULT 0,
  ref             TEXT,                                                         -- e.g. the post group id
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user ON usage_logs(user_id, created_at);

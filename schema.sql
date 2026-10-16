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

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

-- ───────────────────────── Sign in with GitHub / Google ─────────────────────────
-- One row = one provider account linked to a user (the provider's stable id, never the email, identifies the person)
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider    TEXT    NOT NULL CHECK (provider IN ('github', 'google')),
  subject     TEXT    NOT NULL,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_identities(user_id);

-- ───────────────────────── Channels ─────────────────────────
-- One row = one connected destination (Telegram chat, Bluesky / Mastodon / Threads account, X account, LinkedIn profile, webhook URL)
-- A database created before 'bluesky' existed has the older CHECK: run `npm run db:migrate:networks` once (see migrations/).
CREATE TABLE IF NOT EXISTS channels (
  id           TEXT    PRIMARY KEY,                         -- uuid
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL
               CHECK (type IN ('telegram', 'x', 'linkedin', 'webhook', 'bluesky', 'mastodon', 'threads', 'discord', 'devto', 'reddit', 'facebook')),
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
-- documentation/ECONOMY_AND_FINANCE.md §2 (plans) and §6 (key scoping). Only NEW tables: `users` is never altered (see the note above).

-- One row per user: what they pay for. No row = the Free Trial. (An existing database still has the old
-- CHECK on `plan`: run scripts/migrations/001-subscriptions-any-plan.sql once to allow custom plans.)
-- A paid row whose period has ended (or that is not 'active') is treated as the Free Trial until a payment renews it.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id             TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT    NOT NULL DEFAULT 'free',                                  -- a plans.id (free / api / pro / any plan made in /admin)
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
  revoked_at    INTEGER,
  integration   TEXT                                                            -- where the owner uses it: claude | chatgpt | make | zapier | wordpress | api (NULL = not said: guessed from the name / the client)
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

-- ───────────────────────── Vane Studio / Video Engine (a separate product with its own dashboard) ─────────────────────────
-- Vane Studio, ECONOMY_AND_FINANCE.md §2.5: $12.00 / month, sold and metered apart from Vane Post (Free / API / Pro).
-- The $18.00 Suite bundle (§2.6) is Post + Studio: it will just create a row in BOTH subscription tables.
-- That is why it gets its own tables: `subscriptions` and `users` are never touched, so this file stays re-runnable.

-- Who has the Video Engine. No row = no access. A row that is not 'active' or whose period has ended counts as no access.
CREATE TABLE IF NOT EXISTS video_subscriptions (
  user_id             TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_end  INTEGER,                                                  -- NULL = no expiry (granted by hand)
  provider            TEXT    NOT NULL DEFAULT 'manual',                        -- 'manual' | 'monobank' | 'crypto'
  provider_ref        TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The video library: one row = one video file in R2 (private; it is streamed to its owner, never public).
-- A row is created when an upload starts and becomes 'ready' when every chunk is in and the file has been checked.
CREATE TABLE IF NOT EXISTS videos (
  id                 TEXT    PRIMARY KEY,                                       -- uuid
  user_id            TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              TEXT    NOT NULL,
  description        TEXT    NOT NULL DEFAULT '',
  tags               TEXT    NOT NULL DEFAULT '[]',                             -- JSON array of strings
  status             TEXT    NOT NULL DEFAULT 'uploading'
                     CHECK (status IN ('uploading', 'ready', 'failed')),
  r2_key             TEXT    NOT NULL UNIQUE,                                   -- 'videos/<user id>/<video id>.mp4'
  content_type       TEXT    NOT NULL CHECK (content_type IN ('video/mp4', 'video/quicktime')),
  size_bytes         INTEGER NOT NULL,                                          -- declared when the upload starts, verified when it ends
  part_size          INTEGER NOT NULL,                                          -- chunk size of this upload (all chunks but the last are exactly this)
  upload_id          TEXT,                                                      -- R2 multipart upload id; NULL once the upload is over
  upload_expires_at  INTEGER,                                                   -- an unfinished upload is thrown away after this
  error              TEXT,                                                      -- why a 'failed' video was rejected
  source             TEXT    NOT NULL CHECK (source IN ('ui', 'api')),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_videos_upload_exp ON videos(status, upload_expires_at);

-- Chunks of an unfinished upload (what lets a broken upload resume). Deleted when the upload completes or is cancelled.
CREATE TABLE IF NOT EXISTS video_parts (
  video_id     TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  part_number  INTEGER NOT NULL,                                                -- 1-based
  etag         TEXT    NOT NULL,                                                -- R2's receipt for the chunk, needed to assemble the file
  size_bytes   INTEGER NOT NULL,
  PRIMARY KEY (video_id, part_number)
);

-- ═════════════════════════════ Admin panel (/admin) ═════════════════════════════

-- ───────────────────────── Settings ─────────────────────────
-- Admin-editable switches (JSON-encoded values). Defaults live in code (lib/settings.ts).
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ───────────────────────── Plans ─────────────────────────
-- Everything about money lives here and is edited in /admin: the landing page and the
-- limit checks both read this table. Amounts are integer minor units (cents).
--   kind    'plan'  → a card in the pricing grid
--           'addon' → the strip under the grid ({price} in tagline is replaced by the price)
--   limits  JSON the API engine enforces (lib/plans.ts reads it): channels, postsPerMonth (dashboard), postsLifetime (Free-style
--           trial), apiPostsPerMonth, aiCredits, apiAccess (1/0), overagePostUsd, overageAiPostUsd, seats;
--           a missing key or null = unlimited
--   is_public  shown on the landing page        is_active  can be given to users / bought
--   provider_refs  JSON map for the payment provider(s), e.g. {"monobank":"…","crypto":"…"}
CREATE TABLE IF NOT EXISTS plans (
  id                   TEXT    PRIMARY KEY,                 -- slug: 'free', 'pro', 'ultra'…
  kind                 TEXT    NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan', 'addon')),
  name                 TEXT    NOT NULL,
  tagline              TEXT    NOT NULL DEFAULT '',
  badge                TEXT    NOT NULL DEFAULT '',
  price_cents          INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  compare_price_cents  INTEGER CHECK (compare_price_cents IS NULL OR compare_price_cents >= 0),
  yearly_price_cents   INTEGER CHECK (yearly_price_cents IS NULL OR yearly_price_cents >= 0),
  currency             TEXT    NOT NULL DEFAULT 'USD',
  interval             TEXT    NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year', 'once')),
  trial_days           INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  features             TEXT    NOT NULL DEFAULT '[]',
  limits               TEXT    NOT NULL DEFAULT '{}',
  cta_label            TEXT    NOT NULL DEFAULT 'Join the waitlist',
  highlight            INTEGER NOT NULL DEFAULT 0 CHECK (highlight IN (0, 1)),
  coming_soon          INTEGER NOT NULL DEFAULT 0 CHECK (coming_soon IN (0, 1)),
  is_public            INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort                 INTEGER NOT NULL DEFAULT 100,
  provider_refs        TEXT    NOT NULL DEFAULT '{}',
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Seed = the plans from documentation/ECONOMY_AND_FINANCE.md. INSERT OR IGNORE: re-running this file never
-- overwrites what the admin has edited since.
INSERT OR IGNORE INTO plans (id, name, tagline, price_cents, features, limits, sort) VALUES
  ('free', 'Free Trial', 'No card required.', 0,
   '["30 posts in total","Up to 2 connected channels","10 free AI credits","Free AI utilities","Try the dashboard and the API"]',
   '{"channels":2,"postsLifetime":30,"aiCredits":10,"apiAccess":1}', 10);
INSERT OR IGNORE INTO plans (id, name, tagline, price_cents, features, limits, sort) VALUES
  ('api', 'Developer API', 'A headless gateway for scripts and bots.', 599,
   '["REST API with Bearer auth, webhooks and an OpenAPI spec","180 API posts a month (about 6 a day)","Custom GPT and Claude MCP access when they launch","Extra posts: $0.03 each, $0.09 for AI posts"]',
   '{"apiPostsPerMonth":180,"apiAccess":1,"overagePostUsd":0.03,"overageAiPostUsd":0.09}', 20);
INSERT OR IGNORE INTO plans (id, name, tagline, badge, price_cents, compare_price_cents, yearly_price_cents, features, limits, highlight, sort) VALUES
  ('pro', 'Pro Dashboard', 'standard, or $99 a year.', 'Early Bird', 999, 1200, 9900,
   '["Full dashboard with calendar and Kanban","Unlimited workspaces and channels","1,000 posts a month","Telegram inline buttons, spoilers and polls","Media library on Cloudflare R2","Vane AI Pass included","Extra posts: $0.015 each, $0.045 for AI posts"]',
   '{"postsPerMonth":1000,"aiCredits":250,"apiAccess":0,"overagePostUsd":0.015,"overageAiPostUsd":0.045}', 1, 30);
INSERT OR IGNORE INTO plans (id, name, tagline, price_cents, features, limits, cta_label, coming_soon, is_active, sort) VALUES
  ('video', 'Video Engine', 'Video publishing, end to end.', 899,
   '["YouTube Shorts, TikTok and Instagram Reels","YouTube long-form with custom thumbnails, playlists and tags","Resumable uploads on Cloudflare R2","AI hooks, scripts, descriptions, tags and timestamps"]',
   '{"aiCredits":50,"overageAiPostUsd":0.02}', 'Get notified', 1, 0, 40);
INSERT OR IGNORE INTO plans (id, kind, name, tagline, price_cents, limits, is_active, sort) VALUES
  ('api-addon', 'addon', 'Need the dashboard and the API?', 'Add the API to Pro for {price} a month. It adds 180 API posts and keeps Pro’s low overage rates.', 299,
   '{"apiPostsPerMonth":180}', 0, 50);

-- ───────────────────────── Library ─────────────────────────
-- Every file a person uploads for their posts (POST /api/media/upload) leaves a row here, so the Library tab can list, reuse and delete
-- it and the storage can be counted against the plan's `storageMb`. Studio videos are NOT here: they have their own table, `videos`.
--   r2_key   the object key in the `vane-media` bucket, the same uuid.ext the public link /api/media/<key> uses
--   alt_text, folder_id, tags, sha256, thumb_key, used_count, last_used_at: reserved for the next steps (alt text, folders and tags,
--   duplicate check, thumbnails), so adding them later does not need a migration of this table
CREATE TABLE IF NOT EXISTS media_assets (
  id           TEXT    PRIMARY KEY,                         -- uuid
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key       TEXT    NOT NULL UNIQUE,
  thumb_key    TEXT,
  kind         TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
  content_type TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  name         TEXT    NOT NULL,
  alt_text     TEXT    NOT NULL DEFAULT '',
  sha256       TEXT,
  folder_id    TEXT,
  tags         TEXT    NOT NULL DEFAULT '[]',
  used_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_media_user ON media_assets(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_user_sha ON media_assets(user_id, sha256) WHERE sha256 IS NOT NULL;

-- ───────────────────────── Social links ─────────────────────────
-- The "Follow Vane" section of the landing page. Edited in /admin → Social: the words, the links and the order are data, the
-- card design is fixed. The section's own heading and intro live in `settings` under the key 'landing.socials'.
--   network    picks the icon: telegram, bluesky, mastodon, threads, linkedin, x, instagram, youtube, tiktok, facebook, github,
--              discord, reddit, other (the list is in lib/socials.ts, the icons in index.html)
--   is_public  shown on the landing page
-- Seeded only while the table is empty, so a link the admin deleted does not come back when this file is run again.
CREATE TABLE IF NOT EXISTS social_links (
  id           TEXT    PRIMARY KEY,                -- 'telegram', 'bluesky'… for the seeded rows, '<network>-<hex>' for new ones
  network      TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  handle       TEXT    NOT NULL DEFAULT '',
  description  TEXT    NOT NULL DEFAULT '',
  url          TEXT    NOT NULL,
  cta_label    TEXT    NOT NULL DEFAULT 'Follow',
  is_public    INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  sort         INTEGER NOT NULL DEFAULT 100,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO social_links (id, network, name, handle, description, url, sort)
SELECT * FROM (
  SELECT 'telegram' AS id, 'telegram' AS network, 'Telegram' AS name, '@vanenews' AS handle, 'News and releases from Vane.' AS description, 'https://t.me/vanenews' AS url, 10 AS sort
  UNION ALL SELECT 'bluesky', 'bluesky', 'Bluesky', '@vaneapp.bsky.social', 'Product updates and tips.', 'https://bsky.app/profile/vaneapp.bsky.social', 20
  UNION ALL SELECT 'mastodon', 'mastodon', 'Mastodon', '@vaneapp@mastodon.social', 'Updates for the fediverse.', 'https://mastodon.social/@vaneapp', 30
) WHERE NOT EXISTS (SELECT 1 FROM social_links);

-- Accounts the admin switched off (login and every API call are refused; sessions are deleted).
CREATE TABLE IF NOT EXISTS user_flags (
  user_id      TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  disabled     INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  reason       TEXT,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ───────────────────────── Traffic analytics ─────────────────────────
-- One row per page view. The browser pings every ~20 s while the tab is visible, which bumps
-- last_at, so  time on page = last_at - started_at  and  session length = max(last_at) - min(started_at).
-- No raw IPs here, only a salted hash; country/city/asn come from Cloudflare.
CREATE TABLE IF NOT EXISTS web_views (
  id          TEXT    PRIMARY KEY,                          -- uuid made by the browser
  sid         TEXT    NOT NULL,                             -- visit (session) id
  visitor_id  TEXT    NOT NULL,                             -- anonymous browser id
  user_id     TEXT,
  path        TEXT    NOT NULL,
  ref_host    TEXT,
  utm_source  TEXT,
  country     TEXT,
  city        TEXT,
  asn         INTEGER,
  device      TEXT,
  ip_hash     TEXT,
  started_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wv_started ON web_views(started_at);
CREATE INDEX IF NOT EXISTS idx_wv_sid     ON web_views(sid);
CREATE INDEX IF NOT EXISTS idx_wv_visitor ON web_views(visitor_id, started_at);

-- Where a user came from (first touch), written at sign-up.
CREATE TABLE IF NOT EXISTS user_attribution (
  user_id       TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  visitor_id    TEXT,
  ref_host      TEXT,
  utm_source    TEXT,
  landing_path  TEXT,
  country       TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ───────────────────────── Security ─────────────────────────
-- Every sign-in / sign-up attempt (including blocked ones), with where it came from.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL DEFAULT (unixepoch()),
  kind     TEXT    NOT NULL CHECK (kind IN ('login', 'register', 'admin_login')),
  ok       INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  reason   TEXT,                                            -- 'bad_password', 'blocked', 'human_check', 'throttled'…
  email    TEXT,
  ip       TEXT    NOT NULL,
  country  TEXT,
  city     TEXT,
  asn      INTEGER,
  as_org   TEXT,
  ua       TEXT
);
CREATE INDEX IF NOT EXISTS idx_aa_ts   ON auth_attempts(ts);
CREATE INDEX IF NOT EXISTS idx_aa_ip   ON auth_attempts(ip, ts);
CREATE INDEX IF NOT EXISTS idx_aa_kind ON auth_attempts(kind, ts);

-- Blocklist. kind: one address, a CIDR range, a whole network (ASN) or a country.
--   source 'manual' and 'auto' (set by the brute-force guard, expires) are enforced everywhere;
--   source 'preset' = hosting / VPN networks, enforced on sign-in and sign-up only (setting block_hosting).
CREATE TABLE IF NOT EXISTS ip_blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('ip', 'cidr', 'asn', 'country')),
  value       TEXT    NOT NULL,
  reason      TEXT,
  source      TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto', 'preset')),
  expires_at  INTEGER,
  created_by  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (kind, value)
);

-- Starter list of hosting / VPN backbones (extend it in /admin → Security).
INSERT OR IGNORE INTO ip_blocks (kind, value, reason, source) VALUES
  ('asn', '9009',   'M247 (VPN / hosting)',                'preset'),
  ('asn', '60068',  'Datacamp / CDN77 (VPN / hosting)',    'preset'),
  ('asn', '212238', 'Datacamp (VPN / hosting)',            'preset'),
  ('asn', '20473',  'Vultr / Choopa (hosting)',            'preset'),
  ('asn', '14061',  'DigitalOcean (hosting)',              'preset'),
  ('asn', '16276',  'OVH (hosting)',                       'preset'),
  ('asn', '24940',  'Hetzner (hosting)',                   'preset'),
  ('asn', '63949',  'Linode / Akamai Connected Cloud',     'preset'),
  ('asn', '16509',  'Amazon AWS (hosting)',                'preset'),
  ('asn', '14618',  'Amazon AWS (hosting)',                'preset'),
  ('asn', '396982', 'Google Cloud (hosting)',              'preset'),
  ('asn', '15169',  'Google (hosting)',                    'preset'),
  ('asn', '39351',  '31173 Services / Mullvad (VPN)',      'preset'),
  ('asn', '136787', 'PacketHub (VPN infrastructure)',      'preset'),
  ('asn', '207137', 'PacketHub (VPN infrastructure)',      'preset'),
  ('asn', '202425', 'IP Volume (VPN / proxy hosting)',     'preset'),
  ('asn', '49453',  'Global Layer (VPN / hosting)',        'preset'),
  ('asn', '62240',  'Clouvider (hosting)',                 'preset');

-- Answers from the optional VPN/proxy lookup API (cached, so we never ask twice a day for one address).
CREATE TABLE IF NOT EXISTS ip_intel (
  ip          TEXT    PRIMARY KEY,
  is_proxy    INTEGER NOT NULL DEFAULT 0,
  kind        TEXT,
  checked_at  INTEGER NOT NULL
);

-- Admin sign-in is separate from user sign-in: its own table, cookie and short lifetime.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id          TEXT    PRIMARY KEY,                          -- sha256 hex of the cookie token
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL
);

-- Who changed what in the admin panel.
CREATE TABLE IF NOT EXISTS admin_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL DEFAULT (unixepoch()),
  action  TEXT    NOT NULL,
  target  TEXT,
  detail  TEXT,
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON admin_audit(ts);
CREATE INDEX IF NOT EXISTS idx_wv_user ON web_views(user_id);

-- ───────────────────────── Public API: Idempotency-Key (API part 3) ─────────────────────────
-- A retried POST /api/v1/posts (Make and Zapier retry on timeouts) carrying the same Idempotency-Key must not create a
-- second post or take a second unit of quota: the first answer is stored here and replayed.
--   idem_key      "<live|test>:<the client's key>"  (a test run never collides with a live one)
--   request_hash  sha256 of the canonical request body: the same key with a DIFFERENT body is refused (422)
--   state         'processing' while the first request runs, 'done' once its answer is stored
--   locked_at     when the claim was taken (a claim older than a minute is treated as abandoned)
--   expires_at    keys are remembered for 24 hours
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idem_key         TEXT    NOT NULL,
  request_hash     TEXT    NOT NULL,
  state            TEXT    NOT NULL CHECK (state IN ('processing', 'done')),
  response_status  INTEGER,
  response_body    TEXT,
  locked_at        INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- ───────────────────────── Mastodon: the app Vane registered on each server, and sign-in attempts ─────────────────────────
-- Every Mastodon server hands out its own client_id / client_secret: Vane registers itself once per server (and per callback address) and reuses it.
CREATE TABLE IF NOT EXISTS mastodon_apps (
  instance      TEXT    NOT NULL,                           -- host, lowercase, e.g. "mastodon.social"
  redirect_uri  TEXT    NOT NULL,
  client_id     TEXT    NOT NULL,
  client_secret TEXT    NOT NULL,                           -- encrypted at app level, like channel credentials
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (instance, redirect_uri)
);

-- One row = a person who was sent to a server's "Allow access" page and has not come back yet. Single use, 10 minutes.
-- Only the SHA-256 of the `state` is stored; the callback must come from the SAME signed-in user who started it.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash  TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT    NOT NULL,                             -- 'mastodon'
  instance    TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',                  -- display name chosen in the dashboard ('' = use the account name)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);

-- What the browser learns about a video while it uploads it: a preview frame and its length. Optional (a video without
-- them just shows a placeholder). Separate table so `videos` never needs an ALTER and this file stays re-runnable.
CREATE TABLE IF NOT EXISTS video_assets (
  video_id    TEXT    PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  thumb_key   TEXT,                                                             -- R2 key of the JPEG preview, 'videos/<user id>/<video id>.jpg'
  duration_ms INTEGER,
  width       INTEGER,
  height      INTEGER,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The cover a person chose for a video (a picture they uploaded; it wins over the frame in video_assets). Separate table for the same
-- reason: no ALTER, this file stays re-runnable.
CREATE TABLE IF NOT EXISTS video_covers (
  video_id     TEXT    PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  r2_key       TEXT    NOT NULL,                                                    -- 'videos/<user id>/<video id>.cover.<jpg|png|webp>'
  content_type TEXT    NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width        INTEGER,
  height       INTEGER,
  size_bytes   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- A public link: anyone who has the address can watch/download the video. One link per video; removing it kills the address.
-- Platforms that pull a file by URL (TikTok, Instagram Reels) and the "announce in Vane Post" hand-off use it.
CREATE TABLE IF NOT EXISTS video_links (
  token       TEXT    PRIMARY KEY,                                              -- 192 random bits, base64url (32 chars): unguessable
  video_id    TEXT    NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ───────────────────────── Webhooks: where Vane tells other systems that a post was published or failed ─────────────────────────
-- Make / Zapier subscribe here (REST hooks); anyone can subscribe with an API key: POST /api/v1/webhooks.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id           TEXT    PRIMARY KEY,                         -- uuid
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url          TEXT    NOT NULL,                            -- https only
  events       TEXT    NOT NULL,                            -- JSON array: "post.published", "post.failed"
  secret       TEXT    NOT NULL,                            -- signs every delivery; encrypted at app level, shown to its owner once
  last_status  INTEGER,                                     -- HTTP status of the latest delivery attempt (0 = no answer)
  disabled_at  INTEGER,                                     -- set when the receiver answers 410 Gone
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_user ON webhook_subscriptions(user_id);

-- The outbox: one row per event per subscription. The cron worker sends what is due and retries with a growing delay.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               TEXT    PRIMARY KEY,                     -- uuid, sent as the event id (receivers can de-duplicate on it)
  subscription_id  TEXT    NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event            TEXT    NOT NULL,
  payload          TEXT    NOT NULL,                        -- the JSON body that is sent
  status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

-- ───────────────────────── Vane Studio channels (where videos are published) ─────────────────────────
-- Same idea as `channels` in Vane Post, for the video networks: YouTube, TikTok, Instagram Reels. The connect flows open one by
-- one as each network approves Vane (SOCIAL_PLATFORMS_VERIFICATION.md §5, §7, §8); until then the table stays empty.
CREATE TABLE IF NOT EXISTS video_channels (
  id           TEXT    PRIMARY KEY,                                             -- uuid
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL CHECK (platform IN ('youtube', 'tiktok', 'instagram')),
  name         TEXT    NOT NULL,                                                -- display label, e.g. the channel or account name
  account_ref  TEXT,                                                            -- the network's own account id: stops the same account being connected twice
  credentials  TEXT    NOT NULL,                                                -- JSON (OAuth tokens), encrypted at app level like `channels`
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_video_channels_user ON video_channels(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_channels_account ON video_channels(user_id, platform, account_ref);

-- Vane Studio AI (script, titles, descriptions, tags, chapters): one row per account and month. The allowance itself lives in code (videoai.ts).
CREATE TABLE IF NOT EXISTS video_ai_usage (
  user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period   TEXT    NOT NULL,                                                    -- 'YYYY-MM' (UTC)
  used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

-- Extra AI credits an admin gave to one account (admin → user → AI credits). Spent after the plan's own credits, before any billing.
CREATE TABLE IF NOT EXISTS user_ai_bonus (
  user_id     TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credits     INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ───────────────────────── Vane Studio publishing queue ─────────────────────────
-- One row = one video going to one channel. The queue is network-agnostic: a network's own publisher (YouTube, TikTok,
-- Instagram) is plugged in behind it (functions/api/lib/videopublishers.ts), so retries, history and the dashboard are the
-- same for all of them. Rows are claimed atomically (queued → publishing), retried with a growing pause, and kept as history.
CREATE TABLE IF NOT EXISTS video_publications (
  id               TEXT    PRIMARY KEY,                                         -- uuid
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id         TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  channel_id       TEXT    REFERENCES video_channels(id) ON DELETE SET NULL,    -- NULL once the channel was disconnected
  platform         TEXT    NOT NULL CHECK (platform IN ('youtube', 'tiktok', 'instagram')),
  channel_name     TEXT    NOT NULL,                                            -- kept, so the history still reads well after a disconnect
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  privacy          TEXT    NOT NULL DEFAULT 'private' CHECK (privacy IN ('private', 'unlisted', 'public')),
  status           TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'publishing', 'published', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,                                            -- when a queued row is next due (unix seconds)
  claimed_at       INTEGER,                                                     -- when a worker took it (a stuck claim is released after 10 minutes)
  last_error       TEXT,
  external_id      TEXT,                                                        -- the network's id of the published video
  external_url     TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_video_publications_due  ON video_publications(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_video_publications_user ON video_publications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_video_publications_video ON video_publications(video_id);

-- Choices made in the publish dialog that only one network needs (YouTube: made for kids, category). JSON; a separate table so this file stays re-runnable.
CREATE TABLE IF NOT EXISTS video_publication_options (
  publication_id TEXT PRIMARY KEY REFERENCES video_publications(id) ON DELETE CASCADE,
  options        TEXT NOT NULL
);

-- Vane AI Pass (admin → Plans → "Vane AI Pass"): $2.99 a month, 150 AI credits, on top of any posting plan. Not on the landing page (is_public = 0).
-- Nobody pays for it online yet: an admin switches it on for an account (admin → user → AI credits); a payment webhook will write the same row.
CREATE TABLE IF NOT EXISTS ai_pass (
  user_id             TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_end  INTEGER,                                                  -- NULL = no end date (granted by hand)
  provider            TEXT    NOT NULL DEFAULT 'manual',
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS ai_pass_usage (
  user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period   TEXT    NOT NULL,                                                    -- 'YYYY-MM' (UTC)
  used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
CREATE TABLE IF NOT EXISTS ai_history (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool        TEXT    NOT NULL,
  prompt      TEXT    NOT NULL,
  result      TEXT    NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ai_history_user ON ai_history(user_id, created_at DESC);
INSERT OR IGNORE INTO plans (id, kind, name, tagline, price_cents, features, limits, cta_label, is_public, is_active, sort) VALUES
  ('ai-pass', 'addon', 'Vane AI Pass', '150 AI credits a month for tone, hooks, per-network versions and posts from an idea.', 299,
   '["150 AI credits a month","Tone fixer, hooks, CTAs, per-network versions, post generator","Extra credits are billed per use, only if you switch it on"]',
   '{"aiCredits":150,"overageAiPostUsd":0.02}', 'Get AI Pass', 0, 1, 60);

-- ───────────────────────── Payments ─────────────────────────
-- One row per checkout. The page creates it (status 'pending'), the payment arrives (Monobank webhook / Solana check / an admin
-- confirms it by hand), and `fulfillOrder` (functions/api/lib/billing.ts) flips it to 'paid' ONCE and switches the plan on.
--   plan_id     the plans.id that was bought; amount_cents is what that plan cost WHEN the order was made (later price edits do not touch it)
--   provider    'monobank' (card / Apple Pay / Google Pay on the Monobank page) | 'crypto' (USDT or USDC on Solana)
--   provider_ref  Monobank: invoiceId                 crypto: the token mint address
--   pay_micro   crypto: the exact amount to send in millionths of a token (the price plus a few micro-cents that make it unique)
--   tx_ref      crypto: the Solana transaction signature that paid it (UNIQUE: one transaction pays one order)
--   billing     JSON { name, email, country, company, vatId } typed on the checkout page
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       TEXT    NOT NULL,
  plan_name     TEXT    NOT NULL DEFAULT '',
  interval      TEXT    NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency      TEXT    NOT NULL DEFAULT 'USD',
  provider      TEXT    NOT NULL CHECK (provider IN ('monobank', 'crypto')),
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
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, provider, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice ON orders(provider_ref) WHERE provider = 'monobank' AND provider_ref IS NOT NULL;

-- The Suite bundle (Post Pro + Studio in ONE plan and ONE payment, ECONOMY_AND_FINANCE.md §2.6). It shows on /pricing as "Coming soon"
-- until you switch it on in /admin → Plans (tick Active, untick Coming soon). Buying it switches on Pro posting AND Vane Studio together.
INSERT OR IGNORE INTO plans (id, name, tagline, badge, price_cents, yearly_price_cents, features, limits, cta_label, highlight, coming_soon, is_public, is_active, sort) VALUES
  ('suite', 'Vane Suite', 'Posting and video in one plan.', 'Best value', 1800, 17900,
   '["Everything in Vane Post Pro: 1,000 posts a month, unlimited channels","Everything in Vane Studio: video library, API and AI","Post a new video to all your networks in one click","One payment, one renewal date, one invoice","Vane AI Pass included"]',
   '{"postsPerMonth":1000,"aiCredits":250,"apiAccess":0,"overagePostUsd":0.015,"overageAiPostUsd":0.045}', 'Get Suite', 0, 1, 1, 0, 45);
-- A Suite row from an earlier run of this file (hidden, never edited) becomes the public "coming soon" card. An edited row is left alone.
UPDATE plans SET is_public = 1, coming_soon = 1, badge = 'Best value', yearly_price_cents = 17900, tagline = 'Posting and video in one plan.',
  features = '["Everything in Vane Post Pro: 1,000 posts a month, unlimited channels","Everything in Vane Studio: video library, API and AI","Post a new video to all your networks in one click","One payment, one renewal date, one invoice","Vane AI Pass included"]'
  WHERE id = 'suite' AND is_public = 0 AND is_active = 0 AND coming_soon = 0 AND updated_at = created_at;

-- ═════════════════════ Admin: networks on/off and the AI token ledger ═════════════════════

-- The admin's on/off switch per network (/admin → Networks). No row = the default: ON for a network whose code is
-- written (lib/networks.ts), OFF otherwise. A network can only be switched on when its code exists, whether or not
-- the platform's own review / verification has passed (that is tracked in `note`).
CREATE TABLE IF NOT EXISTS network_flags (
  network     TEXT    PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  note        TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by  TEXT
);

-- One row per model call: how many tokens the AI features used and what they cost us (/admin → AI).
-- cost_micro is a snapshot in micro-dollars at the price of that moment, so a later price edit never rewrites history.
-- estimated = 1 when the provider sent no usage numbers and the tokens are a ~4 characters per token guess.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id       TEXT,                                       -- null = a system task, not a user's click
  tool          TEXT    NOT NULL,                           -- 'hashtags', 'tone', … or the name of a future feature
  model         TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated     INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  neurons       REAL    NOT NULL DEFAULT 0,                 -- Cloudflare bills Workers AI in neurons (10 000 a day are free)
  cost_micro    INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),
  ms            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_ts   ON ai_usage(ts);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_ai_usage_tool ON ai_usage(tool, ts);

-- What a model costs. Edit it in /admin → AI when Cloudflare changes prices or a new model is used; a model with
-- no row here is still counted in tokens, just shown as "no price set".
CREATE TABLE IF NOT EXISTS ai_prices (
  model                 TEXT    PRIMARY KEY,
  input_usd_per_m       REAL    NOT NULL DEFAULT 0,
  output_usd_per_m      REAL    NOT NULL DEFAULT 0,
  input_neurons_per_m   REAL    NOT NULL DEFAULT 0,
  output_neurons_per_m  REAL    NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);
-- developers.cloudflare.com/workers-ai/platform/pricing (page updated 2026-10-20, checked 2026-10-21). Set AI_MODEL to any of these (or add a row in /admin → AI).
INSERT OR IGNORE INTO ai_prices (model, input_usd_per_m, output_usd_per_m, input_neurons_per_m, output_neurons_per_m) VALUES
  ('@cf/meta/llama-3.1-8b-instruct-fp8',      0.152, 0.287, 13778,  26128),   -- the model the AI tools run on (lib/ai.ts AI_MODEL)
  ('@cf/meta/llama-3.1-8b-instruct',          0.282, 0.827, 25608,  75147),   -- the previous default, kept for the history
  ('@cf/meta/llama-3.1-8b-instruct-fp8-fast', 0.045, 0.384,  4119,  34868),
  ('@cf/meta/llama-3.3-70b-instruct-fp8-fast',0.293, 2.253, 26668, 204805),
  ('@cf/meta/llama-4-scout-17b-16e-instruct', 0.270, 0.850, 24545,  77273),
  ('@cf/openai/gpt-oss-20b',                  0.200, 0.300, 18182,  27273),
  ('@cf/openai/gpt-oss-120b',                 0.350, 0.750, 31818,  68182),
  ('@cf/google/gemma-4-26b-a4b-it',           0.100, 0.300,  9091,  27273),
  ('@cf/qwen/qwen3-30b-a3b-fp8',              0.051, 0.335,  4625,  30475);

-- Vane Studio AI: what the user chose to do when the plan's generations run out (default: stop), and what the extra ones cost.
CREATE TABLE IF NOT EXISTS video_ai_settings (
  user_id          TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  overage_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (overage_enabled IN (0, 1)),     -- 1 = keep going past the included generations, billed per generation
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Generations beyond the included ones, per plan period: how many and what they cost (millionths of a dollar: $0.02 = 20000).
CREATE TABLE IF NOT EXISTS video_ai_overage (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period     TEXT    NOT NULL,                                                       -- the same key as video_ai_usage.period
  uses       INTEGER NOT NULL DEFAULT 0,
  micro_usd  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

-- ───────────────────────── Integrations: admin switches and demand statistics ─────────────────────────
-- /admin → Integrations. The CATALOG (Claude, ChatGPT, Make, Zapier, WordPress, direct API) lives in code
-- (functions/api/lib/integrations.ts); these tables only hold what the admin changes and what the traffic says.
--   NOTE for databases created before this: api_keys gained an `integration` column. CREATE TABLE IF NOT EXISTS cannot add it,
--   so run ONCE:  npm run db:migrate:integrations   (the code works without it, it just cannot tell the label of a key)

-- One row per integration, created the first time the admin touches it (no row = enabled, no notes).
CREATE TABLE IF NOT EXISTS integration_settings (
  id          TEXT    PRIMARY KEY,                              -- 'claude' | 'chatgpt' | 'make' | 'zapier' | 'wordpress' | 'api'
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),   -- 0: requests from it are refused (403 integration_disabled)
  listing     TEXT    NOT NULL DEFAULT '',                      -- where the store / marketplace review stands (free choice from a short list)
  note        TEXT    NOT NULL DEFAULT '',                      -- the admin's own words
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- How much each integration is used: one row per (UTC day, integration, key, operation), counted on every authenticated
-- API request. Small on purpose (no per-request log, no IPs, no bodies); history survives a revoked or deleted key.
CREATE TABLE IF NOT EXISTS api_usage_daily (
  day          TEXT    NOT NULL,                                -- 'YYYY-MM-DD' (UTC)
  integration  TEXT    NOT NULL,
  key_id       TEXT    NOT NULL,
  op           TEXT    NOT NULL,                                -- 'POST /posts', 'GET /posts/:id', 'mcp:vane_create_post' …
  requests     INTEGER NOT NULL DEFAULT 0,
  last_at      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, integration, key_id, op)
);
CREATE INDEX IF NOT EXISTS idx_api_usage_daily_day ON api_usage_daily(day);

-- ───────────────────────── Contact form (/about#contact) ─────────────────────────
-- Every message is kept, so nothing is lost when the email could not be sent. Read them in the D1 Console:
--   SELECT datetime(created_at,'unixepoch') AS at, topic, name, email, message, mailed FROM contact_messages ORDER BY id DESC LIMIT 50;
CREATE TABLE IF NOT EXISTS contact_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  topic       TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  ip          TEXT,
  mailed      INTEGER NOT NULL DEFAULT 0 CHECK (mailed IN (0, 1))
);

-- ───────────────────────── Age gate (new accounts must be 16+) ─────────────────────────
-- We keep only the fact that the person confirmed their age at sign-up, never the date of birth.
-- Accounts that existed before the gate have no row.
CREATE TABLE IF NOT EXISTS age_confirmations (
  user_id       TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  min_age       INTEGER NOT NULL,
  confirmed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

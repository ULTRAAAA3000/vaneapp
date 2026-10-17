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
--   limits  JSON, e.g. {"channels":2,"postsPerMonth":1000,"postsLifetime":30,"aiCredits":10,"apiPostsPerMonth":180,
--                       "overagePostUsd":0.03,"overageAiPostUsd":0.09}; a missing key or null = unlimited
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

-- Seed = the plans from ECONOMY_AND_FINANCE.md. INSERT OR IGNORE: re-running this file never
-- overwrites what the admin has edited since.
INSERT OR IGNORE INTO plans (id, name, tagline, price_cents, features, limits, sort) VALUES
  ('free', 'Free Trial', 'No card required.', 0,
   '["30 posts in total","Up to 2 connected channels","10 free AI credits","Free AI utilities","Try the dashboard and the API"]',
   '{"channels":2,"postsLifetime":30,"aiCredits":10}', 10);
INSERT OR IGNORE INTO plans (id, name, tagline, price_cents, features, limits, sort) VALUES
  ('api', 'Developer API', 'A headless gateway for scripts and bots.', 599,
   '["REST API with Bearer auth, webhooks and an OpenAPI spec","180 API posts a month (about 6 a day)","Custom GPT and Claude MCP access when they launch","Extra posts: $0.03 each, $0.09 for AI posts"]',
   '{"postsPerMonth":180,"overagePostUsd":0.03,"overageAiPostUsd":0.09}', 20);
INSERT OR IGNORE INTO plans (id, name, tagline, badge, price_cents, compare_price_cents, yearly_price_cents, features, limits, highlight, sort) VALUES
  ('pro', 'Pro Dashboard', 'standard, or $99 a year.', 'Early Bird', 999, 1200, 9900,
   '["Full dashboard with calendar and Kanban","Unlimited workspaces and channels","1,000 posts a month","Telegram inline buttons, spoilers and polls","Media library on Cloudflare R2","Vane AI Pass included","Extra posts: $0.015 each, $0.045 for AI posts"]',
   '{"postsPerMonth":1000,"aiCredits":250,"overagePostUsd":0.015,"overageAiPostUsd":0.045}', 1, 30);
INSERT OR IGNORE INTO plans (id, name, tagline, price_cents, features, limits, cta_label, coming_soon, is_active, sort) VALUES
  ('video', 'Video Engine', 'Video publishing, end to end.', 899,
   '["YouTube Shorts, TikTok and Instagram Reels","YouTube long-form with custom thumbnails, playlists and tags","Resumable uploads on Cloudflare R2","AI hooks, scripts, descriptions, tags and timestamps"]',
   '{}', 'Get notified', 1, 0, 40);
INSERT OR IGNORE INTO plans (id, kind, name, tagline, price_cents, limits, is_active, sort) VALUES
  ('api-addon', 'addon', 'Need the dashboard and the API?', 'Add the API to Pro for {price} a month. It adds 180 API posts and keeps Pro’s low overage rates.', 299,
   '{"apiPostsPerMonth":180}', 0, 50);

-- ───────────────────────── Subscriptions ─────────────────────────
-- Source of truth for "what plan does this user have". (users.plan is legacy: its CHECK only allows
-- free/pro, so it cannot hold new plans.) A user's effective plan = best active, unexpired row
-- here, else 'free'. price_cents is a snapshot, so later price edits never rewrite history.
--   source  'admin' = given by hand (never counted as revenue) · 'monobank' | 'crypto' | 'stripe' … = paid
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    TEXT    PRIMARY KEY,                -- uuid
  user_id               TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id               TEXT    NOT NULL REFERENCES plans(id),
  status                TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'expired', 'past_due')),
  source                TEXT    NOT NULL DEFAULT 'admin',
  price_cents           INTEGER NOT NULL DEFAULT 0,
  currency              TEXT    NOT NULL DEFAULT 'USD',
  interval              TEXT    NOT NULL DEFAULT 'month',
  started_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  ends_at               INTEGER,                            -- null = no end date
  canceled_at           INTEGER,
  note                  TEXT,
  granted_by            TEXT,
  provider_customer_id  TEXT,
  provider_ref          TEXT,                               -- provider's subscription / invoice id
  created_at            INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_subs_user   ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status, ends_at);

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

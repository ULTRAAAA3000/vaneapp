-- Run ONCE on an existing database:  npm run db:migrate:feedback
-- The Feedback & Roadmap board in the dashboard: ideas people suggest and vote on. Safe to run twice (IF NOT EXISTS / INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS feedback_items (
  id          TEXT    PRIMARY KEY,                           -- uuid (seed rows: 'seed-<network>')
  user_id     TEXT    REFERENCES users(id) ON DELETE SET NULL, -- NULL = added by you in /admin
  kind        TEXT    NOT NULL DEFAULT 'feature'
              CHECK (kind IN ('network', 'feature', 'bug', 'other')),
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'planned', 'building', 'done', 'declined')),
  hidden      INTEGER NOT NULL DEFAULT 0,                    -- 1 = off the public board (spam, duplicates)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_feedback_items_user ON feedback_items (user_id, created_at);

-- One vote per person per idea; the number shown is COUNT(*) of these rows, so it can never drift.
CREATE TABLE IF NOT EXISTS feedback_votes (
  item_id     TEXT    NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (item_id, user_id)
);

-- The first ideas on the board: networks people can vote to get next (change or add more in /admin → Feedback).
INSERT OR IGNORE INTO feedback_items (id, kind, title, body) VALUES
  ('seed-pinterest', 'network', 'Pinterest', 'Post Pins with an image or video to your boards.'),
  ('seed-x',         'network', 'X (Twitter)', 'Post to X from the same editor.'),
  ('seed-instagram', 'network', 'Instagram posts', 'Photos and carousels to an Instagram Business or Creator account.'),
  ('seed-tumblr',    'network', 'Tumblr', ''),
  ('seed-medium',    'network', 'Medium', 'Cross-post articles.'),
  ('seed-whatsapp',  'network', 'WhatsApp Channels', '');

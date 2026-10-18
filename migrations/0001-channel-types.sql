-- Lets `channels.type` hold the newer networks (bluesky, mastodon, threads).
-- SQLite cannot edit a CHECK in place, so the table is rebuilt.
--
-- Run ONCE on a database created before these networks existed:   npm run db:migrate:networks
-- (a fresh database from schema.sql already has the new CHECK; running this again is harmless, only slower)
--
-- Safety: dropping `channels` fires ON DELETE CASCADE on `posts` (and, through posts, on `logs`) and
-- ON DELETE SET NULL on `logs.channel_id`. Whether or not the platform lets that happen, the rows are
-- copied aside first and put back at the end, so nothing is lost either way.

CREATE TABLE _keep_posts AS SELECT * FROM posts;
CREATE TABLE _keep_logs  AS SELECT * FROM logs;

CREATE TABLE channels_new (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL
               CHECK (type IN ('telegram', 'x', 'linkedin', 'webhook', 'bluesky', 'mastodon', 'threads')),
  name         TEXT    NOT NULL,
  credentials  TEXT    NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO channels_new SELECT id, user_id, type, name, credentials, is_active, created_at, updated_at FROM channels;

PRAGMA defer_foreign_keys = on;
DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

INSERT OR IGNORE INTO posts SELECT * FROM _keep_posts;
INSERT OR REPLACE INTO logs SELECT * FROM _keep_logs;

DROP TABLE _keep_posts;
DROP TABLE _keep_logs;

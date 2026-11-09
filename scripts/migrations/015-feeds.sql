-- Run ONCE on an existing database:  npm run db:migrate:feeds
-- RSS / Atom auto-posting: a feed is watched by the cron worker and every NEW entry becomes a scheduled post.
CREATE TABLE IF NOT EXISTS feeds (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url              TEXT    NOT NULL,
  title            TEXT,
  channel_ids      TEXT    NOT NULL,
  template         TEXT    NOT NULL,
  delay_minutes    INTEGER NOT NULL DEFAULT 30,
  enabled          INTEGER NOT NULL DEFAULT 1,
  baselined        INTEGER NOT NULL DEFAULT 0,
  etag             TEXT,
  last_modified    TEXT,
  next_check_at    INTEGER NOT NULL,
  last_checked_at  INTEGER,
  last_error       TEXT,
  fail_count       INTEGER NOT NULL DEFAULT 0,
  posted_count     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_feeds_due  ON feeds(enabled, next_check_at);
CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);

CREATE TABLE IF NOT EXISTS feed_items (
  feed_id     TEXT    NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (feed_id, guid)
) WITHOUT ROWID;

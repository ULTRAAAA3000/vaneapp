-- Public post previews (/p/<token>). Run once in Cloudflare → D1 → vane-db → Console (running schema.sql does the same).
CREATE TABLE IF NOT EXISTS post_previews (
  token       TEXT    PRIMARY KEY,
  group_id    TEXT    NOT NULL UNIQUE,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_post_previews_user ON post_previews(user_id, created_at DESC);

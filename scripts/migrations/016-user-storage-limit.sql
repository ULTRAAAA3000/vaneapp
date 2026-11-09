-- Run ONCE on an existing database (D1 Console): a library allowance set by hand for one account (Admin -> Users -> Library storage).
CREATE TABLE IF NOT EXISTS user_storage_limits (
  user_id     TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  storage_mb  INTEGER NOT NULL CHECK (storage_mb >= 0),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

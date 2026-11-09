-- Run ONCE on an existing database (D1 Console): who is over their library allowance and since when (3 days to clean up before the newest uploads are removed).
CREATE TABLE IF NOT EXISTS storage_overages (
  user_id  TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  since    INTEGER NOT NULL
);

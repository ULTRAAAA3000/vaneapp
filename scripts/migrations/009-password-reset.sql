-- Run ONCE on an existing database:  npm run db:migrate:password-reset
-- "Forgot password?" (/reset). Without this table the page says the feature is not available yet. Safe to run twice (IF NOT EXISTS).
-- Forgot password: the emailed code that lets someone set a new password. Its own table, NOT email_verifications: that table's
-- codes sign people in or finish a sign-up, and a code for one purpose must never work for another.
CREATE TABLE IF NOT EXISTS password_resets (
  email       TEXT    PRIMARY KEY COLLATE NOCASE,
  code_hash   TEXT    NOT NULL,                             -- HMAC of the code; the code itself is never stored
  attempts    INTEGER NOT NULL DEFAULT 0,                   -- wrong guesses against the current code
  created_at  INTEGER NOT NULL,                             -- when the current code was sent (resend cooldown)
  expires_at  INTEGER NOT NULL                              -- the code stops working here
);
CREATE INDEX IF NOT EXISTS idx_password_resets_exp ON password_resets(expires_at);

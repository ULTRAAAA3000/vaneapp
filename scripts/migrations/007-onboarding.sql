-- Run ONCE on an existing database:  npm run db:migrate:onboarding
-- The onboarding checklist at the top of the dashboard remembers here that a person closed it or saw the confetti.
-- Without this table the card still shows (it cannot remember being closed). Safe to run twice (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS onboarding_progress (
  user_id       TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  dismissed_at  INTEGER,                                                        -- the person closed the card with the cross
  celebrated_at INTEGER                                                         -- the confetti has been shown (or the account was already complete: no confetti for old news)
);

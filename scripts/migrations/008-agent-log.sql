-- Run ONCE on an existing database:  npm run db:migrate:agents
-- The Agents tab (a live log of what Claude, Notion, Obsidian, Make and the API did). Without this table the tab opens but stays empty.
-- Metadata only: counts, times, platform names and error codes, never the text of a post or a key. Safe to run twice (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS agent_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,                           -- also the cursor the tab polls with
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration  TEXT    NOT NULL,                                            -- claude | notion | obsidian | make | zapier | chatgpt | wordpress | api
  via          TEXT    NOT NULL CHECK (via IN ('mcp', 'api')),
  tool         TEXT,                                                        -- the MCP tool, e.g. vane_list_channels
  ok           INTEGER NOT NULL CHECK (ok IN (0, 1)),
  message      TEXT    NOT NULL,                                            -- one line, no post text
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_agent_events_user ON agent_events(user_id, id);

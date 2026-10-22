-- Run ONCE on a database created before /admin → Integrations existed:
--   npm run db:migrate:integrations
-- (= npx wrangler d1 execute vane-db --remote --file=./scripts/migrations/002-api-key-integration.sql)
--
-- Adds api_keys.integration (where an API key is used: claude | chatgpt | make | zapier | wordpress | api) and fills it in
-- for the keys that already exist from their NAME ("Make.com" → make), the same guess the server makes for a key with no label.
-- Safe to skip: everything keeps working without it, the admin just cannot tell what an old key was meant for.
-- Running it twice fails on the ALTER ("duplicate column name"): that means it has already been done.
ALTER TABLE api_keys ADD COLUMN integration TEXT;

UPDATE api_keys SET integration = CASE
  WHEN lower(name) LIKE '%claude%' OR lower(name) LIKE '%anthropic%' OR lower(name) LIKE '%mcp%' THEN 'claude'
  WHEN lower(name) LIKE '%chatgpt%' OR lower(name) LIKE '%gpt%' OR lower(name) LIKE '%openai%' THEN 'chatgpt'
  WHEN lower(name) LIKE '%make%' OR lower(name) LIKE '%integromat%' THEN 'make'
  WHEN lower(name) LIKE '%zapier%' THEN 'zapier'
  WHEN lower(name) LIKE '%wordpress%' THEN 'wordpress'
  ELSE NULL
END
WHERE integration IS NULL;

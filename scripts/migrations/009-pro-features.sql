-- Run ONCE on an existing database:  npm run db:migrate:pro-features
-- Adds the new Pro features (priority dispatch, advanced MCP tools) to the feature lists of the Pro Dashboard and the Suite cards.
-- A line is appended only if the card does not mention it yet, whatever else you changed in /admin → Plans, so it is safe to run
-- twice. Prices, limits and the rest of the text are not touched.
UPDATE plans SET features = json_insert(features, '$[#]', 'Priority dispatch: posts leave on the second you chose'), updated_at = unixepoch()
  WHERE id IN ('pro', 'suite') AND json_valid(features) AND features NOT LIKE '%Priority dispatch%';
UPDATE plans SET features = json_insert(features, '$[#]', 'Advanced MCP tools for Claude and Notion: results, best times, series'), updated_at = unixepoch()
  WHERE id IN ('pro', 'suite') AND json_valid(features) AND features NOT LIKE '%Advanced MCP tools%' AND features NOT LIKE '%advanced MCP tools%';

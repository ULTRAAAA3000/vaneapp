-- Developer API plan text: Claude MCP is live, only the Custom GPT is still to come. Run once in Cloudflare → D1 → vane-db → Console.
UPDATE plans
SET features = REPLACE(features, 'Custom GPT and Claude MCP access when they launch', 'Claude and Notion (MCP) access today, Custom GPT when it launches')
WHERE id = 'api' AND features LIKE '%Custom GPT and Claude MCP access when they launch%';

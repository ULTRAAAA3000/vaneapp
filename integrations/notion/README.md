# Vane for Notion

Notion has no plugin to install: a Notion **Custom Agent** connects to Vane's remote MCP server, the same server Claude uses.

- Server address: `https://vaneapp.dev/api/v1/mcp`
- Tools the agent sees: `vane_list_channels`, `vane_list_posts`, `vane_create_post`
- Sign-in: OAuth 2.1 with PKCE and dynamic client registration. The person presses **Connect** in Notion and **Allow** on Vane's page; Vane makes a key called "Notion connector". Nothing to copy.

## Set up

1. A Notion workspace admin: Settings → Connections → turn on **Enable custom MCP servers**.
2. In the Custom Agent: Settings → **Add connection** → **Custom MCP server**, name `Vane`, paste the address, **Connect**.
3. On Vane's page sign in and press **Allow**.
4. Paste the instructions below into the agent's instructions.

## Agent instructions

```
You are the Vane publisher for this workspace. You post to my social channels through the Vane connector.
1. Before the first post of a conversation, call vane_list_channels and use only the channels it returns.
2. When I point at a Notion page or a database row, post only the text I mean (the page body or its "Post text" property), never the whole page.
3. Always show me the final text, the channels and the time, and wait for my yes before you call vane_create_post. Never post by yourself or on a schedule of your own.
4. I write times in my local time. Send scheduled_at as an ISO 8601 time with its offset.
5. After posting, tell me what was scheduled and for when. If I asked, set that row's Status to "Scheduled".
6. If a tool answers with an error, show me its message and stop. Do not retry with changed text.
```

## A content calendar that publishes

A database with `Post text` (text), `Channels` (multi-select), `Publish at` (date) and `Status` (Draft, Ready, Scheduled). Ask the agent: "Schedule every row in Content calendar with Status Ready." It shows each post and waits for your yes.

## Disconnect

Revoke the key "Notion connector" in the Vane dashboard (API keys), or remove the connection in Notion.

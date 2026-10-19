# Vane for Claude (MCP)

Lets Claude see your Vane channels and schedule posts for you: "post this to Telegram and Bluesky tomorrow at 9:00".

Tools: `vane_list_channels`, `vane_create_post` (`text`, `channels`, `scheduled_at`, optional `media_url`).
Posts go through the normal Vane API, so your plan quota applies. With a `cpost_test_…` key nothing is saved or posted.

## 1. Get a key

Vane dashboard → API keys → create a key. Use `cpost_test_…` to try it, `cpost_live_…` to really post.

## 2. Claude Desktop

1. Install Node.js 18+ (nodejs.org) if you don't have it.
2. Download `vane-mcp.mjs` from this folder (GitHub → file → Download raw file) and put it anywhere, e.g. `Documents/vane-mcp.mjs`.
3. Claude Desktop → Settings → Developer → Edit Config. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vane": {
      "command": "node",
      "args": ["/full/path/to/vane-mcp.mjs"],
      "env": { "VANE_API_KEY": "cpost_live_your_key" }
    }
  }
}
```

4. Restart Claude Desktop. The Vane tools appear under the tools icon.

Once `@vane/mcp-server` is published to npm the file download is not needed: `"command": "npx", "args": ["-y", "@vane/mcp-server"]`.

## Clients that speak remote MCP (Claude Code, the Messages API connector)

Point them at `https://vaneapp.dev/api/v1/mcp` and send `Authorization: Bearer <your key>`.

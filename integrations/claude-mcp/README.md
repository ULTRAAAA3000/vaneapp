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

   The path is where you saved the file: `C:\\Users\\You\\Documents\\vane-mcp.mjs` on Windows (double backslashes), `/Users/you/Documents/vane-mcp.mjs` on macOS. The config file itself is in `%APPDATA%\\Claude` (Windows) or `~/Library/Application Support/Claude` (macOS).
4. Fully quit Claude Desktop (system tray / menu bar → Quit) and open it again. The Vane tools appear under the tools icon.
5. Try with a `cpost_test_…` key: "Show my Vane channels", then "Post 'Hello' to telegram tomorrow at 9:00 UTC". Claude answers `TEST MODE` and nothing is posted.

If the tools do not appear: Node is not installed or the path is wrong (Settings → Developer shows the server as failed with the reason).

Once `@vane/mcp-server` is published to npm the file download is not needed: `"command": "npx", "args": ["-y", "@vane/mcp-server"]`.

## Clients that speak remote MCP (Claude Code, the Messages API connector)

Point them at `https://vaneapp.dev/api/v1/mcp` and send `Authorization: Bearer <your key>`.

# Vane for Claude (connector)

Lets Claude see your Vane channels and schedule posts for you: "post this to Telegram and Bluesky tomorrow at 9:00".

Tools: `vane_list_channels` (read only), `vane_create_post` (`text`, `channels`, `scheduled_at`, optional `media_url`).
Posts go through the normal Vane API, so your plan quota applies.

## Easiest: add it as a connector in Claude (no key, no files)

1. Claude → Settings → Connectors → **Add custom connector**.
2. Name: `Vane`. URL: `https://vaneapp.dev/api/v1/mcp`. Add.
3. Click **Connect**. A Vane page opens: sign in, press **Allow**.
   Prefer your own key? Open "Use my own API key instead" on that page and paste a `cpost_live_…` (real posts) or `cpost_test_…` (nothing is posted) key from the dashboard.
4. Ask Claude: "Show my Vane channels", then "Post 'Hello' to telegram tomorrow at 9:00".

What happens behind the button: Vane creates one API key called "Claude connector" for you (live if your plan has the API, otherwise a test key that posts nothing). To disconnect, revoke that key in the dashboard → API keys.

## Advanced: Claude Desktop with a local file or a key in the config

### 1. Get a key

Vane dashboard → API keys → create a key. Use `cpost_test_…` to try it, `cpost_live_…` to really post.

### 2. Claude Desktop

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

### Clients that send their own header (Claude Code, the Messages API connector)

Point them at `https://vaneapp.dev/api/v1/mcp` and send `Authorization: Bearer <your key>`.

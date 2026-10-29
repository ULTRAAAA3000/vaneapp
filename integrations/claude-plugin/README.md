# Vane for Claude (plugin)

Adds the Vane connector and five commands that show up when you type `/`:

- `/vane:post <text> [channels] [when]`
- `/vane:draft <topic> [channels] [tone]`
- `/vane:channels`
- `/vane:upcoming`
- `/vane:recent`

## Claude Code

```
/plugin marketplace add ULTRAAAA3000/vaneapp
/plugin install vane@vane
```

Then run `/mcp`, choose vane and sign in once.

## Claude (desktop app / Cowork)

Download `vane-for-claude.zip` from https://vaneapp.dev/downloads/vane-for-claude.zip and add it under Plugins, then connect Vane when asked.

The commands also exist as MCP prompts in the connector itself, so any app that lists connector prompts shows them without the plugin.

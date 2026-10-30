> **Soon.** The ChatGPT connector is not offered to users yet: the website, dashboards and public API description say "Soon". The code below is kept for the launch.

# Vane for ChatGPT (Custom GPT)

A Custom GPT that schedules posts through Vane. It uses the public API through its OpenAPI description, no code needed.
Requires a ChatGPT plan that can create GPTs (Plus or higher).

## Setup

1. Vane dashboard → API keys → create a key. Start with `cpost_test_…`: everything works, nothing is posted or counted.
2. ChatGPT → Explore GPTs → Create → **Configure**.
3. Name: `Vane Poster`. Description: `Schedules social posts through Vane.`
4. Instructions, paste:

```
You schedule social media posts with Vane.
Always call listChannels first and use the channel ids it returns.
Before calling createPost, show the user the text, the channels and the time, and wait for a clear "yes".
Times are ISO-8601 with a timezone (e.g. 2026-10-20T09:00:00Z); ask for the timezone if the user did not give one.
After posting, say what was scheduled and where. If the API answers with an error, repeat its message and do not retry on your own.
```

5. **Actions → Create new action → Import from URL**: `https://vaneapp.dev/api/v1/openapi.json` → Import. The actions `getMe`, `getUsage`, `listChannels`, `listPosts`, `createPost`, `getPost`, `cancelPost` appear.
6. Authentication → gear icon → **API Key** → Auth Type **Bearer** → paste the key → Save.
7. Privacy policy: required only if you publish the GPT beyond yourself; Vane has no privacy page yet, so keep the GPT private ("Only me").
8. Create → "Only me". Try: "Show my channels", then "Post 'Hello' to telegram tomorrow at 9:00 Kyiv time".

When it works, replace the test key with a `cpost_live_…` key (Actions → Authentication).

## If something goes wrong

- *Could not parse OpenAPI*: open the URL in a browser; it must show JSON.
- *401 / invalid_api_key*: the key was pasted with a space, or Auth Type is not Bearer.
- *402 quota_exceeded*: the plan's API quota is used up.
- The GPT asks to "Allow" every call: choose "Always allow" for vaneapp.dev.

# Vane for Obsidian

Post or schedule the open note, or the text you selected, to your Telegram, X, LinkedIn, Bluesky, Threads and Mastodon channels through [Vane](https://vaneapp.dev) without leaving Obsidian. Works on desktop and mobile.

## Install

1. In Vane, create an API key (Dashboard → API keys, "Used with: Obsidian plugin"). A test key (`cpost_test_…`) checks everything and posts nothing.
2. Download `vane-for-obsidian.zip` from the Obsidian tab in the Vane dashboard (or `https://vaneapp.dev/downloads/vane-for-obsidian.zip`) and unzip it into `<your vault>/.obsidian/plugins/`, so you get `.obsidian/plugins/vane/`.
3. Obsidian → Settings → Community plugins → turn off Restricted mode, refresh, enable **Vane**.
4. Settings → Vane → paste the key, press **Load channels**.

## Use

Open a note, press Ctrl/Cmd+P and run **Post note to Vane** (or click the send icon in the ribbon). Select text and run **Post selection to Vane** for a part of a note. Tick the channels, choose "As soon as possible" or a time, press Post.

The note is turned into plain post text first: properties, `%%comments%%`, embeds and images are dropped, `**bold**`, headings and `[[wikilinks]]` lose their markers, web links are written out in full, #hashtags and line breaks stay. You can edit the text in the window before sending; both clean-up steps can be switched off in the settings.

Posts made this way count against your Vane plan like any API post. The key lives in `.obsidian/plugins/vane/data.json` inside your vault: keep that file out of anything you share or sync publicly.

## Build from source

From the repository root (it needs only the repo's own dependencies):

```
npm run build:obsidian      # writes integrations/obsidian/main.js and public/downloads/vane-for-obsidian.zip
npm run test:unit           # converter, API calls and "build is current" checks
```

To type-check against Obsidian's own typings: `cd integrations/obsidian && npm install && npm run typecheck`.

Source layout: `src/convert.ts` (Markdown to post text, pure), `src/api.ts` (calls to the Vane API, pure), `src/main.ts` (commands, window, settings).

# Vane for WordPress

Cross-posts your articles to Telegram, Bluesky, Mastodon and the other Vane channels when you publish.

## Install (no terminal)

1. Download `https://vaneapp.dev/downloads/vane-for-wordpress.zip` (the page `https://vaneapp.dev/wordpress` has the same steps).
2. WordPress admin → Plugins → Add New → Upload Plugin → choose the zip → Install → Activate.
3. Vane app → API keys → create a key. Try `cpost_test_…` first: nothing is posted or counted.
4. WordPress admin → **Vane** (left menu) → paste the key → Connect. Plan and channels appear.
5. **Write** tab: type a post, tick channels, Post now or pick a time. **Scheduled** and **History** show what is queued and what went out. Settings: replace the key, turn the article cross-post on or off, default channels.
6. Articles: in the editor sidebar (Post tab) open **Vane Cross-Post**, check the channels and the text, publish.

The dashboard talks only to WordPress (REST routes `vane/v1/*`); the key never reaches the browser. Editors and above can post (`vane_capability` filter, default `edit_others_posts`); only administrators can connect or change the key.

## How it behaves

- Fires once, the moment an article goes from draft/scheduled/pending to published. Editing it later never posts again.
- Text: title, excerpt (or the start of the article), link, cut to the smallest limit of the chosen networks (Bluesky 300, X 280, Mastodon 500, …). Edit it in the sidebar if you want; `{url}` becomes the article link.
- The featured image is attached when its address is https.
- The post is scheduled one minute ahead, so it shows up in the Vane dashboard before it goes out.
- A failed send shows the reason in the sidebar with a **Send now** button. A retry cannot produce a duplicate.
- The key lives in the WordPress database and is only used by the server; the browser never sees it.

## Developers

Filters: `vane_capability`, `vane_post_types` (default `['post']`), `vane_should_share` (return false to skip an article), `vane_api_base`.

`zip -r vane-for-wordpress.zip vane-for-wordpress` builds the package; the copy served at `/downloads/` is `public/downloads/vane-for-wordpress.zip` and must be rebuilt after changes.

Not built yet: AI-written announcements (Vane has no AI endpoint yet) and webhooks.

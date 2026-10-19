# Vane for WordPress

Cross-posts your articles to Telegram, Bluesky, Mastodon and the other Vane channels when you publish.

## Install (no terminal)

1. Download `https://vaneapp.dev/downloads/vane-for-wordpress.zip`.
2. WordPress admin → Plugins → Add New → Upload Plugin → choose the zip → Install → Activate.
3. Vane dashboard → API keys → create a key. Try `cpost_test_…` first: nothing is posted or counted.
4. WordPress admin → Settings → Vane → paste the key → Save. "Connected: … plan, … key" appears; tick the default channels and save again.
5. Write an article. In the editor sidebar (Post tab) open **Vane Cross-Post**, check the channels and the text, publish.

## How it behaves

- Fires once, the moment an article goes from draft/scheduled/pending to published. Editing it later never posts again.
- Text: title, excerpt (or the start of the article), link, cut to the smallest limit of the chosen networks (Bluesky 300, X 280, Mastodon 500, …). Edit it in the sidebar if you want; `{url}` becomes the article link.
- The featured image is attached when its address is https.
- The post is scheduled one minute ahead, so it shows up in the Vane dashboard before it goes out.
- A failed send shows the reason in the sidebar with a **Send now** button. A retry cannot produce a duplicate.
- The key lives in the WordPress database and is only used by the server; the browser never sees it.

## Developers

Filters: `vane_post_types` (default `['post']`), `vane_should_share` (return false to skip an article), `vane_api_base`.

`zip -r vane-for-wordpress.zip vane-for-wordpress` builds the package; the copy served at `/downloads/` is `public/downloads/vane-for-wordpress.zip` and must be rebuilt after changes.

Not built yet: AI-written announcements (Vane has no AI endpoint yet) and webhooks.

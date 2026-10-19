=== Vane for WordPress ===
Contributors: vane
Tags: social media, cross-post, telegram, bluesky, mastodon
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Cross-post your articles to Telegram, Bluesky, Mastodon and more through Vane.

== Description ==

Pick channels in the editor sidebar; when you publish, the title, an excerpt, the link and the featured image go out through your Vane account. You need a free Vane account and an API key (vaneapp.dev).

* Sidebar block "Vane Cross-Post" in the block editor: toggle, channels, editable text with per-network character counters
* Automatic text from the title, excerpt and link, kept inside the smallest limit of the chosen networks
* Works with scheduled posts and the classic editor
* An article is sent once; updating it later never posts again. "Send now" retries a failed one.
* The API key stays on the server and is never shown to the browser

== Installation ==

1. Plugins → Add New → Upload Plugin → choose vane-for-wordpress.zip → Activate.
2. Settings → Vane: paste your API key and save.
3. Edit an article, open the Vane Cross-Post panel in the sidebar, choose channels, publish.

== External service ==

This plugin sends the title, excerpt, link and featured image URL of articles you publish, and your API key, to the Vane API (https://vaneapp.dev/api/v1) so Vane can post them to your connected networks. Nothing is sent until you add a key and publish an article.

== Changelog ==

= 1.0.0 =
First release.

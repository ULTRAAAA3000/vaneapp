=== Vane for WordPress ===
Contributors: vane
Tags: social media, schedule, cross-post, telegram, bluesky
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 2.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A small Vane dashboard inside WordPress: write and schedule social posts, and cross-post every new article to Telegram, Bluesky, Mastodon and more.

== Description ==

Vane for WordPress puts the posting part of [Vane](https://vaneapp.dev) in your admin menu.

**Write and post**

* Type a post, tick channels, see each network's character limit as you type
* Add an image from the Media Library, or insert a link to one of your latest articles
* Post in about a minute, or schedule a time
* See what is scheduled (and cancel it) and what was sent, with links and failure reasons
* Your plan and the posts you have left are always visible

**Cross-post articles**

* A "Vane Cross-Post" panel in the editor sidebar: channels and editable text
* Sent once, when the article first goes live; editing later never posts again
* Works with scheduled articles and the classic editor

You need a free Vane account with your channels connected, and an API key (a test key tries everything and posts nothing). The plugin only needs the key: library, analytics and the rest of Vane stay in the Vane app.

Only Editors and Administrators can post; only Administrators can connect or change the key. The key is stored on your server and is never sent to the browser.

== Installation ==

1. Plugins → Add New → search "Vane for WordPress" (or Upload Plugin with the zip from vaneapp.dev/wordpress) → Install → Activate.
2. In Vane (post.vaneapp.dev) connect your channels and create a key under API keys. Start with a cpost_test_ key.
3. In WordPress open the new Vane menu item, paste the key and press Connect.
4. Write a post on the Write tab, or edit an article and use the Vane Cross-Post panel in the sidebar.

== Frequently Asked Questions ==

= Does it cost anything? =

The plugin is free. Posting for real with a live key needs a Vane plan with API access; test keys are free.

= How do I stop cross-posting articles? =

Vane → Settings → untick "Cross-post new articles". You can also switch it off per article in the editor sidebar.

= Who can use the dashboard? =

Editors and Administrators. Developers can change this with the `vane_capability` filter (default `edit_others_posts`).

= How do I remove it? =

Press Disconnect under Vane → Settings, or deactivate and delete the plugin: its settings are removed. Revoke the key in Vane to cut the access completely.

== External services ==

This plugin connects to the Vane API (https://vaneapp.dev/api/v1) so Vane can publish to your connected networks. It is the whole purpose of the plugin.

What is sent, and when: your Vane API key with every request; when you press Post or Schedule, the text, chosen channels, time and image address you entered; when an article is published with cross-posting on, its title, excerpt, link and featured image address; when you open the dashboard, requests for your channel list, plan and posts. Nothing is sent before you add a key.

Service provider: Vane (https://vaneapp.dev). Terms: https://vaneapp.dev/terms. Privacy policy: https://vaneapp.dev/privacy.

== Changelog ==

= 2.0.0 =
* New: Vane dashboard in the admin menu (write, schedule, queue, history, settings, connect with your key)
* New: Editors can post, only Administrators can change the key
* Settings moved into the dashboard; Settings → Vane still opens it

= 1.0.0 =
First release: editor sidebar and automatic cross-post.

== Upgrade Notice ==

= 2.0.0 =
Adds the Vane dashboard to the admin menu. Your key and settings are kept.

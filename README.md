# Vane — unfairly fast social scheduling

Cloudflare Pages (site + `/api`) · D1 (database) · R2 (images) · a cron Worker (autoposting).

## Layout

| Path | What it is |
|---|---|
| `public/` | Landing, `/login`, `/app` (Vane Post) and `/studio` (Vane Studio) dashboards (static, Tailwind via CDN) |
| `functions/_middleware.ts` | Host routing: `post.` and `studio.` each get their own dashboard and their own slice of the API |
| `functions/api/` | Pages Functions: auth, channels, posts, media, video, waitlist |
| `worker/` | Cron Worker (name set in `worker/wrangler.toml`): every minute it sends due posts |
| `schema.sql` | Whole schema. Idempotent: safe to re-run after every update |

## Setup / deploy checklist (order matters)

1. **R2 bucket** (must exist before the Pages deploy, because `wrangler.toml` binds it):
   `npx wrangler r2 bucket create vane-media`
   If the last Pages deployment failed, open Cloudflare → Workers & Pages → vaneapp → Deployments → **Retry**.
2. **Database:** `npm run db:remote` (idempotent; re-run it after every update that touches `schema.sql`).
3. **Pages secrets** (generate each with `openssl rand -base64 32`):
   `npx wrangler pages secret put ENCRYPTION_KEY --project-name=vaneapp`
   `npx wrangler pages secret put JWT_SECRET --project-name=vaneapp`
4. **Cron worker** (needs the SAME `ENCRYPTION_KEY` as Pages, otherwise saved bot tokens can't be read):
   `npm run cron:deploy`, then `npm run cron:secret`
5. **Quick Connect (optional, recommended)**: publishing through the shared bot.
   1. In Telegram, @BotFather → `/newbot` → username `VanePublishBot` (another name works: set the `SYSTEM_BOT_USERNAME` variable).
   2. Pick a webhook secret: `openssl rand -hex 32`.
   3. Pages secrets: `SYSTEM_BOT_TOKEN` (the bot token) and `TELEGRAM_WEBHOOK_SECRET` (the value from step 2), same `wrangler pages secret put … --project-name=vaneapp` command as above.
   4. **Also give the cron worker the bot token:** `npm run cron:secret-bot` (without it Quick Connect posts cannot be published).
   5. Register the webhook once: `SYSTEM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… npm run telegram:webhook set` (`info` shows delivery errors, `delete` removes it).
   Until steps 3-5 are done the dashboard simply offers **Custom bot** only.
6. **Bot protection (Turnstile, optional, recommended):** Cloudflare dashboard → Turnstile → *Add widget* (hostname `vaneapp.dev`, mode *Managed*).
   - **Site key** (public by design): put it in `wrangler.toml`. This project is configured by that file, which Cloudflare treats as the source of truth, so a plain variable typed into the Pages dashboard is NOT reliably picked up:
     ```toml
     [vars]
     TURNSTILE_SITE_KEY = "0x4AAAAAAA…"
     ```
   - **Secret key:** `npx wrangler pages secret put TURNSTILE_SECRET_KEY --project-name=vaneapp` (do this for Production; Preview has its own secrets).
   - **Redeploy** afterwards: new values only reach new deployments.
   - Sign-in and sign-up then require a passed check. It is enforced only when **both** values are visible to the function (fails closed if Cloudflare is unreachable). Locally use the test keys from `.dev.vars.example`.
   - **Not showing up?** Open `https://vaneapp.dev/api/auth/config`: `"turnstile": { "siteKeySet": …, "secretKeySet": … }` tells you which key the function cannot see (values are never shown). `enabled: true` but still no widget → open the browser console on `/login` (ad-blocker, or the widget's hostname list does not contain `vaneapp.dev`).
7. **Email codes (Resend, optional, recommended):** a 6-digit code is emailed when someone signs up (the account is created only after it is entered) and again when an account has not been opened for more than 3 days. Until it is switched on, sign-up and sign-in work exactly as before. Order matters:
   1. `npm run db:remote` **first** (two new tables, `email_verifications` and `user_activity`; safe to re-run).
   2. [resend.com](https://resend.com) → *Domains* → add `vaneapp.dev` and put the DNS records it shows (SPF, DKIM) into Cloudflare DNS; wait until it says *Verified*. (`onboarding@resend.dev` only delivers to your own Resend address: fine for a first test, useless for real users.)
   3. Resend → *API Keys* → create a key with *Sending access*, then: `npx wrangler pages secret put RESEND_API_KEY --project-name=vaneapp`
   4. `EMAIL_FROM` is a plain value, so (like the Turnstile site key) put it in the **root** `wrangler.toml` under `[vars]`: `EMAIL_FROM = "Vane <noreply@vaneapp.dev>"`, then redeploy.
   **Both belong to the Pages project.** The mail is sent by the Pages Functions (`functions/api/lib/mail.ts`); the cron worker never sends email, so nothing from this step goes into `worker/` (a key put there does nothing).
   The email has a **Copy code** button: a mail client runs no scripts, so it opens `/copy` (`public/copy.html`, `public/assets/copy.js`), which copies the code with one tap. The code rides in the URL fragment (`/copy#123456`), which browsers never send to a server, and the page removes it from the address bar right away.
   It is enforced only when **both** values are set. **No email arrives?** Open `https://vaneapp.dev/api/auth/config`: `"email": { "enabled": true, … }` must be `true`; `false` says which of `apiKeySet` / `fromSet` the function cannot see (and means sign-up skips the code entirely). `enabled: true` but still nothing → Cloudflare → Pages → vaneapp → Functions → Logs: a line `resend rejected the email` carries Resend's reason (most often the sender domain is not *Verified*), and the sign-up screen shows "We couldn't send the email". Once on, the account of anyone away for more than 3 days asks for a code at the next sign-in and all their old sessions are ended; accounts that already exist start their 3 days from their next visit. Resend's free plan is limited (check their current quota), so watch it if sign-ups spike.
   Tuning: `AWAY_AFTER_SECONDS` in `functions/api/lib/activity.ts` (3 days); `CODE_TTL_SECONDS`, `RESEND_COOLDOWN_SECONDS`, `MAX_WRONG_GUESSES` in `functions/api/lib/emailcode.ts` (10 min, 60 s, 5).
8. **Subdomains (Vane Post and Vane Studio).** One Pages project serves three hosts; `functions/_middleware.ts` picks the product by host:
   - Cloudflare → Workers & Pages → vaneapp → **Custom domains** → add `post.vaneapp.dev` and `studio.vaneapp.dev` (next to `vaneapp.dev`; the DNS records are created for you when the zone is on Cloudflare).
   - Turnstile: the widget's hostname list must cover both (`vaneapp.dev` covers its subdomains; check it if the widget does not appear on `post.` or `studio.`).
   - `post.vaneapp.dev` is the posting dashboard, `studio.vaneapp.dev` the video dashboard; on the main site `/app` and `/studio` forward to them. The sign-in cookie is set for the whole `vaneapp.dev` domain, so one sign-in covers both. **Everyone is asked to sign in once more after this release** (the old cookie belonged to `vaneapp.dev` alone).
   - The main site keeps serving the whole API, so existing integrations (Make, Zapier, scripts) keep working unchanged.
   - Locally there are no subdomains: `/app` and `/studio` are plain paths. To test the routing without touching DNS: `npm run test:hosts`.
9. **Check it live:** sign up at `/login`, connect a Telegram channel, press *Send test*, schedule a post 2–3 minutes ahead and watch `npm run cron:logs`.

Never lose `ENCRYPTION_KEY`: without it every stored channel token is unreadable.

## Telegram connection methods

| | Quick Connect | Custom bot |
|---|---|---|
| Whose bot | shared `@VanePublishBot` | the user's own (from @BotFather) |
| User does | add the bot as admin, enter `@channel`, post a one-time code in it | create a bot, paste its token |
| Stored per channel | only the chat id (encrypted); **no token** | token + chat id (AES-256-GCM) |

**Why the one-time code?** The shared bot is an admin in many channels, so "the bot can post there" says nothing about who owns the channel. Only an admin can post the code, and the bot sees it through the webhook, so ownership is proven before the channel is connected.

## Bluesky connection

Connect it in the dashboard: *Connect → Bluesky*, then handle + **app password** (Bluesky → Settings → Privacy and security → App passwords). A normal password is refused on purpose; an app password can only post, and deleting it in Bluesky disconnects Vane.

- **Deploy order:** a database made before Bluesky existed refuses the new channel type. Run **`npm run db:migrate:networks` once** (it rebuilds `channels` with the wider CHECK and puts every post and log back; safe to repeat). Until then connecting Bluesky answers `503` with that command, nothing else is affected. A fresh `npm run db:remote` already has the new CHECK.
- Deploy the Pages project **and** the cron Worker (`npm run cron:deploy`): the Worker does the publishing. `ENCRYPTION_KEY` must be the same on both, as for Telegram.
- Text: 300 graphemes (an emoji counts as 1) and at most 3000 bytes. Links and `#tags` become clickable. One image per post (JPEG, PNG, WebP or GIF, **up to 1 MB**, a Bluesky limit); video is not supported yet and is refused when scheduling.
- Only `bsky.social` accounts and custom handles hosted there are supported. A self-hosted server address is deliberately not accepted.
- The worker signs in once per channel per run. A revoked app password fails the post with "Reconnect the account"; Bluesky 429/5xx are retried like Telegram's.
- `external_id` of a sent post is its `at://` address. "Send test" is Telegram-only: a test would be a public post.

## Mastodon connection

Connect it in the dashboard: *Connect → Mastodon*, type your server (`mastodon.social`; a pasted profile link or `@me@server` works too), press **Authorize** on your server, and you land back in Vane. There is nothing to create or approve in advance: Vane registers itself on each server the first time someone uses it (`POST /api/v1/apps`) and remembers that registration.

- **Deploy order:** the flow needs two new tables (`mastodon_apps`, `oauth_states`): run `npm run db:remote` (safe to repeat). It also needs the `channels` CHECK from the Bluesky update (`npm run db:migrate:networks`, once). Without them the dashboard says what is missing; nothing else is affected.
- **Callback address:** `<APP_URL>/api/channels/mastodon/callback` (falls back to the address the request came to). It is registered on each server together with the app, so change `APP_URL` only on purpose: a new address means a fresh registration.
- **Permissions asked for:** `read:accounts write:statuses write:media` only. Vane cannot read the timeline, follow, block or edit the account. The person can withdraw access any time in their server's *Preferences → Account → Authorized apps*.
- **Safety:** the server name is checked before anything is fetched (public DNS name only: no IP addresses, ports, `localhost`, `.local`/`.internal` names, or Vane itself) and redirects are never followed. The `state` is random, single use, valid 10 minutes, stored only as a hash and tied to the user who started it. Access token and per-server client secret are encrypted like every channel secret. 10 starts per user and 30 per IP per hour.
- **Posting:** public posts, text up to **500 characters with every link counted as 23** (the real limit of a server can be higher; we use the common default). One image per post (JPEG, PNG, WebP or GIF, up to 8 MB); video is not supported yet and is refused when scheduling. Each post is sent with an `Idempotency-Key` equal to its id, so a retry after a lost answer can't publish twice. `external_id` is the status URL.
- **Servers whose web address differs from the account domain** (a `WEB_DOMAIN` redirect) are not followed: use the address of the server's web site.
- "Send test" is Telegram-only (a test would be a public post).

## Local development

```
cp .dev.vars.example .dev.vars   # then fill in two random secrets
npm run db:local && npm run dev
npm run cron:dev                 # separate terminal; trigger a tick: curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## How autoposting behaves

- Every minute the worker claims up to 20 due posts in a single atomic statement, so overlapping runs can never send a post twice, and a post cancelled in time is never sent.
- Temporary failures (network, Telegram 429/5xx) retry with backoff (2, 4, 8, 15 min) up to 5 attempts; permanent ones (bot removed, bad image) fail immediately with the reason shown in the dashboard.
- A post more than 2 hours late is marked failed instead of being published stale.
- If `ENCRYPTION_KEY` is missing in the worker, it touches nothing.

## Public API: keys, plans and quotas

Spec: `ECONOMY_AND_FINANCE.md` §2 and §6, `SECURITY_ARCHITECTURE.md` §2-3. Built in parts; **part 1 (this) is the engine**.

| Part | What | Status |
|---|---|---|
| 1 | Tables, key generation and hashing, key auth, scopes, test mode, quota engine with 402, `/api/v1/*`, usage | done |
| 2 | "API access" section in the dashboard: create / revoke keys, quota meter, quick start | done |
| 3a | OpenAPI spec and `Idempotency-Key` (safe retries from Make / Zapier) | done |
| 3b | Webhooks: signed `post.sent` / `post.failed` / `post.cancelled` events, retries | next |
| 4 | Payments (Monobank, USDT/USDC) that grant the plan and issue keys automatically | |
| 5 | AI endpoints on Workers AI (reformat, tone, hooks) with their own metering | |

> **After pulling this update run `npm run db:remote`** (four new tables: `subscriptions`, `api_keys`, `usage_counters`, `usage_logs`; safe to re-run). Until then the dashboard keeps working, its posts are simply not counted yet, but keys and `/api/v1` answer with errors.

### Keys

| Key | Does |
|---|---|
| `cpost_live_…` | real posts, counted against the plan's API quota |
| `cpost_test_…` | **simulated**: validated like a live request and answered with `"test": true`, but nothing is posted, saved or counted. Allowed on every plan |
| `cvid_live_…` / `cvid_test_…` | Video Engine (format reserved, endpoints come with that product) |

Each key is 24 random characters (`crypto.getRandomValues`, no modulo bias) and unique to one account. Only its **SHA-256** is stored; the key is shown **once**, when it is created. A key never opens dashboard routes, and a key cannot mint other keys. Up to 10 active keys per account, 100 requests a minute per key (`429` + `Retry-After`).

Keys are created in the dashboard, in the **API access** section (`/app#api`):

- **Quota card**: plan, posts used / limit with a meter (green, amber from 80%, red at 100%), when it resets, and what happens over the limit (a 402, or the price per extra post when overage is on). Plans without API access (Pro without the Add-on) get an explanation instead of a meter.
- **Keys**: name, Live/Test badge, masked key (`cpost_live_••••ab12`), created / last used, and a two-step **Revoke**.
- **Create key**: name + Live or Test. The full key is shown **once**, with a Copy button; a stray click outside or Esc will not close the dialog while it is unsaved, and the secret is wiped from the page when it closes. Live is disabled (and Test preselected) on plans without API access.
- **Quick start**: base URL, your channel ids with Copy buttons (what `channelIds` needs), and a ready `curl` request with a `$VANE_API_KEY` placeholder (the page never holds a real key after the dialog closes).

The numbers refresh by themselves (every 30 s while the tab is visible, and right after you schedule a post), so API traffic from Make shows up live. If `/api/usage` fails (for example the new tables are not in the database yet) the section shows a calm message and the rest of the dashboard keeps working.

Without the UI, a key can also be created with a session cookie or a dev JWT (`node scripts/dev-token.mjs <JWT_SECRET> <userId>`):

```
curl -X POST https://vaneapp.dev/api/keys -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" -d '{"name":"Make.com"}'
# → { "ok": true, "key": { … }, "secret": "cpost_live_…" }     copy "secret" now, it is never shown again
```

### Endpoints (`Authorization: Bearer <key>`)

| | |
|---|---|
| `GET /api/v1/openapi.json` | the OpenAPI 3.1 description (no key needed) |
| `GET /api/v1/me` | is the key valid, which plan (the "test connection" call for Make / Zapier) |
| `GET /api/v1/usage` | plan, quota, what is left, what extra posts cost |
| `GET /api/v1/channels` | my channels; their `id`s go into `channelIds` |
| `POST /api/v1/posts` | schedule a post: `{ "content", "channelIds": [..], "scheduledAt", "mediaUrl"? }` (**metered**) |
| `GET /api/v1/posts?view=upcoming\|history` | list |
| `GET /api/v1/posts/:id` | one post's status (`scheduled` → `processing` → `sent` / `failed` / `cancelled`) |
| `DELETE /api/v1/posts/:id` | cancel while still `scheduled` |

Every metered response carries `X-Vane-Quota-Limit`, `X-Vane-Quota-Remaining` and `X-Vane-Quota-Reset`. Errors are `{ "ok": false, "error": "…", "code": "…" }`; branch on `code`:
`invalid_api_key` (401) · `wrong_key_scope` (403) · `api_not_in_plan` (403) · `quota_exceeded` (402) · `rate_limited` (429) · `too_many_keys` (409) · `invalid_idempotency_key` (400) · `idempotency_key_reuse` (422) · `idempotency_in_progress` (409).

**OpenAPI spec:** `https://vaneapp.dev/vane-openapi.json` (OpenAPI 3.0, served from `public/`) describes all of the above, so a tool can import it instead of being set up by hand.
- *ChatGPT Custom GPT*: Configure → Actions → *Import from URL* with the address above → Authentication *API Key* → *Bearer*, paste a `cpost_…` key. Use a `cpost_test_` key while trying it out.
- *Claude* and other tools that read OpenAPI: point them at the same file.
- When an endpoint changes, update `public/vane-openapi.json` in the same commit.

**Make custom app:** a ready app definition lives in `integrations/make/` (modules: Schedule / Get / Cancel a Post, List Posts, List Channels; channels come as a dropdown). Setup is in its README; `npm run check:integrations` checks it still matches the spec.

Make.com: *HTTP → Make a request*, URL `https://vaneapp.dev/api/v1/posts`, header `Authorization: Bearer <key>`, body type *Raw / JSON*. A scenario that runs on a key that is out of quota gets `402`, which Make shows as an error you can route.

### Safe retries: `Idempotency-Key`

Make and Zapier retry a request that timed out. Send `Idempotency-Key: <unique value>` on `POST /api/v1/posts` (a UUID, or something that stays the same on a retry, such as the scenario's execution id; 1-255 printable characters) and a retry can never create a second post or take a second unit of quota.

| Request | Answer |
|---|---|
| first | runs normally; its 201 answer is remembered for 24 hours |
| same key, same body | the first answer again (same group and post ids), header `Idempotent-Replayed: true`, **no quota taken** (it works even when the quota is spent) |
| same key, different body | `422 idempotency_key_reuse` |
| same key while the first is still running | `409 idempotency_in_progress` (`Retry-After: 1`) |

Only a **successful** answer is remembered: a request that failed (400, 402, 5xx) frees the key, so the retry, after fixing the input or upgrading, simply runs. Key order inside the JSON does not matter. Live and test keys have separate key spaces, and test keys replay too (handy for testing retry logic). The stored answer is written in the same database batch as the post, so there is no moment where the post exists and the key does not know it; a claim abandoned for over a minute (a crashed request) can be taken over. Expired keys are removed by the cron worker. Code: `functions/api/lib/idempotency.ts`.

### OpenAPI / Custom GPT

`GET /api/v1/openapi.json` serves an OpenAPI 3.1 description of this API (public, CORS-enabled, nothing private in it). The dashboard's Quick start shows the URL with a Copy button. In ChatGPT: *Create a GPT → Configure → Actions → Import from URL*, then set Authentication to *API Key / Bearer* and paste a `cpost_live_…` key. Postman and Make read it too. The spec lives in `functions/api/lib/openapi.ts` (the only hand-written description); `npm run test:api` validates its structure and **fails if a route under `functions/api/v1` is not documented or a documented route does not exist** (the Video Engine has its own document, `documentation/VIDEO_ENGINE.md`).

### How the quota works

| Plan | Quota | Over it |
|---|---|---|
| Free Trial | **30 posts in total** (dashboard + API share it, never resets) | stops, `402`, never charged |
| Developer API | 180 API posts a month (UTC month) | `402`, or $0.03 / post with overage on |
| Pro Dashboard | 1,000 dashboard posts; **no API** until the Add-on | live keys get `403 api_not_in_plan` |
| Pro + API Add-on | 1,000 dashboard + 180 API posts a month | `402`, or $0.015 / post with overage on |

- **1 request = 1 post**, however many channels it targets. The unit rule is one function: `postUnits` in `functions/api/lib/plans.ts`.
- The quota is taken by **one conditional upsert** on `usage_counters`, so parallel requests can never both take the last unit (the test fires 12 at 5 remaining: exactly 5 pass).
- A request that fails validation costs nothing. If saving fails after the quota was taken, it is given back. Cancelling a post does not refund it.
- A paid plan whose period ended (or that is not `active`) falls back to the Free Trial limits until it is renewed.
- Overage billing is **off by default** (`subscriptions.overage_enabled = 0`): out of quota means `402`, never a surprise charge.
- Dashboard posts are **counted** (they share the Free Trial total) but not blocked yet; that comes with the dashboard part.
- All prices and limits live in `functions/api/lib/plans.ts`.

### Giving an account a plan by hand (until payments do it)

```
npm run plan:set -- me@example.com api                       # Developer API for 30 days
npm run plan:set -- me@example.com pro --addon --overage     # Pro + API Add-on, overage billing on
npm run plan:set -- me@example.com pro --addon --forever --remote   # production, no expiry
```

### Test it

`npm run db:local && npm run dev` in one terminal, `npm run test:api` in another: 101 checks that walk through keys, scopes, test mode, the Free Trial, every plan, the parallel-request race, overage, revoking, the rate limit, Idempotency-Key (retries, races, expiry) and the OpenAPI document. It only schedules posts for a placeholder channel; nothing is sent anywhere.

## Vane Studio / Video Engine (a separate dashboard)

Vane Studio ([documentation/VIDEO_ENGINE.md](documentation/VIDEO_ENGINE.md)) is its own product with its own
access: the posting dashboard (Vane Post) is `post.vaneapp.dev` and uses `/api/*`; the video dashboard is `studio.vaneapp.dev`
(`public/studio.html`, `public/assets/studio.js`) and uses `/api/video/*`; the public API for `cvid_` keys is `/api/v1/video/*`.
They share the account and the sign-in, nothing else; each host answers 404 to the other product's API.

- **Setup:** nothing new. Re-run `npm run db:remote` (the schema only adds tables), and the R2 bucket `vane-media` is the one
  from the uploads step (videos live under a private `videos/` prefix, never served publicly).
- **Switch it on for an account** (until payments do it): `npm run video:set -- me@example.com [--days 365] [--remote]`;
  `--off` takes it away again. Without it uploads and live `cvid_live_` keys answer `403 video_engine_required`; `cvid_test_` keys always work.
- **No terminal?** Do the same in Cloudflare → D1 → `vane-db` → **Console**: paste the whole `schema.sql` and run it (it is idempotent), then grant the account (it must already exist: sign up on the site first):
  ```sql
  INSERT INTO video_subscriptions (user_id, status, current_period_end, provider, created_at, updated_at)
  SELECT id, 'active', NULL, 'manual', unixepoch(), unixepoch() FROM users WHERE email = 'me@example.com'
  ON CONFLICT(user_id) DO UPDATE SET status = 'active', current_period_end = NULL, updated_at = unixepoch();
  ```
  To switch it off again: `UPDATE video_subscriptions SET status = 'canceled' WHERE user_id = (SELECT id FROM users WHERE email = 'me@example.com');`
- **Sign-in:** the sign-in page has a **Vane Post / Vane Studio** switch (one account works for both); the choice decides where you land. Signing up does not switch Studio on: that is the grant above (until payments exist).
- **Upload flow** (chunks of 8 MiB, resumable): `POST /api/video/uploads` → `PUT …/uploads/:id/parts/:n` → `POST …/uploads/:id/complete`.
- **Test it locally:** `npm run db:local && npm run dev`, then `npm run test:video` (API) and `npm run test:hosts` (subdomain routing).

## Landing video demo

The "Publish videos like you publish posts" section (`#videos` in `public/index.html`) is an iPad showing a YouTube-style channel feed plus a mini dashboard under it. Typing a title and pressing "Publish video" adds a non-clickable card to the feed (up to 3 uploads, then "Reset demo"). It is a pure front-end simulation: the filler videos are in `YT_OLD` and the upload limit is `YT_MAX` in the page script.

## Dashboard: adding a social network

`NET` in `public/assets/dashboard.js` is the single list of networks: icon, tile colour, text limit, preview background and the card in the connect dialog. Channels are grouped by network in the Channels card, in "Publish to" and in the post list. **Connect** opens a network picker first, then that network's setup.

To open a network for connecting (only Telegram is open today; the rest show "Soon"):

1. `NET`: set `ready: true`.
2. `public/app.html`: add a `<div data-step="<key>" class="hidden">` setup block to the connect dialog, next to the Telegram one.
3. Backend: add the platform to `ChannelType` (`types.ts`) and to the `CHECK` on `channels.type` (`schema.sql`; SQLite cannot alter a CHECK, so an existing database needs the table rebuilt). Then handle it in `handleAddChannel` (`functions/api/channels/index.ts`, answers 501 for everything but Telegram today) and in `worker/src/dispatch.ts` (fails non-Telegram posts today). `threads` and `bluesky` are not in `ChannelType` yet.

## Dashboard: hashtag memory, Insights, drafts

All of it is computed in the browser from the two post lists the dashboard already loads (`/api/posts?view=upcoming|history`, up to 200 each): no new endpoint, no schema change. The code is `public/assets/insights.js` (pure helpers on `Vane.tags` / `Vane.insights`, UI in `Vane.createTagAssist` / `Vane.renderInsights`), wired up in `dashboard.js`.

- **Hashtag memory:** under the editor, your most used tags from past posts (a post sent to several channels counts once). Typing `#` shows the ones that match: `Tab` inserts the highlighted one, `↑` `↓` choose, `Esc` closes, a tap on a chip inserts it.
- **Insights:** sent per day (14 days), share of deliveries without errors, days in a row with a post, most used channel, the hour you post at most, top hashtags (a click adds one to the editor). Numbers count deliveries, like the status badges.
- **No view counts:** Telegram's Bot API does not report how many people saw a channel post, so there is nothing honest to show. Add it when a network that reports it (LinkedIn, Threads, Bluesky) is opened.
- **Draft:** the editor text is kept in this browser's `localStorage` (key `vane:draft:<userId>`), restored on the next visit, removed once the post is scheduled and on sign-out.
- **Reuse** (History): copies a finished post's text and channels back into the editor. **Ctrl / ⌘ + Enter** schedules.

## Claude connector (MCP)

`POST /api/v1/mcp` is a remote MCP server (tools `vane_list_channels`, `vane_create_post`) that runs on the public API with the same keys, limits and quotas. `integrations/claude-mcp/` holds the Claude Desktop bridge and the setup guide.

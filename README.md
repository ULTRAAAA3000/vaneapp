# Vane — unfairly fast social scheduling

Cloudflare Pages (site + `/api`) · D1 (database) · R2 (images) · a cron Worker (autoposting).

## Layout

| Path | What it is |
|---|---|
| `public/` | Landing, `/login`, `/app` dashboard (static, Tailwind via CDN) |
| `functions/api/` | Pages Functions: auth, channels, posts, media, waitlist |
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
8. **Check it live:** sign up at `/login`, connect a Telegram channel, press *Send test*, schedule a post 2–3 minutes ahead and watch `npm run cron:logs`.

Never lose `ENCRYPTION_KEY`: without it every stored channel token is unreadable.

## Admin panel (`/admin`)

A separate sign-in at `https://vaneapp.dev/admin` (not linked anywhere, `noindex`). **The credentials are never in the code or the database**: they are Cloudflare secrets, and without them the admin is simply switched off.

1. **Apply the new tables BEFORE deploying** (safe to repeat, it never overwrites edited plans or settings; sign-in now reads `user_flags`):
   `npx wrangler d1 execute vane-db --remote --file=./schema.sql`
   then, once, if the database existed before the admin panel: `npx wrangler d1 execute vane-db --remote --file=./scripts/migrations/001-subscriptions-any-plan.sql`
2. **Make the password hash** (typing is hidden, use a long random passphrase):
   `npm run admin:hash` → prints `pbkdf2-sha256$100000$…`
3. **Store the secrets** and redeploy:
   ```
   npx wrangler pages secret put ADMIN_EMAIL         --project-name=vaneapp   # the login, an e-mail
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name=vaneapp   # the line from step 2
   ```
   Optional: `ADMIN_USERNAME` (a second login name) and `ADMIN_ALLOW_IPS` (comma list of addresses / CIDR ranges that may use the admin, strongly recommended).
4. **Turn on Turnstile** (setup step 6): the admin sign-in then needs the human check too.

What is inside: **Overview** (users, conversion funnel, sources, MRR), **Users** (search, give or end a plan, disable an account, time on site, first-touch source), **Plans** (prices, limits, features, hidden or "coming soon", new plans such as "2 in 1" or "Ultra"; the landing page pricing reads them live), **Traffic** (time on site, pages, entry pages, countries, devices, live visitors), **Search** (Google Search Console), **Security** (every sign-in / sign-up attempt with address, country and network; blocklist by IP, range, network or country; automatic bans; hosting / VPN networks refused at sign-in and sign-up), **Settings**, **Activity** (audit log).

**Security notes**
- Separate session (8 h, `SameSite=Strict`, own table). Wrong passwords: throttled after 5, the address is banned after 8 within 15 minutes. All attempts, successful or not, are listed in Security.
- You cannot block the network you are using right now (no self-lockout).
- Rotate the password by running `npm run admin:hash` again and replacing the secret; all admin sessions can be cut by deleting rows from `admin_sessions`.

**Plans, limits and payments.** There is ONE engine for who-has-what: the `subscriptions` table (one row per user) read by the API / quota code (`lib/plans.ts`, `lib/usage.ts`). The admin plugs into it instead of keeping a second copy:
- the `plans` table (Plans tab) is the **catalog**: names, prices (integer cents + currency, yearly and "was" price), features, hidden / "coming soon", and a `limits` JSON that the engine turns into the real quotas within seconds (`postsPerMonth`, `apiPostsPerMonth`, `postsLifetime`, `channels`, `aiCredits`, `apiAccess`, `overagePostUsd`, `overageAiPostUsd`; the `api-addon` row sets the add-on's extra API posts). The numbers in `lib/plans.ts` are only the defaults until the catalog says otherwise. The landing page pricing reads the same rows;
- **giving a plan** from the admin is the same upsert as `npm run plan:set` (`provider = 'manual'`, never counted as revenue); a plan that is paid through a provider cannot be overwritten by accident. MRR is computed from the catalog prices of the paying subscribers;
- a plan made in the admin ("2 in 1", "Ultra") is enforced like the built-in ones. A database created before the admin panel still has the old `CHECK (plan IN ('free','api','pro'))`: run `npx wrangler d1 execute vane-db --remote --file=./scripts/migrations/001-subscriptions-any-plan.sql` once to allow custom plan ids (until then the admin answers with a clear message; the built-in plans keep working);
- payment providers (Monobank, crypto, Stripe): each plan has a `provider_refs` slot; a webhook only has to upsert the user's `subscriptions` row. The connected-channels limit is applied only while **Enforce the channel limit** is on in Settings (off by default); AI credits and seats are stored but not enforced yet.

**Search Console.** Create a Google Cloud service account, enable the *Search Console API*, add the service account's e-mail as a (restricted) user of your property in Search Console, then:
```
npx wrangler pages secret put GSC_SERVICE_ACCOUNT --project-name=vaneapp   # paste the whole JSON key
npx wrangler pages secret put GSC_SITE_URL        --project-name=vaneapp   # sc-domain:vaneapp.dev  (or https://vaneapp.dev/)
```

**VPN / proxy lookup (optional).** Hosting and VPN networks are refused through the ASN list in Security (a starter list, extend it). For per-address detection set `PROXYCHECK_KEY` (proxycheck.io); answers are cached for a day and a lookup outage lets people through.

**Analytics and privacy.** `assets/track.js` records page views and a 20-second heartbeat to `/api/track`: no cookies and no third parties; the visitor id lives in `localStorage`, addresses are stored only as a salted hash, bots and the browser's Do-Not-Track / Global Privacy Control are respected. Sign-in attempts keep the raw address for 90 days (security log). If you serve users in the EU, mention both in your privacy policy.

## Telegram connection methods

| | Quick Connect | Custom bot |
|---|---|---|
| Whose bot | shared `@VanePublishBot` | the user's own (from @BotFather) |
| User does | add the bot as admin, enter `@channel`, post a one-time code in it | create a bot, paste its token |
| Stored per channel | only the chat id (encrypted); **no token** | token + chat id (AES-256-GCM) |

**Why the one-time code?** The shared bot is an admin in many channels, so "the bot can post there" says nothing about who owns the channel. Only an admin can post the code, and the bot sees it through the webhook, so ownership is proven before the channel is connected.

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
| 3 | OpenAPI spec, `Idempotency-Key` (safe retries from Make / Zapier), webhooks | next |
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
| `GET /api/v1/me` | is the key valid, which plan (the "test connection" call for Make / Zapier) |
| `GET /api/v1/usage` | plan, quota, what is left, what extra posts cost |
| `GET /api/v1/channels` | my channels; their `id`s go into `channelIds` |
| `POST /api/v1/posts` | schedule a post: `{ "content", "channelIds": [..], "scheduledAt", "mediaUrl"? }` (**metered**) |
| `GET /api/v1/posts?view=upcoming\|history` | list |
| `GET /api/v1/posts/:id` | one post's status (`scheduled` → `processing` → `sent` / `failed` / `cancelled`) |
| `DELETE /api/v1/posts/:id` | cancel while still `scheduled` |

Every metered response carries `X-Vane-Quota-Limit`, `X-Vane-Quota-Remaining` and `X-Vane-Quota-Reset`. Errors are `{ "ok": false, "error": "…", "code": "…" }`; branch on `code`:
`invalid_api_key` (401) · `wrong_key_scope` (403) · `api_not_in_plan` (403) · `quota_exceeded` (402) · `rate_limited` (429) · `too_many_keys` (409).

**OpenAPI spec:** `https://vaneapp.dev/vane-openapi.json` (OpenAPI 3.0, served from `public/`) describes all of the above, so a tool can import it instead of being set up by hand.
- *ChatGPT Custom GPT*: Configure → Actions → *Import from URL* with the address above → Authentication *API Key* → *Bearer*, paste a `cpost_…` key. Use a `cpost_test_` key while trying it out.
- *Claude* and other tools that read OpenAPI: point them at the same file.
- When an endpoint changes, update `public/vane-openapi.json` in the same commit.

**Make custom app:** a ready app definition lives in `integrations/make/` (modules: Schedule / Get / Cancel a Post, List Posts, List Channels; channels come as a dropdown). Setup is in its README; `npm run check:integrations` checks it still matches the spec.

Make.com: *HTTP → Make a request*, URL `https://vaneapp.dev/api/v1/posts`, header `Authorization: Bearer <key>`, body type *Raw / JSON*. A scenario that runs on a key that is out of quota gets `402`, which Make shows as an error you can route.

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

`npm run db:local && npm run dev` in one terminal, `npm run test:api` in another: 66 checks that walk through keys, scopes, test mode, the Free Trial, every plan, the parallel-request race, overage, revoking and the rate limit. It only schedules posts for a placeholder channel; nothing is sent anywhere.

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

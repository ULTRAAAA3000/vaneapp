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

## Admin panel (`/admin`)

A separate sign-in at `https://vaneapp.dev/admin` (not linked anywhere, `noindex`). **The credentials are never in the code or the database**: they are Cloudflare secrets, and without them the admin is simply switched off.

1. **Apply the new tables BEFORE deploying** (safe to repeat, it never overwrites edited plans or settings; sign-in now reads `user_flags`):
   `npx wrangler d1 execute vane-db --remote --file=./schema.sql`
   then, once, if the database existed before the admin panel: `npx wrangler d1 execute vane-db --remote --file=./scripts/migrations/001-subscriptions-any-plan.sql`
2. **Make the password hash** (typing is hidden, use a long random passphrase):
   `npm run admin:hash` → prints `pbkdf2-sha256$100000$…`. No terminal? Open `/admin-hash.html` on the site: it makes the same hash in your browser (the password never leaves the page) and has a **Check** box that tells you whether a pasted hash belongs to a password. Paste the hash into the secret with no quotes or spaces (stray ones are ignored now, but keep it clean).
3. **Store the secrets** and redeploy:
   ```
   npx wrangler pages secret put ADMIN_EMAIL         --project-name=vaneapp   # the login, an e-mail
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name=vaneapp   # the line from step 2
   ```
   Optional: `ADMIN_USERNAME` (a second login name) and `ADMIN_ALLOW_IPS` (comma list of addresses / CIDR ranges that may use the admin, strongly recommended).
4. **Turn on Turnstile** (setup step 6): the admin sign-in then needs the human check too.

What is inside: **Overview** (users, conversion funnel, sources, MRR), **Users** (search, give or end a plan, disable an account, time on site, first-touch source), **Plans** (prices, limits, features, hidden or "coming soon", new plans such as "2 in 1" or "Ultra"; the landing page pricing reads them live), **Social** (the landing page's "Follow" section: the words above the cards and each link's network, name, handle, description, address and order; the card design is fixed, a link with nothing public hides the section), **Traffic** (time on site, pages, entry pages, countries, devices, live visitors), **Search** (Google Search Console), **Security** (every sign-in / sign-up attempt with address, country and network; blocklist by IP, range, network or country; automatic bans; hosting / VPN networks refused at sign-in and sign-up), **Settings**, **Activity** (audit log).

**Networks (Networks tab).** Every network Vane knows is listed in `functions/api/lib/networks.ts` with a flag `implemented` = *the code is written* (connect flow + publishing). A network can be switched on in the admin **only if that flag is true**, and the platform's own review does not matter: it may be on while LinkedIn / TikTok / Meta have not approved Vane yet (keep their status in the note field). Implemented networks are on by default, so nothing changes until you switch one off. A switched-off network: no new account can be connected (every connect and OAuth-callback path checks it), no new post can be scheduled to its channels (dashboard and `/api/v1`), the dashboard shows it as *Paused*, and posts already scheduled for it **wait** (the cron worker skips them) instead of failing; after 2 hours past the scheduled time they fail with a clear reason. When you write the code for a new network (Vane Studio's YouTube / TikTok / Instagram, X, …), set its `implemented` flag to `true` and the switch becomes live.

**AI spend (AI tab).** Every model call is written to `ai_usage` (user, feature, model, input / output tokens, neurons, cost in micro-dollars at the price of that moment), and the tab shows tokens and cost per day, per feature, per model and per user, today's neurons against Cloudflare's 10 000 free a day, and the month against an optional budget (Settings, shown only, nothing is stopped). Prices live in `ai_prices` (starter row: `@cf/meta/llama-3.1-8b-instruct`, $0.282 / $0.827 per 1M tokens, from Cloudflare's pricing page): edit them in the tab when Cloudflare changes them or a new model is used; a model with no price is still counted in tokens. Numbers come from the `usage` the model returns; if it sends none the tokens are a 4-characters-per-token estimate, marked as such. **A new AI feature is counted automatically** as long as it calls the model through `ask()` in `lib/ai.ts`; to attribute the spend to a user and a feature, wrap env first: `const e = withAiContext(env, { userId, tool: 'my-feature' })` (`lib/aimeter.ts`). Without that the call still shows up, as "unattributed".

**Security notes**
- Separate session (8 h, `SameSite=Strict`, own table). Wrong passwords: throttled after 5, the address is banned after 8 within 15 minutes. All attempts, successful or not, are listed in Security.
- You cannot block the network you are using right now (no self-lockout).
- Rotate the password by running `npm run admin:hash` again and replacing the secret; all admin sessions can be cut by deleting rows from `admin_sessions`.

**Plans, limits and payments.** There is ONE engine for who-has-what: the `subscriptions` table (one row per user) read by the API / quota code (`lib/plans.ts`, `lib/usage.ts`). The admin plugs into it instead of keeping a second copy:
- the `plans` table (Plans tab) is the **catalog**: names, prices (integer cents + currency, yearly and "was" price), features, hidden / "coming soon", and a `limits` JSON that the engine turns into the real quotas within seconds (`postsPerMonth`, `apiPostsPerMonth`, `postsLifetime`, `channels`, `aiCredits`, `apiAccess`, `overagePostUsd`, `overageAiPostUsd`; the `api-addon` row sets the add-on's extra API posts). The numbers in `lib/plans.ts` are only the defaults until the catalog says otherwise. The landing page pricing reads the same rows;
- **giving a plan** from the admin is the same upsert as `npm run plan:set` (`provider = 'manual'`, never counted as revenue); a plan that is paid through a provider cannot be overwritten by accident. MRR is computed from the catalog prices of the paying subscribers;
- a plan made in the admin ("2 in 1", "Ultra") is enforced like the built-in ones. A database created before the admin panel still has the old `CHECK (plan IN ('free','api','pro'))`: run `npx wrangler d1 execute vane-db --remote --file=./scripts/migrations/001-subscriptions-any-plan.sql` once to allow custom plan ids (until then the admin answers with a clear message; the built-in plans keep working);
- payment providers (Monobank, crypto, Stripe): each plan has a `provider_refs` slot; a webhook only has to upsert the user's `subscriptions` row. The connected-channels limit is applied only while **Enforce the channel limit** is on in Settings (off by default); AI credits and seats are stored but not enforced yet.

**Social links on the landing page.** The "Follow" section reads `GET /api/socials` (rows of the `social_links` table plus one `settings` value for the heading), edited in **Social**. The three links in `index.html` are the fallback until the API answers. The table is created by `schema.sql` (`npm run db:remote`, safe to repeat); the seed runs only while the table is empty, so a link you removed does not come back. Until the table exists the Social tab says so and the landing keeps the built-in links.

**Library (dashboard).** The **Library** tab lists the files a person uploaded for their posts (`GET /api/library/assets`: filter by type, search by name, 60 per page) and lets them copy a link or delete a file. Every upload (from the editor or from the tab) is recorded in `media_assets` (`schema.sql`, `npm run db:remote`, safe to repeat). A file that a post still waiting to be sent points at cannot be deleted. The plan limit `storageMb` (a key in the plan's limits, empty = unlimited) is applied only while the *Enforce limits* switch is on, like the channel limit. Files uploaded before the table existed are not listed and do not count; Studio videos are not part of the Library. Until the table exists, uploads keep working and the tab says the library is not available yet.

**Upload safety.** Only JPEG, PNG, WebP, MP4 and MOV are accepted, decided from the file's bytes (never the name or the Content-Type). On top of that `functions/api/lib/mediacheck.ts` walks the whole file: PNG chunks and checksums, JPEG segments, WebP chunks and MP4 boxes must be well-formed and end exactly at the end of the file, so nothing can be hidden after the picture or clip; pictures containing script or markup signatures are refused. Files are served with a fixed type, `nosniff` and a sandbox CSP, under random names.

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
| 3b | Webhooks: signed `post.published` / `post.failed` events, retries (shipped, see Webhooks below) | done |
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
- *ChatGPT Custom GPT* (**soon**, not offered to users yet): Configure → Actions → *Import from URL* with the address above → Authentication *API Key* → *Bearer*, paste a `cpost_…` key. Use a `cpost_test_` key while trying it out.
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

`GET /api/v1/openapi.json` serves an OpenAPI 3.1 description of this API (public, CORS-enabled, nothing private in it). The dashboard's Quick start shows the URL with a Copy button. A ChatGPT Custom GPT is **soon** (not offered to users yet); Postman and Make read it too. The spec lives in `functions/api/lib/openapi.ts` (the only hand-written description); `npm run test:api` validates its structure and **fails if a route under `functions/api/v1` is not documented or a documented route does not exist** (the Video Engine has its own document, `documentation/VIDEO_ENGINE.md`).

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
- **Publishing queue:** ships with the cron worker, so run `npm run cron:deploy` once after this release (the worker gained an R2 binding to read the video files). Locally, put `VIDEO_PUBLISH_MOCK=1` in `.dev.vars` to try publishing on a fake network; never set it in production.
- **Sign-in:** the sign-in page has a **Vane Post / Vane Studio** switch (one account works for both); the choice decides where you land. Signing up does not switch Studio on: that is the grant above (until payments exist).
- **Upload flow** (chunks of 8 MiB, resumable): `POST /api/video/uploads` → `PUT …/uploads/:id/parts/:n` → `POST …/uploads/:id/complete`.
- **Test it locally:** `npm run db:local && npm run dev`, then `npm run test:video` (API) and `npm run test:hosts` (subdomain routing).

### Studio AI writer

`POST /api/video/ai` (needs an active Vane Studio; `GET` shows the allowance) runs on the same Workers AI binding as the post editor:
`script` (hook, body and CTA for Shorts/TikTok/Reels/YouTube), `metadata` (titles, description, tags, hashtags) and `chapters` (YouTube timecodes, estimated from where each part sits in the script). One generation is one credit of 250 per month (`VIDEO_AI_MONTHLY` in `functions/api/lib/videoai.ts`), given back if the model fails.
It needs one new table: run the whole `schema.sql` in the D1 Console again (it is idempotent), or only the `video_ai_usage` block at its end.

## Integrations in the admin (Claude, ChatGPT, Make, Zapier, WordPress, direct API)

**Status: done** (backend, the admin screen and the "Used with" picker).

**In the admin** (`/admin` → **Integrations**, `public/assets/admin.js`): a summary row (API requests in 7 days with the trend, today, active keys, and the share of traffic whose source is unknown), a **Demand** card (a ranking of the integrations by 30-day requests and a stacked 30-day chart), and a card per integration with its state (Live / Works through the API / Planned / Paused), activity (Active / Idle / No traffic yet), an on/off switch (switching off asks for confirmation and explains the consequence; switching on is immediate), today / 7 d / 30 d requests with the trend, active keys and users, a 30-day chart, the last request, what it is used for (top operations), and a collapsible **Setup and notes** (copy-ready URLs, authentication, the steps a user follows, store-review notes, plus where the review stands and a free note, both saved as you change them). If the tables are missing the page says to run `npm run db:remote`.

**For users**: the create-key dialog (Post dashboard and Studio) has an optional **Used with** choice (Claude, ChatGPT (soon, greyed out), Make, Zapier, WordPress plugin, own script / other). It fills in the key's name when that is still empty, and it is what makes the admin's numbers certain instead of guessed. The label is shown on the key rows.

What it measures and controls (`functions/api/lib/integrations.ts`, `functions/api/admin/integrations.ts`):

- **Catalog** (in code): each integration's kind, how far it is built (`live` / `partial` / `planned`), how a user connects it (auth, URLs, steps) and where its store review stands, taken from `documentation/AUTOMATION_INTEGRATIONS.md`.
- **Switch** (`integration_settings`): `PUT /api/admin/integrations?id=make` `{ "enabled": false }` makes every request from that integration answer `403 integration_disabled` (also for Claude over MCP) until it is switched on again. Takes effect at once on the server that handled the change, within 10 s on the others. A refused request is not counted. The admin can also set the marketplace `listing` state and a `note` (max 500 characters).
- **Demand** (`api_usage_daily`): one small counter per (UTC day, integration, key, operation), added on every authenticated API request. No per-request log, no IPs, no bodies; kept 120 days (the cron worker purges older rows). `GET /api/admin/integrations` returns, per integration: requests today / 7 d / 30 d, the previous 7 days (for the trend), a 30-day series, active keys (7 d / 30 d), distinct users (30 d), keys labelled for it, the last request, and the top 5 operations.
- **MCP**: Claude's MCP endpoint is counted once **per tool call** (`mcp:vane_create_post`), not once per inner REST call; invalid keys and `tools/list` are not counted.

How a request is attributed, in this order: (1) it came through MCP → Claude; (2) the key was labelled when it was created ("Used with", `integration` in `POST /api/keys`); (3) the client's `User-Agent` (ChatGPT / OpenAI, Zapier, Make / Integromat, Claude / Anthropic, WordPress); (4) the key's name ("Make.com"); (5) otherwise **Direct API**. Only (1) and (2) are certain; the share that falls into Direct API is returned as `totals.directShare`, so you can see how much is guessed.

**Rolling it out** (nothing breaks if you skip a step; the new parts just stay empty):
1. `npm run db:remote` — two new tables (`integration_settings`, `api_usage_daily`).
2. `npm run db:migrate:integrations` — adds `api_keys.integration` and labels existing keys from their names (run once; a second run fails on the ALTER, which means it is done). Until it runs, the API, key creation and the key list keep working; labels are simply not stored (the code checks again every 20 s).
3. Redeploy the cron worker (`npm run cron:deploy`) so the 120-day purge runs.

**Testing**: `npm run test:integrations` (48 checks: attribution, counting, MCP, the switch, the admin API, and a database without the new column plus the migration). It needs `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` in `.dev.vars` (defaults to the login `admin@example.com` / password `Admin-Test-Pass-77`; make the hash with `echo 'Admin-Test-Pass-77' | node scripts/admin-hash.mjs`).

## Landing: "What's inside" (every module)

`public/index.html`, section `#modules`: one card with a small inline-SVG picture for every module (Vane Post, assistants, Vane Studio, API and connectors). When you add or change a module, edit its card here so the landing stays true to the product; mark anything not live yet with the `Soon` tag. Naming: the video product is **Vane Studio** everywhere users can see it ("Video Engine" is only the internal name in code and `documentation/VIDEO_ENGINE.md`). The headline balances publishing and scheduling on purpose: do not describe the product as a scheduler only.

## Landing video demo

The "Publish videos like you publish posts" section (`#videos` in `public/index.html`) is an iPad showing a YouTube-style channel feed plus a mini dashboard under it. Typing a title and pressing "Publish video" adds a non-clickable card to the feed (up to 3 uploads, then "Reset demo"). It is a pure front-end simulation: the filler videos are in `YT_OLD` and the upload limit is `YT_MAX` in the page script.

## Payments: plans page, checkout, Monobank and crypto

Pages: `/pricing` (every plan from `/admin → Plans`, monthly / yearly switch) and `/checkout?plan=<id>[&interval=year]` (the chosen plan on the left, billing details and the payment method on the right). A plan card only becomes a "buy" button when the plan is switched on (`is_active`, not `coming_soon`, price above 0) **and** at least one payment method is configured; until then the landing page keeps the waitlist buttons. The AI Pass is bought from the "Buy AI Pass" button in the editor (`/checkout?plan=ai-pass`), it is never on the landing page.

Two ways to pay (each switches itself on when its settings exist):

- **Card, Apple Pay, Google Pay: Monobank Acquiring.** `functions/api/lib/monobank.ts`. Checkout makes an invoice (in the plan's currency) and sends the buyer to Monobank's own payment page; Monobank calls `POST /api/billing/monobank` (signed with `X-Sign`, ECDSA SHA-256; the call is also double-checked with the invoice status) and the plan switches on. Needs the secret `MONOBANK_TOKEN` (Pages → Settings → Variables and Secrets). The invoice currency is the price currency of the plan (USD 840, EUR 978, UAH 980): to sell in hryvnias, set the plan's currency to UAH and its price in /admin → Plans. Crypto is offered for USD plans only. A payment that arrives after a failed attempt on the same invoice still switches the plan on; a refund after payment leaves a note on the order.
- **Crypto: USDT or USDC on Solana.** `functions/api/lib/solana.ts`. Checkout reserves an exact amount (the price plus a few millionths, unique per open order), shows the address, a QR and a Solana Pay link. The payment is found by asking a Solana RPC node what reached the wallet (`getTokenAccountsByOwner`, `getSignaturesForAddress`, `getTransaction`), matched on the exact amount, token and time, and one transaction pays one order. Needs the plain variable `CRYPTO_WALLET` (your Solana address; it receives USDT/USDC) and optionally `SOLANA_RPC_URL` (a Helius / QuickNode address; the public node is rate-limited). The checkout page checks every 5 s; the cron (`worker/`, every minute) also checks, so a payment is activated even if the buyer closed the page. For the cron add the same `CRYPTO_WALLET` (and `MONOBANK_TOKEN`) to the Worker (see worker/wrangler.toml).

What a paid order switches on (`lib/billing.ts → activate`): `video` = Vane Studio (`video_subscriptions`), `ai-pass` = AI Pass (`ai_pass`), `api-addon` = the API add-on on an active Pro plan, `suite` = Post (as plan `suite`), Studio, Analytics Pro and the AI Pass together (its 75 API posts a month are the plan's own `apiPostsPerMonth` limit), any other plan id = that plan in `subscriptions`. A renewal while the plan is still running adds a period to its end; nothing renews automatically. Every order is a row in `orders` (status pending / paid / expired / failed / canceled); `/admin → Orders` lists them and has **Check**, **Confirm** (you saw the money yourself) and **Cancel**.

**See the checkout before payment is connected:** `/admin → Settings → Checkout preview (only you)`. While it is on, a browser that is signed into `/admin` sees `/pricing` → `/checkout?plan=<any plan id>` fully (even for a plan that is switched off) with a yellow Preview bar; visitors still see nothing. Pressing Pay answers "Preview only: payment is not connected yet" and creates no order. As soon as `MONOBANK_TOKEN` or `CRYPTO_WALLET` is set, preview steps aside and the real checkout takes over.

**Deploy:** run the whole `schema.sql` in the D1 Console once (adds `orders` and the Vane Suite plan, switched off). Then set the variables above. The Suite plan and the Studio plan (`video`) are off until you switch them on in `/admin → Plans`.

## Dashboard: adding a social network

`NET` in `public/assets/dashboard.js` is the single list of networks: icon, tile colour, text limit, preview background and the card in the connect dialog. Channels are grouped by network in the Channels card, in "Publish to" and in the post list. **Connect** opens a network picker first, then that network's setup.

To open a network for connecting (only Telegram is open today; the rest show "Soon"):

1. `NET`: set `ready: true`.
2. `public/app.html`: add a `<div data-step="<key>" class="hidden">` setup block to the connect dialog, next to the Telegram one.
3. Backend: add the platform to `ChannelType` (`types.ts`) and to the `CHECK` on `channels.type` (`schema.sql`; SQLite cannot alter a CHECK, so an existing database needs the table rebuilt). Then handle it in `handleAddChannel` (`functions/api/channels/index.ts`, answers 501 for everything but Telegram today) and in `worker/src/dispatch.ts` (fails non-Telegram posts today). `threads` and `bluesky` are not in `ChannelType` yet.

### Discord and Dev.to

Both connect by pasting one secret, no app review: a **Discord webhook URL** (Server settings → Integrations → Webhooks) and a **Dev.to API key** (Settings → Extensions). Code: `functions/api/channels/discord.ts`, `devto.ts`, `simple-add.ts`; delivery in `worker/src/dispatch.ts`. Discord posts text (≤ 2000) and one image, with `@everyone`/role pings disabled; Dev.to publishes each post as an article (first line = title, up to 4 `#tags`, an image becomes the cover line). Neither takes video yet.

**Deploy:** these two types are new in the `channels.type` CHECK. On an existing database run `migrations/0002-channel-types-discord-devto.sql` once in the D1 Console (it rebuilds the table and keeps all rows; a fresh database already has it through `schema.sql`). Until then adding them answers a clear 503.

Medium (closed to new integrations) and Reddit (API access needs manual approval) are intentionally not open.

## Dashboard: hashtag memory, Insights, drafts

All of it is computed in the browser from the two post lists the dashboard already loads (`/api/posts?view=upcoming|history`, up to 200 each): no new endpoint, no schema change. The code is `public/assets/insights.js` (pure helpers on `Vane.tags` / `Vane.insights`, UI in `Vane.createTagAssist` / `Vane.renderInsights`), wired up in `dashboard.js`.

- **Hashtag memory:** under the editor, your most used tags from past posts (a post sent to several channels counts once). Typing `#` shows the ones that match: `Tab` inserts the highlighted one, `↑` `↓` choose, `Esc` closes, a tap on a chip inserts it.
- **Insights:** sent per day (14 days), share of deliveries without errors, days in a row with a post, most used channel, the hour you post at most, top hashtags (a click adds one to the editor). Numbers count deliveries, like the status badges.
- **Live results card** (top of the dashboard, `Vane.renderLiveCard`): for the last 7 or 30 days (the Week / Month switch is remembered in the browser), time saved, delivery rate and a sparkline of posts per weekday (Monday first, the busiest day marked, today ringed). Time saved is an **estimate**: `MIN_PER_DELIVERY` (3) minutes for every delivery that was not posted by hand, and the card says so. The delivery rate is sent / (sent + failed) with one decimal and is never rounded up to 100% while something failed; "platforms" counts distinct networks that got at least one post in the period. It uses the same two lists as Insights, so it refreshes with them. If the history list is full (200) and still reaches into the period, the card says the figures are based on the latest 200 posts. Tests: `scripts/live-card-unit.mjs`.
- **No view counts:** Telegram's Bot API does not report how many people saw a channel post, so there is nothing honest to show. Add it when a network that reports it (LinkedIn, Threads, Bluesky) is opened.
- **Draft:** the editor text is kept in this browser's `localStorage` (key `vane:draft:<userId>`), restored on the next visit, removed once the post is scheduled and on sign-out.
- **Reuse** (History): copies a finished post's text and channels back into the editor. **Ctrl / ⌘ + Enter** schedules.


## Dashboard: post box tools (Tidy up, Clear, Tidy on paste)

`public/assets/composer-tools.js`, loaded after `dashboard.js` (it uses `Vane.composer`). In the toolbar under the post text:

- **Tidy up** (one button): removes extra spaces and blank lines (one blank line between paragraphs stays), hidden characters (zero-width space, word joiner, BOM, soft hyphen), turns no-break and typographic spaces into plain ones, and strips **tracking parameters** from links (`utm_*`, `fbclid`, `gclid`, `msclkid`, `igshid`, `mc_eid`, … and `si` on YouTube/Spotify). Real parameters (`ref`, `v`, `id`, `page`) are never touched. The bar below the toolbar says what was removed, in words.
  It deliberately keeps the zero-width joiner and non-joiner (emoji sequences and Persian/Indic text need them), the left/right marks and the CJK space, so no language or emoji is broken. A clean text is reported as clean, and tidying twice equals tidying once.
- **Clear**: empties the box.
- **Tidy on paste**: a switch (remembered in this browser, off by default) that does the same to whatever is pasted, at the caret or over the selection. Pasting an image still goes to the media picker.
- Every change shows **Undo** for 10 seconds. The counter, preview and draft autosave follow, because the tools go through the same `input` event as typing.

The rules are a pure function (`VaneTidy.tidy`); `npm run test:composer` tests them without a server.

## AI in the post editor

`POST /api/ai` (dashboard session) runs on Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`). The binding is declared in `wrangler.toml` (`[ai] binding = "AI"`); if it does not show up after a deploy, add it in Pages → Settings → Bindings → Workers AI with the variable name `AI`. Without it the AI bar stays hidden and `/api/ai` answers 503.

- The model is `@cf/meta/llama-3.1-8b-instruct-fp8`. Cloudflare retires models now and then (the old `llama-3.1-8b-instruct` stopped working on 2026-05-30): if the AI says the model was retired, set a Pages variable `AI_MODEL` to a current model id from the Workers AI catalog (Settings → Variables and Secrets, e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) and redeploy. No code change needed.
- Extra AI credits for one account: `/admin` → Users → the user → **AI credits** (needs `schema.sql` re-run once for the `user_ai_bonus` table). They work on any plan and are spent after the plan's own credits.
- **Vane AI Pass** ($2.99/month, 150 credits, $0.02 per extra credit) is an add-on row `ai-pass` in the plan catalog: edit the price, the credits (`aiCredits`) and the extra price (`overageAiPostUsd`) in `/admin` → Plans. It is created hidden (`is_public = 0`), so it never shows on the landing page. There is no online checkout yet: switch it on for an account in `/admin` → Users → the user → **AI Pass** (days empty = no end date); a payment webhook will later write the same `ai_pass` row. Needs `schema.sql` re-run once.
- Where a credit comes from, in order: the plan's own credits, the AI Pass, credits given by an admin, then (only if the account switched **Pay for extra credits** on under the editor, via `POST /api/usage/overage`) a paid extra credit. With the switch off, requests over the limit are refused with a 402 and nothing is charged. The switch is the account's `overage_enabled` flag, so it also controls extra posts.
- Free for everyone: **Make it clean** (typos, emoji) and **Hashtags**.
- AI Pass (counts against `aiCredits` of the plan): tone, hooks, CTAs, a version per selected channel, a post from an idea, a week plan. Free plan = the credits set in the plan catalog (set `aiCredits` to 0 in the admin panel to make them Pro-only); API plan pays per generation; Pro has a monthly allowance.
- Links in the text are kept as they are, and every result is fitted to the limit of the network.

## LinkedIn and Threads

Both connect with the network's own "Allow" page (OAuth), publish text and one picture, and are off ("Soon" in the Connect dialog) until their app keys are set.
Full setup, redirect URLs, review checklist and the screencast script: `documentation/LINKEDIN_THREADS_SETUP.md`.

| Variable | Where | Notes |
|---|---|---|
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Pages (secret for the second) | LinkedIn app with *Share on LinkedIn* + *Sign In with LinkedIn using OpenID Connect* |
| `LINKEDIN_VERSION` | Pages + worker, optional | the `Linkedin-Version` header (YYYYMM), default in `functions/api/channels/linkedin.ts` |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | Pages (secret for the second) | the Threads app id/secret of the Meta app (not the main app id) |

- Code: `functions/api/channels/linkedin.ts` and `threads.ts` (API calls), `social-oauth.ts` (the start/callback flow for both), `threads-hooks.ts` (Meta's deauthorize and data-deletion calls), `worker/src/dispatch.ts` (publishing) and `worker/src/tokens.ts` (daily Threads sign-in renewal).
- Sign-ins last 60 days. Threads renews itself; LinkedIn (no refresh token for ordinary apps) shows **Reconnect** on the channel card a week before, and reconnecting renews the same channel in place.
- A sent post's `url` (History link, `GET /api/v1/posts`): LinkedIn `linkedin.com/feed/update/<urn>/`, Threads its permalink.
- Pages: `/privacy`, `/terms` and `/data-deletion`. The yellow `[…]` marks in them are the owner's details still to fill in (operator name and address, contact email, effective date, governing law and courts, retention periods): search the three files for `class="todo"`. They are generated from the finished product (all plans, Studio, AI, API, payments), not from the current state.

## Webhooks

Vane can call your server (or Make / Zapier) when a post is published or fails.

```
POST /api/v1/webhooks   { "url": "https://example.com/hook", "events": ["post.published", "post.failed"] }
  → 201 { "webhook": { "id": "…" }, "secret": "whsec_…" }      the secret is shown once
GET  /api/v1/webhooks                                            my subscriptions
DELETE /api/v1/webhooks/:id                                      stop one
```

Same `Authorization: Bearer cpost_…` as the rest of the API (a `cpost_test_` key saves nothing). The url must be https on port 443 with a real host name (no IP addresses). Up to 10 per account.

Each event is a `POST` with the JSON `{ "id", "type", "createdAt", "data": { "post": {…same as GET /api/v1/posts/:id…} } }` and the headers `Vane-Event`, `Vane-Delivery` (same value on every retry: de-duplicate on it) and `Vane-Signature: t=<unix>,v1=<hex>`, the HMAC-SHA256 of `"<t>.<raw body>"` with your secret. Answer with any 2xx. Otherwise Vane retries after 1 min, 5 min, 30 min, 2 h and 12 h, then gives up; HTTP 410 ends the subscription.

Events are queued in `webhook_deliveries` and sent by the cron worker every minute, so a slow receiver never delays posting. The two webhook tables are in `schema.sql` (run it, or the two `CREATE TABLE` blocks at its end, in the D1 console); until then `/api/v1/webhooks` answers 503 and posting is unaffected.

**Receiver address rules** (`validateWebhookUrl` in `functions/api/lib/webhooks.ts`): https only, port 443, no credentials, a public domain name (no IP addresses in any notation, no `localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, `*.intranet` …, a trailing dot does not sidestep it) and never Vane itself (`vaneapp.dev` and its subdomains). Redirects are not followed. `npm run test:unit` checks these rules and the signature against an independent HMAC.

## API protection

The API is open by design (Zapier, Make, GPT, scripts), so it is protected in layers; the full picture, the Cloudflare rules to switch on and the tuning knobs are in `documentation/API_PROTECTION.md`.

- **`functions/api/lib/shield.ts`** (called from `functions/_middleware.ts`) runs before every `/api/` route: real methods only, attack-tool User-Agents refused, browser-only doors need a User-Agent, the **blocklist now covers the whole API**, a burst limit per address (100 requests / 10 s, 300 for callers with a Vane key), a body size cap on JSON doors, and **automatic bans for scanners** (15 probes a minute cool an address down, 30 ban it for `auto_ban_hours`; visible and removable in the admin panel).
- Wrong API keys are limited per address (30 per 10 minutes; a key that just worked is not held up, so shared Zapier addresses are safe); the waitlist is limited to 8 per hour per address.
- API answers carry `nosniff`, `Referrer-Policy` and `no-store` (Pages' `_headers` only covers static files).
- It never blocks hosting / VPN networks for API calls, never touches Telegram's and Meta's server calls, uploads or picture fetches, and ignores private / local addresses.
- Emergency brake: set `SHIELD_OFF=1` on Pages and redeploy.

## Marketing pages (Networks, Developers, Integrations, Security, Changelog, About, Partners, WYSB)

The text lives in `site/*.html` (the first line of each is a `<!--page {"slug","title","desc"}-->` comment); `npm run build:pages` wraps it in the shared header and footer and writes `public/<slug>.html` plus `public/sitemap.xml`. Commit both folders, nothing is built at deploy time. To change the navigation, footer or the public contact email, edit the `SITE` object in `scripts/build-site-pages.mjs` (while `email` is empty the pages show a yellow `[CONTACT EMAIL]` and the "mailto" buttons lead to `/about#contact`). New page: add `site/<name>.html`, add its path to `PAGES_IN_SITEMAP`, run the build.

- `/partners/wysb` is the partner page; the yellow `[…]` marks in it (about WYSB, the partnership, services, contact) are facts only WYSB knows. The landing has a matching **Powered by WYSB** section (`#partner`).
- `/changelog` is written by hand from the shipped features: add an entry at the top when something ships.
- `/networks` and `/developers` repeat limits and endpoints from the code and `public/vane-openapi.json`: update them when those change.
- `public/robots.txt` keeps `/api/`, `/app`, `/studio` and `/admin` out of search.

## Admin → AI

`/admin#ai` is the AI spend ledger: tokens and list-price cost per day, by feature, model and user, the month against `ai_budget_usd`, today's use of Cloudflare's free neurons, and every model's price (editable). Besides the numbers it tells you **why it is empty**: a red note when this server has no Workers AI binding (Pages → Settings → Bindings → Workers AI, variable `AI`), an amber one when the model in use has no price yet. The month card shows where the month is heading at today's pace, and **Export CSV** downloads every call of the period (`GET /api/admin/ai?days=30&format=csv`, up to 50,000 rows, logged in the audit trail; names that start with `=`, `+`, `-` or `@` are defused so a spreadsheet cannot run them).

## Landing hero video

The hero plays `public/assets/hero-boomerang-v2.mp4` (1080p, about 5 MB) or `hero-boomerang-v2-m.mp4` (960 px, about 1 MB, chosen on phones by a small script), with `hero-poster-v2.jpg` shown instantly; nothing is downloaded when the visitor asked for reduced motion or data saving. It is the original clip followed by the same shot reversed (the zoom-out, then the zoom-in), so the plain `loop` never cuts. Browsers cannot play video backwards and reversing live by seeking looked choppy, so the reverse is baked into the file. If it fails to load, the script falls back to the original clip on CloudFront.
To change it: `scripts/make-hero-boomerang.sh new.mp4 hero-boomerang-v2.mp4` (needs ffmpeg), commit the file (Cloudflare Pages takes up to 25 MiB per file; raise the crf if it is bigger), and point the `<source>` and the cache rule in `public/_headers` at the new name. A new name matters: the file is cached for a year.

## Speed: static CSS and cached assets

- The dashboard, Studio, admin, checkout and helper pages use the prebuilt `public/assets/app.css` (Tailwind, about 36 KB) instead of the Tailwind script from a CDN; the public site uses `site.css`. After adding new Tailwind classes to any page or script, run `npm run build:css`.
- Every `/assets/*.js` and `*.css` file is cached for a year (`immutable`); the `?v=` in the HTML is the hash of the file's content. After editing any file in `public/assets` run `npm run build:assets` (or `npm run build:pages`, which does it too). `npm run test:unit` fails when a version is stale.
- The landing hero video is 5 MB (1 MB on phones) with an instant poster.

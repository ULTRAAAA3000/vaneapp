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
6. **Bot protection (Turnstile, optional, recommended):** Cloudflare dashboard → Turnstile → *Add widget* (domain `vaneapp.dev`, mode *Managed*).
   Put the **site key** into Pages → Settings → Variables as `TURNSTILE_SITE_KEY` (plain text) and the **secret key** as a secret:
   `npx wrangler pages secret put TURNSTILE_SECRET_KEY --project-name=vaneapp`, then redeploy.
   Sign-in and sign-up then require a passed check; it is enforced only when **both** values are set, and it fails closed if Cloudflare cannot be reached.
   Locally use the test keys from `.dev.vars.example`.
7. **Check it live:** sign up at `/login`, connect a Telegram channel, press *Send test*, schedule a post 2–3 minutes ahead and watch `npm run cron:logs`.

Never lose `ENCRYPTION_KEY`: without it every stored channel token is unreadable.

## Admin panel (`/admin`)

A separate sign-in at `https://vaneapp.dev/admin` (not linked anywhere, `noindex`). **The credentials are never in the code or the database**: they are Cloudflare secrets, and without them the admin is simply switched off.

1. **Apply the new tables** (safe to repeat, it never overwrites edited plans or settings):
   `npx wrangler d1 execute vane-db --remote --file=./schema.sql`
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

**Plans, limits and payments.** Money is stored in integer cents with a currency; a plan has an optional yearly price, "was" price, trial days and a slot per payment provider (`provider_refs`: Monobank, crypto, Stripe). `subscriptions` is the single source of truth for a user's plan (a grant from the admin is a subscription with `source = 'admin'`, never counted as revenue); a payment integration only has to insert / update rows there. Plan limits (connected channels, posts per month, posts in total) are applied to users only while **Enforce plan limits** is on in Settings (off by default). The other limits (AI credits, API posts, seats, overage prices) are stored and shown but not enforced yet.

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

## Landing video demo

The "Publish videos like you publish posts" section (`#videos` in `public/index.html`) is an iPad showing a YouTube-style channel feed plus a mini dashboard under it. Typing a title and pressing "Publish video" adds a non-clickable card to the feed (up to 3 uploads, then "Reset demo"). It is a pure front-end simulation: the filler videos are in `YT_OLD` and the upload limit is `YT_MAX` in the page script.

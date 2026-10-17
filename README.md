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
   4. `EMAIL_FROM` is a plain value, so (like the Turnstile site key) put it in `wrangler.toml` under `[vars]`: `EMAIL_FROM = "Vane <noreply@vaneapp.dev>"`, then redeploy.
   It is enforced only when **both** values are set. Once on, the account of anyone away for more than 3 days asks for a code at the next sign-in and all their old sessions are ended; accounts that already exist start their 3 days from their next visit. Resend's free plan is limited (check their current quota), so watch it if sign-ups spike.
   Tuning: `AWAY_AFTER_SECONDS` in `functions/api/lib/activity.ts` (3 days); `CODE_TTL_SECONDS`, `RESEND_COOLDOWN_SECONDS`, `MAX_WRONG_GUESSES` in `functions/api/lib/emailcode.ts` (10 min, 60 s, 5).
8. **Check it live:** sign up at `/login`, connect a Telegram channel, press *Send test*, schedule a post 2–3 minutes ahead and watch `npm run cron:logs`.

Never lose `ENCRYPTION_KEY`: without it every stored channel token is unreadable.

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

## Dashboard: adding a social network

`NET` in `public/assets/dashboard.js` is the single list of networks: icon, tile colour, text limit, preview background and the card in the connect dialog. Channels are grouped by network in the Channels card, in "Publish to" and in the post list. **Connect** opens a network picker first, then that network's setup.

To open a network for connecting (only Telegram is open today; the rest show "Soon"):

1. `NET`: set `ready: true`.
2. `public/app.html`: add a `<div data-step="<key>" class="hidden">` setup block to the connect dialog, next to the Telegram one.
3. Backend: add the platform to `ChannelType` (`types.ts`) and to the `CHECK` on `channels.type` (`schema.sql`; SQLite cannot alter a CHECK, so an existing database needs the table rebuilt). Then handle it in `handleAddChannel` (`functions/api/channels/index.ts`, answers 501 for everything but Telegram today) and in `worker/src/dispatch.ts` (fails non-Telegram posts today). `threads` and `bluesky` are not in `ChannelType` yet.

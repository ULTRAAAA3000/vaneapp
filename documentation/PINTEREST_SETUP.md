# Pinterest channel (Vane Post)

One channel = one Pinterest account + one board. Posts become image pins: the first line is the title (up to 100 characters), the rest is the description (up to 800), the first https link is the pin's destination, the attached picture is the pin image. A pin without a picture, or with a video, is refused when scheduling.

## One-time setup

1. https://developers.pinterest.com/apps/ → Connect app. Fill the form; new apps start with Trial access.
2. In the app: Redirect URIs → `https://post.vaneapp.dev/api/channels/pinterest/callback` (the same host as `APP_URL`).
3. Cloudflare Pages → Settings → Variables: `PINTEREST_APP_ID` (plain), `PINTEREST_APP_SECRET` (secret). Add both to the cron worker too (it renews the sign-in before a pin).
4. Database: run `migrations/0004-channel-types-pinterest.sql` once in D1 Console (or all of `schema.sql` on a new database).
5. Request Standard access in the Pinterest portal (a short demo video of connecting a board and posting a pin). Until it is granted, only the app owner's account can connect and pins made with Trial access are not public.

## How it works

- Scopes: `boards:read`, `pins:read`, `pins:write`, `user_accounts:read`.
- The person types the board name; after the sign-in Vane looks it up among their boards (case-insensitive).
- The access token lasts 30 days: it is renewed before a pin when it has less than 5 minutes left, and a daily sweep renews tokens that are close to the end.
- Switch it off or on in /admin → Networks.

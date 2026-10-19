# Vane for Zapier

Zapier integration (Zapier Platform CLI app) for the Vane public API.

| | | Calls |
|---|---|---|
| Action | Create Social Post (text, channels, publish time, image) | `POST /posts` |
| Trigger | New Published Post | `GET /posts?view=history`, only `sent` |
| Trigger | Post Failed | `GET /posts?view=history`, only `failed` |
| Hidden trigger | Channels (fills the dropdown) | `GET /channels` |
| Sign in | API key, tested with `GET /me` | `GET /me` |

The triggers poll (Zapier asks every few minutes), so they need no webhooks on the Vane side.
Errors read `[402] message (quota_exceeded)`.

## Put it into Zapier without a terminal

One-time setup:

1. Zapier account → developer platform (developer.zapier.com) → create a **deploy key** and copy it.
2. GitHub → this repository → Settings → Secrets and variables → Actions → New repository secret: name `ZAPIER_DEPLOY_KEY`, value the key.
3. GitHub → Actions → **Zapier** → Run workflow → action **register**. It creates the "Vane" integration in your Zapier account and saves `.zapierapprc` (the link) in the repository.
4. Run the workflow again with action **push**. It runs the tests, validates the app and uploads it. Repeat **push** after every code change.

Then in Zapier open the integration page (developer.zapier.com) → **Sharing** → get the invite link to test it in your own account. Public listing needs Zapier's partner review (later).

Try with a `cpost_test_…` key first.

## Develop

```
cd integrations/zapier
npm install
npm test
```

After changing an API route run `npm run check:integrations` in the repository root: it fails when this app calls a path that `public/vane-openapi.json` does not have.

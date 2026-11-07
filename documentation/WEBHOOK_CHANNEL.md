# Webhook channel

A channel of type `webhook` publishes every post scheduled to it by sending it as JSON to an https address the person gave (their own
server, Make, Zapier, n8n …). Code: `functions/api/channels/webhook.ts` (address rules, signing, sending), `simple-add.ts`
(`handleAddWebhook`, connecting), `worker/src/dispatch.ts` (`deliverWebhook`, the cron sender).

This is **not** the post webhooks of the API (`documentation/AUTOMATION_INTEGRATIONS.md`, `lib/webhooks.ts`): those tell a server
*about* a post; this channel is a place a post is published to, so it shows in the calendar, counts as a post and is retried like one.

No database change: `webhook` has been in the `channels.type` CHECK since the first schema, and nothing new is stored beyond the encrypted
credentials `{ type: 'webhook', url, secret }`.

## Connecting

`POST /api/channels/add { platform: "webhook", name, credentials: { url } }`

1. The address must pass `lib/netsafe.ts` (https, port 443, a public host name; never an IP address, `localhost` or a Vane host).
2. Vane sends one signed test call (`Vane-Event: channel.test`). The server must answer 2xx. Redirects are never followed.
3. Vane makes the signing secret (`whsec_…`), stores it encrypted and returns it **once**: `201 { ok, channel, webhook: { secret } }`.
   Lost it? Disconnect the channel and connect it again.
4. The same address cannot be connected twice by one person (409). At most 10 attempts an hour.

## What the receiver gets

```
POST <url>
Content-Type: application/json
User-Agent: Vane-Webhooks/1
Vane-Event: post.publish
Vane-Delivery: <post id>                         same on every retry: de-duplicate on it
Vane-Signature: t=<unix seconds>,v1=<hex>        HMAC-SHA256 of "<t>.<raw body>" with the channel secret

{
  "id": "<post id>",
  "type": "post.publish",
  "createdAt": "2026-11-07T20:00:00.000Z",
  "data": {
    "post": { "id": "<post id>", "content": "text", "media": [{ "url": "https://…", "kind": "image" }], "scheduledAt": "2026-11-07T20:00:00.000Z" },
    "channel": { "id": "<channel id>", "name": "My server" }
  }
}
```

`media` is empty without a picture or video (at most one is sent). Text limit 10,000 characters.

Checking the signature (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(rawBody, header, secret, toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header || '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(m[2], 'hex'));
}
```

## What Vane does with the answer

| Answer | Result |
|---|---|
| any 2xx | published. A JSON answer `{ "url": "https://…" }` becomes the post's link in the dashboard (anything not https is ignored) |
| 429, 408, 5xx, no answer in 10 s | retried by the cron sender with its backoff (a `Retry-After` is honoured), up to 5 tries |
| 410 | final: "reconnect the channel with a new address" |
| 3xx | final: redirects are not followed, reconnect with the final address |
| other 4xx | final, with the server's `message` / `error` text (200 characters at most) in the post's error |

A try that times out after the server already handled the post is retried, so the receiver may see the same `Vane-Delivery` twice.

## Tests

`scripts/webhook-channel-unit.mjs` (part of `npm run test:unit`): address rules, the test call, the signature, the payload, every answer above and the encrypted credentials.

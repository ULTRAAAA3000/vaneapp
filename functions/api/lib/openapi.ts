/**
 * The OpenAPI 3.1 description of the public Vane Post API (`/api/v1`, cpost_ keys).
 * Served at GET /api/v1/openapi.json: paste that URL into a Custom GPT (Actions → Import from URL), Postman or Make.
 *
 * This file is the ONLY hand-written description of the API. scripts/api-e2e.mjs checks it against the real routes:
 * every documented path must exist, and every route under functions/api/v1 (except the Video Engine, which is
 * documented in documentation/VIDEO_ENGINE.md) must be documented. Change a route, change it here.
 *
 * Descriptions are kept short on purpose: Custom GPT Actions reject operation descriptions over 300 characters.
 */

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});
const ok = (description: string, schema: Json, headers?: Json) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { 'application/json': { schema } },
});

const quotaHeaders = {
  'X-Vane-Quota-Limit': { description: 'Your API post limit for this period.', schema: { type: 'integer' } },
  'X-Vane-Quota-Remaining': { description: 'API posts left in this period.', schema: { type: 'integer' } },
  'X-Vane-Quota-Reset': { description: 'Unix time when the monthly quota resets (absent on the Free Trial).', schema: { type: 'integer' } },
};

const idParam = { name: 'id', in: 'path', required: true, description: 'Post id (uuid).', schema: { type: 'string', format: 'uuid' } };

export function openApiDocument(origin: string): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Vane API',
      version: '1.0.0',
      description:
        'Schedule posts to your connected channels from scripts, Make, Zapier or a Custom GPT.\n\n' +
        'Authentication: send your key as `Authorization: Bearer <key>`. Create keys in the dashboard (API access).\n' +
        '- `cpost_live_…` posts for real and counts toward your plan quota.\n' +
        '- `cpost_test_…` is simulated: requests are validated and answered with `"test": true`, but nothing is posted or counted.\n\n' +
        'Quota: 1 request = 1 post, however many channels it targets. Out of quota the API answers 402 `quota_exceeded`.\n' +
        'Retries: send an `Idempotency-Key` header on POST /posts so a retry never creates a second post.\n' +
        'Limits: 100 requests per minute per key (429 `rate_limited`).\n' +
        'Errors are `{ "ok": false, "error": "…", "code": "…" }`: branch on `code`.',
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Account', description: 'Check a key and read the quota.' },
      { name: 'Channels', description: 'Where posts can go.' },
      { name: 'Posts', description: 'Schedule, read and cancel posts.' },
      { name: 'Webhooks', description: 'Get told when a post is published or fails.' },
    ],
    paths: {
      '/me': {
        get: {
          operationId: 'getMe',
          tags: ['Account'],
          summary: 'Check the key',
          description: 'Returns the key (name, type) and the plan it belongs to. Use it as the "test connection" call.',
          responses: {
            '200': ok('The key is valid.', {
              type: 'object',
              required: ['ok', 'key', 'plan', 'apiAccess'],
              properties: {
                ok: { type: 'boolean', const: true },
                key: {
                  type: 'object',
                  properties: { name: { type: 'string' }, scope: { type: 'string', enum: ['post'] }, mode: { type: 'string', enum: ['live', 'test'] } },
                },
                plan: ref('Plan'),
                apiAccess: { type: 'boolean', description: 'False when the plan has no API access (live keys are refused).' },
              },
            }),
            '401': errorResponse('Missing, malformed, unknown or revoked key (`invalid_api_key`).'),
            '403': errorResponse('The plan has no API access (`api_not_in_plan`) or the key is a video key (`wrong_key_scope`).'),
            '429': errorResponse('Rate limited (`rate_limited`).'),
          },
        },
      },
      '/usage': {
        get: {
          operationId: 'getUsage',
          tags: ['Account'],
          summary: 'Read the quota',
          description: 'Plan, API posts used and left this period, when it resets, and what extra posts cost.',
          responses: {
            '200': ok('Current usage.', {
              type: 'object',
              required: ['ok', 'usage'],
              properties: { ok: { type: 'boolean', const: true }, usage: ref('Usage') },
            }, quotaHeaders),
            '401': errorResponse('Invalid key.'),
            '403': errorResponse('No API access on this plan.'),
            '429': errorResponse('Rate limited.'),
          },
        },
      },
      '/channels': {
        get: {
          operationId: 'listChannels',
          tags: ['Channels'],
          summary: 'List channels',
          description: 'Your connected channels. Use their `id` values as `channelIds` when creating a post.',
          responses: {
            '200': ok('Channels, newest first.', {
              type: 'object',
              required: ['ok', 'channels'],
              properties: { ok: { type: 'boolean', const: true }, channels: { type: 'array', items: ref('Channel') } },
            }),
            '401': errorResponse('Invalid key.'),
            '403': errorResponse('No API access on this plan.'),
            '429': errorResponse('Rate limited.'),
          },
        },
      },
      '/posts': {
        get: {
          operationId: 'listPosts',
          tags: ['Posts'],
          summary: 'List posts',
          description: 'Upcoming posts (soonest first) or history (sent, failed, cancelled; newest first). At most 200.',
          parameters: [
            { name: 'view', in: 'query', required: false, description: 'Which list to return. Default: upcoming.', schema: { type: 'string', enum: ['upcoming', 'history'], default: 'upcoming' } },
          ],
          responses: {
            '200': ok('Posts.', {
              type: 'object',
              required: ['ok', 'posts'],
              properties: { ok: { type: 'boolean', const: true }, posts: { type: 'array', items: ref('Post') } },
            }),
            '400': errorResponse('`view` is not upcoming or history.'),
            '401': errorResponse('Invalid key.'),
            '403': errorResponse('No API access on this plan.'),
            '429': errorResponse('Rate limited.'),
          },
        },
        post: {
          operationId: 'createPost',
          tags: ['Posts'],
          summary: 'Schedule a post',
          description: 'Schedules one post to one or more channels. Counts as one API post. Send an Idempotency-Key so retries are safe.',
          parameters: [
            {
              name: 'Idempotency-Key', in: 'header', required: false,
              description: 'Any unique value (a UUID, or your scenario\'s execution id), 1-255 printable characters. A retry with the same key and body returns the first answer and takes no quota. Remembered for 24 hours.',
              schema: { type: 'string', minLength: 1, maxLength: 255 },
            },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: ref('CreatePostRequest') } } },
          responses: {
            '201': ok('Scheduled (or, with a test key, simulated).', ref('CreatePostResponse'), {
              ...quotaHeaders,
              'Idempotent-Replayed': { description: '`true` when this is the stored answer of an earlier request with the same Idempotency-Key.', schema: { type: 'string' } },
            }),
            '400': errorResponse('Invalid body: empty content, a past `scheduledAt`, a text too long for a channel, a bad `mediaUrl`, or a bad Idempotency-Key (`invalid_idempotency_key`).'),
            '401': errorResponse('Invalid key.'),
            '402': errorResponse('Out of quota (`quota_exceeded`). The body has the usage.'),
            '403': errorResponse('No API access on this plan (`api_not_in_plan`).'),
            '404': errorResponse('A channel was not found (the same answer for missing and foreign ids).'),
            '409': errorResponse('A request with this Idempotency-Key is still running (`idempotency_in_progress`). Retry shortly.'),
            '422': errorResponse('This Idempotency-Key was used with a different body (`idempotency_key_reuse`).'),
            '429': errorResponse('Rate limited.'),
          },
        },
      },
      '/posts/{id}': {
        get: {
          operationId: 'getPost',
          tags: ['Posts'],
          summary: 'Get a post',
          description: 'One post with its status: scheduled, processing, sent, failed or cancelled. Poll this after scheduling.',
          parameters: [idParam],
          responses: {
            '200': ok('The post.', {
              type: 'object',
              required: ['ok', 'post'],
              properties: { ok: { type: 'boolean', const: true }, post: ref('Post') },
            }),
            '401': errorResponse('Invalid key.'),
            '404': errorResponse('No such post (the same answer for someone else\'s post).'),
            '429': errorResponse('Rate limited.'),
          },
        },
        delete: {
          operationId: 'cancelPost',
          tags: ['Posts'],
          summary: 'Cancel a post',
          description: 'Cancels a post that is still `scheduled`. The quota unit is not given back. A test key only checks and changes nothing.',
          parameters: [idParam],
          responses: {
            '200': ok('Cancelled.', {
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'boolean', const: true }, test: { type: 'boolean', description: 'True for a test key (nothing changed).' } },
            }),
            '401': errorResponse('Invalid key.'),
            '404': errorResponse('No such post.'),
            '409': errorResponse('The post is no longer scheduled (already sent, failed or cancelled).'),
            '429': errorResponse('Rate limited.'),
          },
        },
      },
      '/webhooks': {
        get: {
          operationId: 'listWebhooks',
          tags: ['Webhooks'],
          summary: 'List webhooks',
          description: 'Your webhook subscriptions. The signing secret is never shown again.',
          responses: {
            '200': ok('The subscriptions.', {
              type: 'object',
              required: ['ok', 'webhooks'],
              properties: { ok: { type: 'boolean', const: true }, webhooks: { type: 'array', items: ref('Webhook') } },
            }),
            '401': errorResponse('Invalid key.'),
            '429': errorResponse('Rate limited.'),
          },
        },
        post: {
          operationId: 'createWebhook',
          tags: ['Webhooks'],
          summary: 'Subscribe a webhook',
          description: 'Vane POSTs a signed JSON event to your https url when a post is published (post.published) or fails (post.failed). The secret in the answer is shown once. A test key saves nothing.',
          requestBody: { required: true, content: { 'application/json': { schema: ref('CreateWebhookRequest') } } },
          responses: {
            '201': ok('Subscribed.', {
              type: 'object',
              required: ['ok', 'webhook', 'secret'],
              properties: {
                ok: { type: 'boolean', const: true },
                test: { type: 'boolean' },
                webhook: ref('Webhook'),
                secret: { type: 'string', description: 'Signs every delivery. Returned only now.' },
              },
            }),
            '400': errorResponse('Invalid url or events.'),
            '401': errorResponse('Invalid key.'),
            '409': errorResponse('That url is already subscribed, or the limit of 10 is reached.'),
            '429': errorResponse('Rate limited.'),
          },
        },
      },
      '/webhooks/{id}': {
        delete: {
          operationId: 'deleteWebhook',
          tags: ['Webhooks'],
          summary: 'Delete a webhook',
          description: 'Stops a subscription. A test key checks and changes nothing.',
          parameters: [{ name: 'id', in: 'path', required: true, description: 'Webhook id (uuid).', schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': ok('Deleted.', { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', const: true }, test: { type: 'boolean' } } }),
            '401': errorResponse('Invalid key.'),
            '404': errorResponse('No such webhook.'),
            '429': errorResponse('Rate limited.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Your API key: `cpost_live_…` (real) or `cpost_test_…` (simulated).',
        },
      },
      schemas: {
        Webhook: {
          type: 'object',
          required: ['id', 'url', 'events', 'disabled', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            url: { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string', enum: ['post.published', 'post.failed'] } },
            lastStatus: { type: ['integer', 'null'], description: 'HTTP status of the latest delivery (0 = no answer).' },
            disabled: { type: 'boolean', description: 'True after your server answered 410 Gone.' },
            createdAt: { type: 'integer', description: 'Unix seconds.' },
          },
        },
        CreateWebhookRequest: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri', description: 'Public https address (port 443, a host name, not an IP).' },
            events: { type: 'array', minItems: 1, items: { type: 'string', enum: ['post.published', 'post.failed'] }, description: 'Default: both.' },
          },
        },
        WebhookEvent: {
          type: 'object',
          description: 'The body Vane sends. Headers: Vane-Event, Vane-Delivery (same on retries), Vane-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with your secret>. Reply 2xx; otherwise Vane retries after 1 min, 5 min, 30 min, 2 h, 12 h. 410 ends the subscription.',
          required: ['id', 'type', 'createdAt', 'data'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Delivery id: de-duplicate on it.' },
            type: { type: 'string', enum: ['post.published', 'post.failed'] },
            createdAt: { type: 'string', format: 'date-time' },
            data: { type: 'object', properties: { post: ref('Post') } },
          },
        },
        Error: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string', description: 'A message for people.' },
            code: { type: 'string', description: 'A stable code for programs, e.g. quota_exceeded.' },
          },
        },
        Channel: {
          type: 'object',
          required: ['id', 'platform', 'name', 'isActive', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            platform: { type: 'string', examples: ['telegram'] },
            name: { type: 'string' },
            isActive: { type: 'boolean' },
            createdAt: { type: 'integer', description: 'Unix seconds.' },
          },
        },
        Post: {
          type: 'object',
          required: ['id', 'groupId', 'channelId', 'channelName', 'platform', 'content', 'scheduledAt', 'status', 'attempts'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            groupId: { type: 'string', format: 'uuid', description: 'Posts created by one request share a groupId (one per channel).' },
            channelId: { type: 'string', format: 'uuid' },
            channelName: { type: 'string' },
            platform: { type: 'string' },
            content: { type: 'string' },
            mediaUrl: { type: ['string', 'null'] },
            mediaKind: { type: ['string', 'null'], enum: ['image', 'video', null] },
            scheduledAt: { type: 'integer', description: 'Unix seconds.' },
            status: { type: 'string', enum: ['scheduled', 'processing', 'sent', 'failed', 'cancelled'] },
            attempts: { type: 'integer', description: 'Delivery attempts so far (temporary failures are retried).' },
            error: { type: ['string', 'null'], description: 'Why a post failed.' },
            sentAt: { type: ['integer', 'null'], description: 'Unix seconds when it was published.' },
            url: { type: ['string', 'null'], description: 'Link to the published post on its network (https). Null until sent, or when the network gives no link.' },
          },
        },
        CreatePostRequest: {
          type: 'object',
          required: ['content', 'channelIds', 'scheduledAt'],
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 10000, description: 'The post text. Each channel has its own limit (Telegram 4096, or 1024 with an image).' },
            channelIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', format: 'uuid' }, description: 'Channel ids from GET /channels.' },
            scheduledAt: {
              description: 'When to publish: an ISO-8601 time WITH a timezone (e.g. 2026-10-20T09:00:00Z), or unix seconds. Must be in the future and within a year.',
              oneOf: [{ type: 'string', format: 'date-time' }, { type: 'integer' }],
            },
            mediaUrl: { type: 'string', format: 'uri', description: 'Optional public https image URL.' },
          },
        },
        CreatePostResponse: {
          type: 'object',
          required: ['ok', 'groupId', 'scheduledAt', 'posts', 'usage'],
          properties: {
            ok: { type: 'boolean', const: true },
            test: { type: 'boolean', description: 'Present (true) when a test key answered: nothing was saved or counted.' },
            groupId: { type: 'string', format: 'uuid' },
            scheduledAt: { type: 'integer', description: 'Unix seconds.' },
            posts: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' }, channelId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['scheduled'] } },
              },
            },
            overage: { type: 'boolean', description: 'True when this post went beyond the quota and is billed (only when overage billing is on).' },
            usage: {
              type: 'object',
              properties: { api: ref('QuotaBucket'), resetsAt: { type: ['integer', 'null'] } },
            },
          },
        },
        QuotaBucket: {
          type: 'object',
          required: ['limit', 'used', 'remaining'],
          properties: { limit: { type: 'integer' }, used: { type: 'integer' }, remaining: { type: 'integer' } },
        },
        Plan: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: ['free', 'api', 'pro'] },
            label: { type: 'string' },
            status: { type: 'string', enum: ['active', 'past_due', 'canceled'] },
            lapsed: { type: 'boolean', description: 'A paid plan that ended: Free Trial limits apply until it is renewed.' },
            apiAddon: { type: 'boolean' },
            currentPeriodEnd: { type: ['integer', 'null'] },
          },
        },
        Usage: {
          type: 'object',
          properties: {
            plan: ref('Plan'),
            period: { type: 'object', properties: { key: { type: 'string', description: "'lifetime' or 'YYYY-MM' (UTC)" }, resetsAt: { type: ['integer', 'null'] } } },
            api: ref('QuotaBucket'),
            ui: ref('QuotaBucket'),
            shared: { oneOf: [ref('QuotaBucket'), { type: 'null' }], description: 'Free Trial only: dashboard and API posts share this total.' },
            apiAccess: { type: 'boolean' },
            overage: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                postUsd: { type: ['number', 'null'], description: 'Price of a post beyond the quota.' },
                aiPostUsd: { type: ['number', 'null'] },
                posts: { type: 'integer' },
                costUsd: { type: 'number' },
              },
            },
          },
        },
      },
    },
  };
}

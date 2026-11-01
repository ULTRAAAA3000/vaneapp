import type { Env } from '../../../types';
import { readTelegramChatId } from '../channels/credentials';
import { toB64Url } from './encoding';
import { fail, json, UUID_RE } from './http';
import { ROOT_DOMAIN, siteOf } from './hosts';
import { postUrl } from './postlink';
import { textProblem } from './moderation';
import { bump, retryAfter } from './throttle';

const PER_HOUR = 60;
const MAX_TEXT = 10_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MEDIA_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

const NAMES: Record<string, string> = {
  telegram: 'Telegram', x: 'X', linkedin: 'LinkedIn', bluesky: 'Bluesky', mastodon: 'Mastodon', threads: 'Threads', discord: 'Discord',
  devto: 'Dev.to', reddit: 'Reddit', facebook: 'Facebook', pinterest: 'Pinterest', webhook: 'Webhook',
};
export const networkName = (t: string): string => NAMES[t] ?? t;

const origin = (request: Request): string => {
  const url = new URL(request.url);
  return siteOf(url.hostname) === 'other' ? url.origin : `https://${ROOT_DOMAIN}`;
};
const addressOf = (env: Env, request: Request, token: string): string => `${origin(request)}/p/${token}`;

const isUnavailable = (err: unknown): boolean => err instanceof Error && /no such table/i.test(err.message);
const notReady = (): Response => fail(503, 'Share preview needs one database update (run schema.sql). Please try again later.');

/** The texts of the channels of this post that really went out (empty = nothing to share, or not yours). */
async function sentTexts(env: Env, userId: string, groupId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT content FROM posts WHERE COALESCE(group_id, id) = ?1 AND user_id = ?2 AND status = 'sent' LIMIT 30`).bind(groupId, userId).all<{ content: string }>();
  return results.map((r) => r.content);
}

export async function sharePost(env: Env, request: Request, userId: string, groupId: unknown): Promise<Response> {
  if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) return fail(400, 'groupId must be a post id.');
  const texts = await sentTexts(env, userId, groupId);
  if (!texts.length) return fail(404, 'Only a published post can be shared.');
  try {
    const old = await env.DB.prepare('SELECT token FROM post_previews WHERE group_id = ?1 AND user_id = ?2').bind(groupId, userId).first<{ token: string }>();
    if (old) return json({ ok: true, groupId, token: old.token, url: addressOf(env, request, old.token) });

    // The page lives on our domain, so the same text check as for posting applies before a new address is made.
    const bad = textProblem(env, ...texts);
    if (bad) return fail(422, bad);

    const key = `preview:${userId}`;
    const wait = await retryAfter(env, key, PER_HOUR);
    if (wait) return fail(429, 'Too many previews shared. Try again later.', { 'Retry-After': String(wait) });
    await bump(env, key, 3600);

    const token = toB64Url(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare('INSERT OR IGNORE INTO post_previews (token, group_id, user_id) VALUES (?1, ?2, ?3)').bind(token, groupId, userId).run();
    const row = await env.DB.prepare('SELECT token FROM post_previews WHERE group_id = ?1 AND user_id = ?2').bind(groupId, userId).first<{ token: string }>();
    if (!row) return fail(500, 'Could not create the preview. Please try again.');
    return json({ ok: true, groupId, token: row.token, url: addressOf(env, request, row.token) }, 201);
  } catch (err) {
    if (isUnavailable(err)) return notReady();
    throw err;
  }
}

export async function stopSharing(env: Env, userId: string, groupId: string | null): Promise<Response> {
  if (!groupId || !UUID_RE.test(groupId)) return fail(400, 'groupId must be a post id.');
  try {
    await env.DB.prepare('DELETE FROM post_previews WHERE group_id = ?1 AND user_id = ?2').bind(groupId, userId).run();
  } catch (err) {
    if (isUnavailable(err)) return notReady();
    throw err;
  }
  return json({ ok: true });
}

export async function listShares(env: Env, request: Request, userId: string): Promise<Response> {
  try {
    const { results } = await env.DB.prepare('SELECT group_id, token FROM post_previews WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 300').bind(userId).all<{ group_id: string; token: string }>();
    const shares: Record<string, string> = {};
    for (const r of results) shares[r.group_id] = addressOf(env, request, r.token);
    return json({ ok: true, shares });
  } catch (err) {
    if (isUnavailable(err)) return json({ ok: true, shares: {} });
    throw err;
  }
}

// ───────────────────────── the public page ─────────────────────────
interface Row { content: string; media_keys: string; sent_at: number | null; scheduled_at: number; external_id: string | null; type: string; credentials: string; channel_id: string }

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function previewImage(media: string, appUrl: string): string | null {
  try {
    const first = (JSON.parse(media) as unknown[])[0];
    if (typeof first !== 'string') return null;
    if (first.startsWith('https://')) {
      const u = new URL(first);
      return /\.(jpe?g|png|webp|gif)$/i.test(u.pathname) && !u.username && !u.password ? u.toString() : null;
    }
    return MEDIA_KEY_RE.test(first) && appUrl ? `${appUrl}/api/media/${first}` : null;
  } catch {
    return null;
  }
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function renderPreview(o: { text: string; image: string | null; networks: { name: string; url: string | null }[]; sentAt: number; address: string; site: string }): string {
  const names = o.networks.map((n) => n.name);
  const title = `A post published with Vane on ${joinNames(names)}`;
  const text = o.text.length > MAX_TEXT ? `${o.text.slice(0, MAX_TEXT - 1)}…` : o.text;
  const desc = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  const when = new Date(o.sentAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const chips = o.networks.map((n) => (n.url
    ? `<a class="chip" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(n.name)} <span aria-hidden="true">↗</span><span class="sr">, open the post</span></a>`
    : `<span class="chip">${esc(n.name)}</span>`)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<meta name="theme-color" content="#070708" />
<link rel="canonical" href="${esc(o.address)}" />
<link rel="icon" href="${esc(o.site)}/favicon.svg" type="image/svg+xml" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="Vane" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(o.address)}" />
<meta property="og:image" content="${esc(o.image ?? `${o.site}/assets/og.png`)}" />
<meta name="twitter:card" content="${o.image ? 'summary_large_image' : 'summary'}" />
<style>
*{box-sizing:border-box}html{color-scheme:dark}
body{margin:0;min-height:100vh;background:#070708;color:#fff;font-family:Geist,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.glow{position:fixed;inset:0;background:linear-gradient(to bottom,rgba(255,255,255,.05),transparent 40%);pointer-events:none}
.wrap{position:relative;max-width:640px;margin:0 auto;padding:20px 20px 56px}
header{display:flex;align-items:center;justify-content:space-between;padding:6px 0 28px}
.logo{font-size:1.125rem;font-weight:600;color:#fff;text-decoration:none}
.try{font-size:.875rem;font-weight:600;color:#000;background:#fff;border-radius:999px;padding:.55rem 1.1rem;text-decoration:none}
.eyebrow{font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.4);margin:0}
h1{font-size:1.5rem;line-height:1.25;font-weight:600;letter-spacing:-.01em;margin:.5rem 0 1rem}
.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:1.5rem;padding:1.4rem;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:1.0625rem;line-height:1.6;color:rgba(255,255,255,.92);margin:0}
.img{display:block;width:100%;max-height:420px;object-fit:cover;border-radius:1rem;margin-top:1rem;background:rgba(255,255,255,.04)}
.meta{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.1rem}
.chip{display:inline-flex;align-items:center;gap:.35rem;font-size:.8125rem;color:rgba(255,255,255,.8);background:rgba(255,255,255,.08);border-radius:999px;padding:.35rem .8rem;text-decoration:none}
a.chip:hover{background:rgba(255,255,255,.16)}
.when{margin:1rem 0 0;font-size:.8125rem;color:rgba(255,255,255,.45)}
.cta{margin-top:1.6rem;text-align:center;padding:1.6rem 1.2rem;border-radius:1.5rem;border:1px solid rgba(255,255,255,.1);background:linear-gradient(135deg,rgba(255,255,255,.06),rgba(255,255,255,.02))}
.cta p{margin:0 0 .3rem;font-size:1.0625rem;font-weight:600}.cta small{display:block;color:rgba(255,255,255,.5);font-size:.875rem;margin-bottom:1rem}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
footer{margin-top:1.4rem;text-align:center;font-size:.75rem;color:rgba(255,255,255,.35)}footer a{color:inherit}
</style>
</head>
<body>
<div class="glow" aria-hidden="true"></div>
<div class="wrap">
<header><a class="logo" href="${esc(o.site)}/" aria-label="Vane home">vane</a><a class="try" href="${esc(o.site)}/login?mode=register">Try Vane Free</a></header>
<main>
<p class="eyebrow">Published with Vane</p>
<h1>One post, ${o.networks.length === 1 ? 'one network' : `${o.networks.length} networks`}, one click.</h1>
<article class="card">
<p class="text">${esc(text)}</p>
${o.image ? `<img class="img" src="${esc(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
<div class="meta">${chips}</div>
<p class="when">Published <time datetime="${new Date(o.sentAt * 1000).toISOString()}">${esc(when)}</time> to ${esc(joinNames(names))}</p>
</article>
<section class="cta">
<p>Write once. Publish everywhere.</p>
<small>Schedule posts to Telegram, Bluesky, Mastodon and more from one place.</small>
<a class="try" href="${esc(o.site)}/login?mode=register">Try Vane Free</a>
</section>
</main>
<footer>This page shows a post its author chose to share. <a href="${esc(o.site)}/terms">Terms</a> · <a href="${esc(o.site)}/about#contact">Report</a></footer>
</div>
</body>
</html>`;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=60',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const gone = (): Response => new Response('<!DOCTYPE html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — Vane</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#070708;color:#fff;font-family:system-ui,sans-serif;text-align:center"><div><h1 style="font-weight:600">This preview is not available</h1><p style="color:#999">The author may have stopped sharing it.</p><p><a style="color:#fff" href="/">Go to Vane</a></p></div>', { status: 404, headers: { ...PAGE_HEADERS, 'Cache-Control': 'no-store' } });

export async function previewPage(env: Env, request: Request, token: string): Promise<Response> {
  if (!TOKEN_RE.test(token)) return gone();
  let rows: Row[] = [];
  try {
    const res = await env.DB
      .prepare(
        `SELECT p.content, p.media_keys, p.sent_at, p.scheduled_at, p.external_id, p.channel_id, c.type, c.credentials
           FROM post_previews v JOIN posts p ON COALESCE(p.group_id, p.id) = v.group_id AND p.user_id = v.user_id JOIN channels c ON c.id = p.channel_id
          WHERE v.token = ?1 AND p.status = 'sent' ORDER BY p.sent_at ASC LIMIT 30`,
      )
      .bind(token)
      .all<Row>();
    rows = res.results;
  } catch {
    return gone();
  }
  if (!rows.length) return gone();

  const chats = new Map<string, string | null>();
  const seen = new Map<string, { name: string; url: string | null }>();
  for (const r of rows) {
    if (r.type === 'telegram' && r.external_id && !chats.has(r.channel_id)) chats.set(r.channel_id, await readTelegramChatId(r.credentials, env.ENCRYPTION_KEY));
    const url = postUrl(r.type, r.external_id, chats.get(r.channel_id));
    const have = seen.get(r.type);
    if (!have) seen.set(r.type, { name: networkName(r.type), url });
    else if (!have.url && url) have.url = url;
  }
  const first = rows[0];
  const site = origin(request);
  const html = renderPreview({
    text: first.content, image: previewImage(first.media_keys, site), networks: [...seen.values()],
    sentAt: Math.max(...rows.map((r) => r.sent_at ?? r.scheduled_at)), address: `${site}/p/${token}`, site,
  });
  return new Response(html, { status: 200, headers: PAGE_HEADERS });
}

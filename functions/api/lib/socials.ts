/**
 * The landing page's "Follow Vane" section. The links are rows in D1 (`social_links`), the heading and intro are one JSON value in
 * `settings` ('landing.socials'). Both are edited in /admin → Social; the card design lives in index.html and is not editable.
 */
import type { Env } from '../../../types';

/** Networks with an icon on the landing page. 'other' gets the generic link icon. Adding one here also needs its icon in index.html. */
export const NETWORKS = [
  { id: 'telegram', name: 'Telegram' },
  { id: 'bluesky', name: 'Bluesky' },
  { id: 'mastodon', name: 'Mastodon' },
  { id: 'threads', name: 'Threads' },
  { id: 'linkedin', name: 'LinkedIn' },
  { id: 'x', name: 'X' },
  { id: 'instagram', name: 'Instagram' },
  { id: 'youtube', name: 'YouTube' },
  { id: 'tiktok', name: 'TikTok' },
  { id: 'facebook', name: 'Facebook' },
  { id: 'github', name: 'GitHub' },
  { id: 'discord', name: 'Discord' },
  { id: 'reddit', name: 'Reddit' },
  { id: 'other', name: 'Other (plain link icon)' },
] as const;
const NETWORK_IDS = new Set<string>(NETWORKS.map((n) => n.id));

export const MAX_LINKS = 12;
const SECTION_KEY = 'landing.socials';

export interface SocialLink {
  id: string;
  network: string;
  name: string;
  handle: string;
  description: string;
  url: string;
  ctaLabel: string;
  isPublic: boolean;
  sort: number;
}

interface SocialRow {
  id: string;
  network: string;
  name: string;
  handle: string;
  description: string;
  url: string;
  cta_label: string;
  is_public: number;
  sort: number;
}

export const rowToLink = (r: SocialRow): SocialLink => ({
  id: r.id, network: r.network, name: r.name, handle: r.handle, description: r.description, url: r.url,
  ctaLabel: r.cta_label, isPublic: r.is_public === 1, sort: r.sort,
});

export async function listLinks(env: Env, opts: { publicOnly?: boolean } = {}): Promise<SocialLink[]> {
  const { results } = await env.DB
    .prepare(`SELECT * FROM social_links ${opts.publicOnly ? 'WHERE is_public = 1' : ''} ORDER BY sort ASC, created_at ASC, id ASC`)
    .all<SocialRow>();
  return results.map(rowToLink);
}

export async function getLink(env: Env, id: string): Promise<SocialLink | null> {
  const r = await env.DB.prepare('SELECT * FROM social_links WHERE id = ?1').bind(id).first<SocialRow>();
  return r ? rowToLink(r) : null;
}

/** An id for a link made in the admin: '<network>-<6 hex>'. */
export function newLinkId(network: string): string {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return `${network}-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** True when the schema has not been applied yet (run `npm run db:remote` once). */
export const isMissingTable = (e: unknown): boolean => e instanceof Error && /no such table/i.test(e.message);

// ───────────────────────── validation ─────────────────────────

export interface SocialInput {
  network?: string;
  name?: string;
  handle?: string;
  description?: string;
  url?: string;
  ctaLabel?: string;
  isPublic?: boolean;
  sort?: number;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const line = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length <= max && v.trim().length >= min && !CONTROL.test(v);

/** Only plain https addresses: no other schemes, no credentials in the address, a real host name. Returns the normalised address. */
export function cleanUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  let u: URL;
  try { u = new URL(v.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  return u.toString();
}

export function validateSocialInput(body: Record<string, unknown>, creating: boolean): { ok: true; value: SocialInput } | { ok: false; error: string } {
  const v: SocialInput = {};
  const bad = (m: string) => ({ ok: false as const, error: m });

  if (body.network !== undefined || creating) {
    if (typeof body.network !== 'string' || !NETWORK_IDS.has(body.network)) return bad('Pick a network from the list.');
    v.network = body.network;
  }
  if (body.name !== undefined || creating) {
    if (!line(body.name, 40, 1)) return bad('Name is required (max 40 characters, one line).');
    v.name = body.name.trim();
  }
  if (body.handle !== undefined) { if (!line(body.handle, 60)) return bad('Handle is too long (max 60 characters, one line).'); v.handle = body.handle.trim(); }
  if (body.description !== undefined) { if (!line(body.description, 160)) return bad('Description is too long (max 160 characters, one line).'); v.description = body.description.trim(); }
  if (body.ctaLabel !== undefined) { if (!line(body.ctaLabel, 30, 1)) return bad('Button text must be 1-30 characters.'); v.ctaLabel = body.ctaLabel.trim(); }
  if (body.url !== undefined || creating) {
    const u = cleanUrl(body.url);
    if (!u) return bad('The link must be a full https:// address, like https://t.me/vanenews.');
    v.url = u;
  }
  if (body.sort !== undefined) {
    if (typeof body.sort !== 'number' || !Number.isInteger(body.sort) || body.sort < -1000 || body.sort > 100000) return bad('Order must be a whole number.');
    v.sort = body.sort;
  }
  if (body.isPublic !== undefined) { if (typeof body.isPublic !== 'boolean') return bad('isPublic must be true or false.'); v.isPublic = body.isPublic; }
  return { ok: true, value: v };
}

// ───────────────────────── section heading ─────────────────────────

export interface SocialSection {
  eyebrow: string;
  title: string;
  intro: string;
}

export const DEFAULT_SECTION: SocialSection = {
  eyebrow: 'Follow',
  title: 'Follow Vane where you already are.',
  intro: 'Product news, releases and tips, posted to the networks you use every day.',
};

export async function getSection(env: Env): Promise<SocialSection> {
  const out = { ...DEFAULT_SECTION };
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(SECTION_KEY).first<{ value: string }>();
    if (r) {
      const saved: unknown = JSON.parse(r.value);
      if (saved && typeof saved === 'object') {
        for (const k of ['eyebrow', 'title', 'intro'] as const) {
          const x = (saved as Record<string, unknown>)[k];
          if (typeof x === 'string') out[k] = x;
        }
      }
    }
  } catch {
    /* settings missing or a corrupt row: the defaults stay */
  }
  return out;
}

export function validateSection(body: Record<string, unknown>): { ok: true; value: SocialSection } | { ok: false; error: string } {
  const bad = (m: string) => ({ ok: false as const, error: m });
  if (!line(body.eyebrow, 40)) return bad('The small label is too long (max 40 characters, one line). Leave it empty to hide it.');
  if (!line(body.title, 120, 1)) return bad('The heading is required (max 120 characters, one line).');
  if (!line(body.intro, 300)) return bad('The intro is too long (max 300 characters, one line). Leave it empty to hide it.');
  return { ok: true, value: { eyebrow: body.eyebrow.trim(), title: body.title.trim(), intro: body.intro.trim() } };
}

export async function saveSection(env: Env, s: SocialSection): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(SECTION_KEY, JSON.stringify(s))
    .run();
}

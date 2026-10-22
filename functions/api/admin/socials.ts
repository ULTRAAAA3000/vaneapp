/**
 * The landing page's "Follow Vane" section, edited from /admin → Social.
 *
 * GET    /api/admin/socials              → { section, links (also hidden ones), networks }
 * POST   /api/admin/socials              → add a link   { network, name, url, handle?, description?, ctaLabel?, sort?, isPublic? }
 * PUT    /api/admin/socials?id=telegram  → change any subset of a link's fields
 * PUT    /api/admin/socials?part=section → { eyebrow, title, intro }: the words above the cards
 * DELETE /api/admin/socials?id=telegram  → remove a link
 *
 * Only the words, the links and the order are data; the card design is fixed. Public changes show within the 60 s cache of GET /api/socials.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../../types';
import { audit, requireAdmin } from '../lib/admin';
import { fail, isRecord, json, methodNotAllowed, readJson } from '../lib/http';
import {
  MAX_LINKS, NETWORKS, getLink, getSection, isMissingTable, listLinks, newLinkId, saveSection, validateSection, validateSocialInput, type SocialInput,
} from '../lib/socials';

const NEEDS_DB = 'The database does not have the social links table yet. Run npm run db:remote once, then reload this page.';
const COLUMN: Record<keyof SocialInput, string> = {
  network: 'network', name: 'name', handle: 'handle', description: 'description', url: 'url', ctaLabel: 'cta_label', isPublic: 'is_public', sort: 'sort',
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  try {
    const [section, links] = await Promise.all([getSection(env), listLinks(env)]);
    return json({ ok: true, section, links, networks: NETWORKS, max: MAX_LINKS });
  } catch (err) {
    if (isMissingTable(err)) return fail(409, NEEDS_DB);
    throw err;
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');
  const v = validateSocialInput(parsed.data, true);
  if (!v.ok) return fail(400, v.error);
  const f = v.value;
  try {
    const count = await env.DB.prepare('SELECT COUNT(*) n FROM social_links').first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_LINKS) return fail(400, `Up to ${MAX_LINKS} links fit the section. Remove one first.`);
    let id = newLinkId(f.network as string);
    for (let i = 0; i < 3 && (await getLink(env, id)); i++) id = newLinkId(f.network as string);
    await env.DB
      .prepare('INSERT INTO social_links (id, network, name, handle, description, url, cta_label, is_public, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(id, f.network, f.name, f.handle ?? '', f.description ?? '', f.url, f.ctaLabel ?? 'Follow', f.isPublic === false ? 0 : 1, f.sort ?? 100)
      .run();
    await audit(env, request, 'social.create', id, { name: f.name, url: f.url });
    return json({ ok: true, link: await getLink(env, id) }, 201);
  } catch (err) {
    if (isMissingTable(err)) return fail(409, NEEDS_DB);
    throw err;
  }
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const q = new URL(request.url).searchParams;
  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  if (!isRecord(parsed.data)) return fail(400, 'Body must be a JSON object');

  if (q.get('part') === 'section') {
    const v = validateSection(parsed.data);
    if (!v.ok) return fail(400, v.error);
    try {
      const before = await getSection(env);
      await saveSection(env, v.value);
      await audit(env, request, 'social.section', null, { from: before, to: v.value });
      return json({ ok: true, section: v.value });
    } catch (err) {
      if (isMissingTable(err)) return fail(409, NEEDS_DB);
      throw err;
    }
  }

  const id = q.get('id') ?? '';
  try {
    const current = await getLink(env, id);
    if (!current) return fail(404, 'Link not found.');
    const { id: _ignored, ...rest } = parsed.data;
    void _ignored;
    const v = validateSocialInput(rest, false);
    if (!v.ok) return fail(400, v.error);
    const fields = Object.entries(v.value).filter(([, x]) => x !== undefined) as [keyof SocialInput, unknown][];
    if (!fields.length) return fail(400, 'Nothing to change.');
    const sets = fields.map(([k], i) => `${COLUMN[k]} = ?${i + 2}`);
    await env.DB
      .prepare(`UPDATE social_links SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = ?1`)
      .bind(id, ...fields.map(([k, x]) => (k === 'isPublic' ? (x ? 1 : 0) : x)))
      .run();
    const changed: Record<string, unknown> = {};
    for (const [k, x] of fields) changed[k] = { from: (current as unknown as Record<string, unknown>)[k], to: x };
    await audit(env, request, 'social.update', id, changed);
    return json({ ok: true, link: await getLink(env, id) });
  } catch (err) {
    if (isMissingTable(err)) return fail(409, NEEDS_DB);
    throw err;
  }
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  try {
    const current = await getLink(env, id);
    if (!current) return fail(404, 'Link not found.');
    await env.DB.prepare('DELETE FROM social_links WHERE id = ?1').bind(id).run();
    await audit(env, request, 'social.delete', id, { name: current.name, url: current.url });
    return json({ ok: true });
  } catch (err) {
    if (isMissingTable(err)) return fail(409, NEEDS_DB);
    throw err;
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET, POST, PUT, DELETE');

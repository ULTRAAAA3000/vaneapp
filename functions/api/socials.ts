/** GET /api/socials → the "Follow Vane" section of the landing page: its heading and the public links. */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { fail, json, methodNotAllowed } from './lib/http';
import { getSection, isMissingTable, listLinks } from './lib/socials';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const [section, links] = await Promise.all([getSection(env), listLinks(env, { publicOnly: true })]);
    return json(
      { ok: true, section, links: links.map((l) => ({ id: l.id, network: l.network, name: l.name, handle: l.handle, description: l.description, url: l.url, ctaLabel: l.ctaLabel })) },
      200,
      { 'Cache-Control': 'public, max-age=60' },
    );
  } catch (err) {
    // The table is created by schema.sql. Until it is applied the landing page keeps the links written into index.html.
    if (isMissingTable(err)) return fail(503, 'Social links are not set up yet.');
    throw err;
  }
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('GET');

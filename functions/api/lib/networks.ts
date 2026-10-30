/**
 * The networks Vane knows, and whether each one can be switched on. A network that is NOT listed here is simply not managed:
 * nothing about it changes. When you add a network anywhere in the code, add it to this list too (so the admin can switch it).
 *
 *   implemented = the code is written (connect flow + publishing). It is the ONE thing that decides whether the admin may
 *                 switch a network on; the platform's own review / verification does not matter for that (Vane may already be
 *                 approved, or still waiting: the admin keeps a note). When you write the code for a new network, flip the flag.
 *   enabled     = the admin's switch (table network_flags). No row means ON for an implemented network, so adding this
 *                 feature changes nothing until somebody switches a network off.
 *
 * A switched-off network: nobody can connect a new account, no new post can be scheduled to its channels, and posts
 * already scheduled for it WAIT (the cron worker skips them) instead of failing. If it stays off for 2 hours past the
 * scheduled time the post fails with a clear reason.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { failCode } from './http';
import { hasRealPublisher } from './videopublishers';
import type { VideoPlatform } from './videochannels';

export type NetworkProduct = 'post' | 'studio';

export interface NetworkInfo {
  id: string;
  name: string;
  product: NetworkProduct;
  /** true = the code exists (connect + publish) */
  implemented: boolean;
  /** what exists in the code, shown in the admin */
  code: string;
}

/** Vane Studio networks are detected from the code itself: implemented as soon as a real publisher is registered (videopublishers.ts). */
const studio = (id: VideoPlatform, name: string, what: string): NetworkInfo => {
  const done = hasRealPublisher(id);
  return { id, name, product: 'studio', implemented: done, code: done ? what : 'Connect and upload flow not written yet' };
};

export const NETWORKS: readonly NetworkInfo[] = [
  { id: 'telegram', name: 'Telegram', product: 'post', implemented: true, code: 'Connect (own bot or Vane bot) and publish' },
  { id: 'bluesky', name: 'Bluesky', product: 'post', implemented: true, code: 'Connect (app password) and publish' },
  { id: 'mastodon', name: 'Mastodon', product: 'post', implemented: true, code: 'Connect (OAuth on any server) and publish' },
  { id: 'linkedin', name: 'LinkedIn', product: 'post', implemented: true, code: 'Connect (OAuth) and publish, token renewal' },
  { id: 'threads', name: 'Threads', product: 'post', implemented: true, code: 'Connect (OAuth) and publish, token renewal' },
  { id: 'discord', name: 'Discord', product: 'post', implemented: true, code: 'Connect (channel webhook) and publish' },
  { id: 'devto', name: 'Dev.to', product: 'post', implemented: true, code: 'Connect (API key) and publish' },
  { id: 'reddit', name: 'Reddit', product: 'post', implemented: true, code: 'Connect (OAuth, one subreddit per channel) and publish text posts, token renewal' },
  { id: 'facebook', name: 'Facebook Pages', product: 'post', implemented: true, code: 'Connect (Facebook Login, every Page you manage) and publish text, photo and video posts' },
  { id: 'pinterest', name: 'Pinterest', product: 'post', implemented: false, code: 'Not written yet (connect, choose a board, publish Pins)' },
  { id: 'x', name: 'X', product: 'post', implemented: false, code: 'Not written yet (only reserved in the database)' },
  { id: 'webhook', name: 'Webhook channel', product: 'post', implemented: false, code: 'Not written yet (post webhooks for your own endpoint are a separate feature)' },
  studio('youtube', 'YouTube', 'Connect (Google OAuth, upload scope only) and upload (resumable, cover, made-for-kids, category)'),
  studio('tiktok', 'TikTok', ''),
  studio('instagram', 'Instagram Reels', 'Connect (Instagram Login, Business/Creator) and publish Reels from a temporary public link'),
];

export const networkInfo = (id: string): NetworkInfo | undefined => NETWORKS.find((n) => n.id === id);

export interface Flag {
  enabled: boolean;
  note: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

const TTL_MS = 15_000;
let cache: { at: number; flags: Map<string, Flag> } | null = null;
export const invalidateNetworkFlags = (): void => {
  cache = null;
};

export async function networkFlags(env: { DB: D1Database }): Promise<Map<string, Flag>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.flags;
  const flags = new Map<string, Flag>();
  try {
    const { results } = await env.DB
      .prepare('SELECT network, enabled, note, updated_at, updated_by FROM network_flags')
      .all<{ network: string; enabled: number; note: string; updated_at: number; updated_by: string | null }>();
    for (const r of results) flags.set(r.network, { enabled: r.enabled === 1, note: r.note, updatedAt: r.updated_at, updatedBy: r.updated_by });
  } catch {
    /* table missing (schema not applied yet): every implemented network stays on */
  }
  cache = { at: Date.now(), flags };
  return flags;
}

/** Can people use this network right now? Not implemented: never. Implemented: yes unless the admin switched it off. */
export function isOn(id: string, flags: Map<string, Flag>): boolean {
  const info = networkInfo(id);
  if (!info) return true; // not in this list (a network somebody just added): the admin does not manage it yet, so it is left exactly as it was
  return info.implemented && (flags.get(id)?.enabled ?? true);
}

export async function networkEnabled(env: { DB: D1Database }, id: string): Promise<boolean> {
  return isOn(id, await networkFlags(env));
}

/** Implemented networks the admin has switched off: what the cron worker must leave alone. */
export async function pausedNetworks(env: { DB: D1Database }): Promise<string[]> {
  const flags = await networkFlags(env);
  return NETWORKS.filter((n) => n.implemented && flags.get(n.id)?.enabled === false).map((n) => n.id);
}

/** null = fine; otherwise the response to return ("<network> is paused"). */
export async function networkOff(env: { DB: D1Database }, id: string): Promise<Response | null> {
  if (await networkEnabled(env, id)) return null;
  const info = networkInfo(id);
  return failCode(503, 'network_disabled', `${info?.name ?? id} is switched off right now. Try again later.`);
}

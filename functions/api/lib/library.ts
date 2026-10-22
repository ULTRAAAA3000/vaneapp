/**
 * The Library: every file a person uploaded for their posts, listed so it can be reused, copied or deleted, and counted against the
 * plan's `storageMb`. Rows are written by POST /api/media/upload. Studio videos live in their own table (`videos`) and are not part of this.
 */
import type { Env } from '../../../types';
import { fail } from './http';
import { specOf } from './plans';
import { getSettings } from './settings';
import { isMissingTable } from './socials';
import { loadSubscription } from './usage';

export const MB = 1024 * 1024;
export const PAGE_SIZE = 60;

export interface LibraryAsset {
  id: string;
  key: string;
  url: string;
  kind: 'image' | 'video';
  name: string;
  size: number;
  width: number | null;
  height: number | null;
  contentType: string;
  createdAt: number;
  /** attached to a post that has not been sent yet, so it cannot be deleted */
  inUse: boolean;
}

interface AssetRow {
  id: string; r2_key: string; kind: 'image' | 'video'; content_type: string; size_bytes: number;
  width: number | null; height: number | null; name: string; created_at: number; thumb_key: string | null;
  seq: number;                       // the table's rowid: files stored in the same second keep their upload order
}

/** A file name that is safe to store and show: no path, no control characters, one line, at most 120 characters. */
export function cleanFileName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = Array.from(base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 120).join('');
  return name || fallback;
}

/** Called after a file is stored in R2. Never throws: before schema.sql is applied the table is missing and uploads must keep working. */
export async function recordUpload(
  env: Env,
  a: { userId: string; key: string; kind: 'image' | 'video'; contentType: string; size: number; width?: number; height?: number; name: string },
): Promise<void> {
  try {
    await env.DB
      .prepare('INSERT OR IGNORE INTO media_assets (id, user_id, r2_key, kind, content_type, size_bytes, width, height, name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(crypto.randomUUID(), a.userId, a.key, a.kind, a.contentType, a.size, a.width ?? null, a.height ?? null, a.name)
      .run();
  } catch (err) {
    if (!isMissingTable(err)) console.error('library: could not record an upload', a.key, err instanceof Error ? err.message : 'unknown');
  }
}

export async function storageUsage(env: Env, userId: string): Promise<{ usedBytes: number; count: number }> {
  const r = await env.DB
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS n FROM media_assets WHERE user_id = ?1')
    .bind(userId)
    .first<{ bytes: number; n: number }>();
  return { usedBytes: r?.bytes ?? 0, count: r?.n ?? 0 };
}

/** The plan's storage allowance in bytes, or null when it is unlimited or the plan limits are not being enforced yet. */
export async function storageLimit(env: Env, userId: string): Promise<{ bytes: number | null; label: string; mb: number | null }> {
  const spec = specOf((await loadSubscription(env, userId)).plan);
  const on = (await getSettings(env)).enforce_limits;
  return typeof spec.storageMb === 'number' && on
    ? { bytes: spec.storageMb * MB, label: spec.label, mb: spec.storageMb }
    : { bytes: null, label: spec.label, mb: null };
}

/** 402 when the file does not fit in what the plan includes. Applies only while "enforce_limits" is on, like the channel limit. */
export async function checkStorageQuota(env: Env, userId: string, addBytes: number): Promise<Response | null> {
  const limit = await storageLimit(env, userId);
  if (limit.bytes === null) return null;
  let used: number;
  try {
    used = (await storageUsage(env, userId)).usedBytes;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  return used + addBytes > limit.bytes
    ? fail(402, `Your ${limit.label} plan includes ${limit.mb} MB of library storage and this file does not fit. Delete files you no longer need in the Library, or upgrade.`)
    : null;
}

const KEY_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|mp4|mov))(?:[?#].*)?$/;

/** R2 keys of the files that posts waiting to be sent point at. The worker downloads them at send time, so they must stay. */
export async function referencedKeys(env: Env, userId: string): Promise<Set<string>> {
  const { results } = await env.DB
    .prepare("SELECT media_keys FROM posts WHERE user_id = ?1 AND status IN ('scheduled', 'processing') AND media_keys != '[]'")
    .bind(userId)
    .all<{ media_keys: string }>();
  const keys = new Set<string>();
  for (const row of results) {
    let list: unknown;
    try { list = JSON.parse(row.media_keys); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const m = typeof entry === 'string' ? KEY_AT_END.exec(entry) : null;
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

const CURSOR = /^(\d+)_(\d+)$/;               // '<created_at>_<rowid>' of the last file on the previous page

export async function listAssets(
  env: Env,
  userId: string,
  o: { kind?: 'image' | 'video'; q?: string; cursor?: string | null; origin: string },
): Promise<{ assets: LibraryAsset[]; nextCursor: string | null }> {
  const where = ['user_id = ?1'];
  const args: unknown[] = [userId];
  if (o.kind) { args.push(o.kind); where.push(`kind = ?${args.length}`); }
  const q = (o.q ?? '').trim().slice(0, 60);
  if (q) { args.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); where.push(`name LIKE ?${args.length} ESCAPE '\\'`); }
  const c = o.cursor ? CURSOR.exec(o.cursor) : null;
  if (c) { args.push(Number(c[1]), Number(c[2])); where.push(`(created_at < ?${args.length - 1} OR (created_at = ?${args.length - 1} AND rowid < ?${args.length}))`); }

  const { results } = await env.DB
    .prepare(`SELECT rowid AS seq, id, r2_key, kind, content_type, size_bytes, width, height, name, created_at, thumb_key FROM media_assets WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ${PAGE_SIZE + 1}`)
    .bind(...args)
    .all<AssetRow>();

  const more = results.length > PAGE_SIZE;
  const page = more ? results.slice(0, PAGE_SIZE) : results;
  const inUse = page.length ? await referencedKeys(env, userId) : new Set<string>();
  const assets = page.map((r): LibraryAsset => ({
    id: r.id, key: r.r2_key, url: `${o.origin}/api/media/${r.r2_key}`, kind: r.kind, name: r.name, size: r.size_bytes,
    width: r.width, height: r.height, contentType: r.content_type, createdAt: r.created_at, inUse: inUse.has(r.r2_key),
  }));
  const last = page[page.length - 1];
  return { assets, nextCursor: more && last ? `${last.created_at}_${last.seq}` : null };
}

export async function getAsset(env: Env, userId: string, id: string): Promise<AssetRow | null> {
  return env.DB
    .prepare('SELECT rowid AS seq, id, r2_key, kind, content_type, size_bytes, width, height, name, created_at, thumb_key FROM media_assets WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<AssetRow>();
}

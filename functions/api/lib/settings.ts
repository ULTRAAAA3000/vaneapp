/** Admin-editable switches. Stored in D1 (`settings`), cached per isolate for a few seconds. */
import type { Env } from '../../../types';

export interface Settings {
  block_hosting: boolean;       // refuse sign-in / sign-up from the hosting + VPN networks on the blocklist (preset rows)
  block_tor: boolean;           // refuse Tor exit nodes (Cloudflare reports them as country "T1")
  block_vpn_api: boolean;       // ask the VPN/proxy lookup API about every address (needs PROXYCHECK_KEY)
  auto_ban: boolean;            // ban addresses that brute-force or mass-register
  auto_ban_login_fails: number; // failed sign-ins from one address within 15 min
  auto_ban_registers: number;   // sign-up attempts from one address within 1 h
  auto_ban_hours: number;       // how long an automatic ban lasts
  registration_open: boolean;   // kill switch for new sign-ups
  track_visits: boolean;        // record page views for the Traffic tab
  enforce_limits: boolean;      // apply the plan limits (channels / posts) to users
}

export const DEFAULT_SETTINGS: Settings = {
  block_hosting: true,
  block_tor: true,
  block_vpn_api: true,
  auto_ban: true,
  auto_ban_login_fails: 15,
  auto_ban_registers: 6,
  auto_ban_hours: 24,
  registration_open: true,
  track_visits: true,
  enforce_limits: false,
};

const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  auto_ban_login_fails: [3, 1000],
  auto_ban_registers: [2, 1000],
  auto_ban_hours: [1, 24 * 365],
};

const TTL_MS = 15_000;
let cache: { at: number; value: Settings } | null = null;

export async function getSettings(env: Env): Promise<Settings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const out: Settings = { ...DEFAULT_SETTINGS };
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
    for (const r of results) {
      if (!(r.key in DEFAULT_SETTINGS)) continue;
      const k = r.key as keyof Settings;
      try {
        const v: unknown = JSON.parse(r.value);
        if (typeof v === typeof DEFAULT_SETTINGS[k]) (out as unknown as Record<string, unknown>)[k] = v;
      } catch {
        /* ignore a corrupt row: the default stays */
      }
    }
  } catch {
    /* settings table missing (schema not applied yet): defaults */
  }
  cache = { at: Date.now(), value: out };
  return out;
}

/** Validates and stores a partial update. Returns an error string or null. */
export async function saveSettings(env: Env, patch: Record<string, unknown>): Promise<string | null> {
  const stmts: D1PreparedStatement[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) return `Unknown setting: ${k}`;
    const key = k as keyof Settings;
    if (typeof v !== typeof DEFAULT_SETTINGS[key]) return `Setting ${k} must be a ${typeof DEFAULT_SETTINGS[key]}`;
    const range = RANGES[key];
    if (range && (typeof v !== 'number' || !Number.isInteger(v) || v < range[0] || v > range[1])) {
      return `Setting ${k} must be a whole number between ${range[0]} and ${range[1]}`;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(k, JSON.stringify(v)),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  cache = null;
  return null;
}

export const invalidateSettings = (): void => {
  cache = null;
};

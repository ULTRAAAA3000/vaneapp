const { createHash } = require('node:crypto');

const BASE = process.env.VANE_API_BASE || 'https://vaneapp.dev/api/v1';

/** Adds the key to every request. */
const addKey = (request, z, bundle) => {
  request.headers = request.headers || {};
  request.headers.Authorization = `Bearer ${bundle.authData.api_key}`;
  request.headers.Accept = 'application/json';
  return request;
};

/** Turns an API error into a Zapier error whose text is the one Vane sent: "[402] message (quota_exceeded)". */
const handleErrors = (response, z) => {
  if (response.status === 401) {
    throw new z.errors.RefreshAuthError('Vane rejected the API key. Create a new key in the Vane dashboard and reconnect.');
  }
  if (response.status >= 400) {
    const body = response.data && typeof response.data === 'object' ? response.data : {};
    const code = body.code ? ` (${body.code})` : '';
    throw new z.errors.Error(`[${response.status}] ${body.error || 'Vane returned an error'}${code}`, body.code || 'vane_error', response.status);
  }
  return response;
};

const tzOffset = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

const localToUtc = (y, mo, d, h, mi, tz) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffset(guess, tz);
  return first + (tzOffset(guess, tz) - tzOffset(first, tz));
};

const validZone = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

/** Reads ISO (with or without zone), "YYYY-MM-DD HH:mm", "DD.MM.YYYY HH:mm" and unix seconds. Times without a zone are read in `tz`. */
const parseTime = (value, tz = 'UTC') => {
  const v = String(value).trim();
  if (/^\d{10}$/.test(v)) return new Date(Number(v) * 1000);
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let m = v.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T\s]+(\d\d?):(\d\d)(?::\d\d(?:\.\d+)?)?)?$/);
  let parts = m && [m[1], m[2], m[3], m[4] || 0, m[5] || 0];
  if (!parts) {
    m = v.match(/^(\d\d?)[./](\d\d?)[./](\d{4})(?:[,\s]+(\d\d?):(\d\d))?$/);
    parts = m && [m[3], m[2], m[1], m[4] || 0, m[5] || 0];
  }
  if (!parts) return null;
  const [y, mo, d, h, mi] = parts.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return new Date(localToUtc(y, mo, d, h, mi, tz));
};

const HOUR = 3_600_000;

/** Turns the "When to publish" choice into an ISO time. Throws a readable error instead of guessing. */
const resolveTime = (d, now = Date.now()) => {
  const tz = d.timezone || 'UTC';
  if (!validZone(tz)) throw new Error(`Unknown time zone "${tz}". Use a name like Europe/Kyiv or UTC.`);
  const when = d.when || (d.scheduledAt ? 'custom' : 'now');
  if (when === 'now') return new Date(now + 60_000).toISOString();
  if (when === 'in_1h') return new Date(now + HOUR).toISOString();
  if (when === 'in_3h') return new Date(now + 3 * HOUR).toISOString();
  if (when === 'tomorrow_9') {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    const next = new Date(Date.UTC(p.year, p.month - 1, Number(p.day) + 1));
    return new Date(localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 9, 0, tz)).toISOString();
  }
  if (!d.scheduledAt) throw new Error('Choose "Custom date and time" and fill in "Custom date and time", or pick another option in "When to publish".');
  const t = parseTime(d.scheduledAt, tz);
  if (!t) throw new Error(`Could not read the time "${d.scheduledAt}". Use a format like 2026-11-05 17:30 or 05.11.2026 17:30.`);
  return t.toISOString();
};

const idempotencyKey = (obj) => `zap-${createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40)}`;

module.exports = { BASE, addKey, handleErrors, parseTime, resolveTime, idempotencyKey };

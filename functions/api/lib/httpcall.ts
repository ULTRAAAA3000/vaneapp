/**
 * One careful way to call another network's JSON API (used by LinkedIn and Threads; Mastodon and Bluesky have their own).
 * No redirects are followed, every call has a timeout, and an answer is read with a size cap, so a slow or hostile
 * server cannot hang a request or make us buffer a huge body. The answer's headers are returned too (LinkedIn puts the new
 * post's id in one).
 */
const MAX_BODY_BYTES = 64 * 1024;

export type CallOk<T> = { ok: true; status: number; data: T; headers: Headers };
export type CallErr = { ok: false; status: number; data: unknown; headers: Headers | null; retryAfter?: number; network?: boolean };

async function readCapped(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    if (!size) return null;
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    return null;
  }
}

function waitFrom(res: Response): number | undefined {
  const ra = Number(res.headers.get('retry-after'));
  return Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined;
}

export interface CallInit {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
}

export async function callJson<T = unknown>(url: string, init: CallInit = {}): Promise<CallOk<T> | CallErr> {
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
  let body: BodyInit | undefined = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });   // Workers have no redirect: 'error'
  } catch {
    return { ok: false, status: 0, data: null, headers: null, network: true };
  }
  if (res.status >= 300 && res.status < 400) {   // never followed: reported as a failed call with the 3xx status
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: res.status, data: null, headers: res.headers };
  }
  const data = await readCapped(res);
  if (res.ok) return { ok: true, status: res.status, data: data as T, headers: res.headers };
  return { ok: false, status: res.status, data, headers: res.headers, retryAfter: waitFrom(res) };
}

/** A short, safe piece of an error message from another network (never more than 200 characters, control characters removed). */
export function shortMessage(data: unknown, fallback: string): string {
  const d = data as { message?: unknown; error?: unknown; error_description?: unknown } | null;
  const nested = (d?.error as { message?: unknown } | undefined)?.message;
  const raw = [nested, d?.message, d?.error_description, d?.error].find((v) => typeof v === 'string' && v);
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : fallback;
}

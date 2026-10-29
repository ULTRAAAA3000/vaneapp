import type { Env } from '../../../types';

const enc = new TextEncoder();
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function mac(env: Env, email: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(`unsubscribe:${env.JWT_SECRET ?? ''}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(email.toLowerCase()))));
}

const origin = (env: Env): string => (env.APP_URL ?? 'https://vaneapp.dev').replace(/\/+$/, '');

export async function unsubscribeLinks(env: Env, email: string): Promise<{ page: string; api: string }> {
  const q = `e=${encodeURIComponent(email.toLowerCase())}&t=${await mac(env, email)}`;
  return { page: `${origin(env)}/unsubscribe?${q}`, api: `${origin(env)}/api/unsubscribe?${q}` };
}

export async function validUnsubscribe(env: Env, email: string, token: string): Promise<boolean> {
  if (!env.JWT_SECRET || !email || !token) return false;
  const want = await mac(env, email);
  if (want.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export async function isOptedOut(env: Env, email: string): Promise<boolean> {
  try {
    return !!(await env.DB.prepare('SELECT 1 AS x FROM email_optouts WHERE email = ?1').bind(email.toLowerCase()).first());
  } catch {
    return false;
  }
}

export async function setOptOut(env: Env, email: string, out: boolean): Promise<void> {
  const e = email.toLowerCase();
  if (out) await env.DB.prepare('INSERT OR IGNORE INTO email_optouts (email) VALUES (?1)').bind(e).run();
  else await env.DB.prepare('DELETE FROM email_optouts WHERE email = ?1').bind(e).run();
}

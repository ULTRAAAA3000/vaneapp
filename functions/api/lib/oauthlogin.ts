/**
 * Sign in with GitHub / Google.
 *
 *   oauthProviders(env)                        which buttons are on (both client id and secret set)
 *   authorizeUrl(p, env, redirectUri, state, challenge)   where the person presses "Allow"
 *   fetchIdentity(p, env, redirectUri, code, verifier)    code → { subject, email, name }, email always verified by the provider
 *   signInWith(env, request, identity)         finds or creates the account, returns the session cookie
 *
 * Security notes
 *  - Only the smallest scopes: GitHub `read:user user:email`, Google `openid email profile`. Nothing is stored except the provider's id for the person.
 *  - An account is matched by the provider's stable id first; then by email, but only an email the provider says is verified,
 *    so nobody can take over an account by registering its address elsewhere.
 *  - The state (and Google's PKCE verifier) live in an HttpOnly cookie and are compared on return: a sign-in someone else started cannot be finished here.
 *  - New accounts follow the "sign-ups are open" switch; disabled accounts stay locked out.
 * This file is NOT a route.
 */
import type { Env } from '../../../types';
import { markSeen } from './activity';
import { logAttempt } from './attempts';
import { emailConfigured } from './mail';
import { callJson } from './httpcall';
import { createSession, SESSION_TTL_SECONDS, sessionCookie } from './session';
import { getSettings } from './settings';

export type Provider = 'github' | 'google';
export const PROVIDERS: Provider[] = ['github', 'google'];
export const isProvider = (v: unknown): v is Provider => v === 'github' || v === 'google';

export interface Identity { subject: string; email: string; name: string | null }

const creds = (p: Provider, env: Env): { id: string; secret: string } | null => {
  const id = p === 'github' ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID;
  const secret = p === 'github' ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
};

export const oauthProviders = (env: Env): Record<Provider, boolean> => ({ github: Boolean(creds('github', env)), google: Boolean(creds('google', env)) });

export function authorizeUrl(p: Provider, env: Env, redirectUri: string, state: string, challenge: string): string {
  const c = creds(p, env)!;
  if (p === 'github') {
    return 'https://github.com/login/oauth/authorize?' + new URLSearchParams({ client_id: c.id, redirect_uri: redirectUri, scope: 'read:user user:email', state, allow_signup: 'true' });
  }
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: c.id, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state,
    code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

export async function fetchIdentity(p: Provider, env: Env, redirectUri: string, code: string, verifier: string): Promise<Identity | null> {
  const c = creds(p, env);
  if (!c) return null;
  if (p === 'github') {
    const t = await callJson<{ access_token?: string }>('https://github.com/login/oauth/access_token', {
      method: 'POST', form: { client_id: c.id, client_secret: c.secret, code, redirect_uri: redirectUri },
    });
    const token = t.ok ? t.data?.access_token : null;
    if (!token) return null;
    const h = { Authorization: `Bearer ${token}`, 'User-Agent': 'vaneapp', 'X-GitHub-Api-Version': '2022-11-28' };
    const [u, e] = await Promise.all([
      callJson<{ id?: number; login?: string; name?: string }>('https://api.github.com/user', { headers: h }),
      callJson<{ email?: string; primary?: boolean; verified?: boolean }[]>('https://api.github.com/user/emails', { headers: h }),
    ]);
    if (!u.ok || !e.ok || typeof u.data?.id !== 'number' || !Array.isArray(e.data)) return null;
    const mail = e.data.find((x) => x.primary && x.verified) ?? e.data.find((x) => x.verified);
    const email = clean(mail?.email, 254).toLowerCase();
    if (!email) return null;
    return { subject: String(u.data.id), email, name: clean(u.data.name || u.data.login, 80) || null };
  }
  const t = await callJson<{ access_token?: string }>('https://oauth2.googleapis.com/token', {
    method: 'POST', form: { client_id: c.id, client_secret: c.secret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier },
  });
  const token = t.ok ? t.data?.access_token : null;
  if (!token) return null;
  const u = await callJson<{ sub?: string; email?: string; email_verified?: boolean; name?: string }>('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` } });
  if (!u.ok || !u.data?.sub || u.data.email_verified !== true) return null;
  const email = clean(u.data.email, 254).toLowerCase();
  if (!email) return null;
  return { subject: clean(u.data.sub, 64), email, name: clean(u.data.name, 80) || null };
}

export type SignIn = { ok: true; cookie: string } | { ok: false; code: 'closed' | 'disabled' | 'failed' };

export async function signInWith(env: Env, request: Request, p: Provider, id: Identity): Promise<SignIn> {
  let userId: string | null = null;
  const linked = await env.DB.prepare('SELECT user_id FROM oauth_identities WHERE provider = ?1 AND subject = ?2').bind(p, id.subject).first<{ user_id: string }>();
  let created = false;
  if (linked) userId = linked.user_id;
  else {
    const byMail = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(id.email).first<{ id: string }>();
    if (byMail) userId = byMail.id;
    else {
      if (!(await getSettings(env)).registration_open) return { ok: false, code: 'closed' };
      userId = crypto.randomUUID();
      try {
        await env.DB.prepare('INSERT INTO users (id, email, password_hash, name, timezone) VALUES (?1, ?2, NULL, ?3, \'UTC\')').bind(userId, id.email, id.name).run();
        created = true;
      } catch {
        return { ok: false, code: 'failed' };
      }
    }
    await env.DB.prepare('INSERT OR IGNORE INTO oauth_identities (provider, subject, user_id) VALUES (?1, ?2, ?3)').bind(p, id.subject, userId).run();
  }
  const flag = await env.DB.prepare('SELECT disabled FROM user_flags WHERE user_id = ?1').bind(userId).first<{ disabled: number }>();
  if (flag?.disabled === 1) {
    await logAttempt(env, request, { kind: 'login', ok: false, reason: 'account_disabled', email: id.email });
    return { ok: false, code: 'disabled' };
  }
  await logAttempt(env, request, { kind: created ? 'register' : 'login', ok: true, reason: p, email: id.email });
  const token = await createSession(env, request, userId);
  if (emailConfigured(env)) await markSeen(env, userId);
  return { ok: true, cookie: sessionCookie(request, token, SESSION_TTL_SECONDS) };
}

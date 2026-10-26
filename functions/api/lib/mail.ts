/**
 * Email through Resend: https://resend.com/docs/api-reference/emails/send-email
 *
 * Optional, like Turnstile: emailed codes are enforced only when BOTH of these are set, so a
 * half-configured deploy can't lock everybody out.
 *   RESEND_API_KEY  (secret)    API key from the Resend dashboard
 *   EMAIL_FROM      (variable)  sender on a domain verified in Resend, e.g.  Vane <noreply@vaneapp.dev>
 */
import type { Env, VerifyPurpose } from '../../../types';
import { isOptedOut, unsubscribeLinks } from './unsubscribe';

const RESEND_URL = 'https://api.resend.com/emails';

let warned = false;

/** Which settings the function can actually see. Booleans only: values are never exposed. */
export const emailStatus = (env: Env) => ({
  enabled: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
  apiKeySet: Boolean(env.RESEND_API_KEY),
  fromSet: Boolean(env.EMAIL_FROM),
});

export function emailConfigured(env: Env): boolean {
  const st = emailStatus(env);
  if (!st.enabled && (st.apiKeySet || st.fromSet) && !warned) {
    warned = true; // once per isolate, not once per request
    console.warn(`email codes are OFF: ${st.apiKeySet ? 'EMAIL_FROM' : 'RESEND_API_KEY'} is not visible to the function (it needs both; they belong to the Pages project, not the cron worker)`);
  }
  return st.enabled;
}

export interface Mail { to: string; subject: string; text: string; html: string; replyTo?: string; unsubscribe?: boolean; optional?: boolean }

/** true = Resend accepted the message. Never throws, and never logs the address or the code. */
export async function sendMail(env: Env, mail: Mail): Promise<boolean> {
  try {
    let { text, html } = mail;
    let headers: Record<string, string> | undefined;
    if (mail.unsubscribe !== false) {
      if (mail.optional && (await isOptedOut(env, mail.to))) return true;
      const link = await unsubscribeLinks(env, mail.to);
      text += `\n\n---\nUnsubscribe from Vane emails: ${link.page}`;
      const foot = `<p style="margin:24px 0 0;text-align:center;font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:12px;color:#71717a;"><a href="${link.page}" style="color:#71717a;text-decoration:underline;">Unsubscribe</a> from Vane emails</p>`;
      html = html.includes('</body>') ? html.replace('</body>', `${foot}</body>`) : html + foot;
      headers = { 'List-Unsubscribe': `<${link.api}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    }
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text, html, ...(headers ? { headers } : {}), ...(mail.replyTo ? { reply_to: mail.replyTo } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    const detail = ((await res.json().catch(() => null)) as { name?: string; message?: string } | null) ?? {};
    console.error('resend rejected the email', res.status, detail.name ?? '', (detail.message ?? '').slice(0, 200));
  } catch (err) {
    console.error('resend request failed', err instanceof Error ? err.message : 'unknown');
  }
  return false;
}

/**
 * The email that carries a 6-digit code. Plain text first, HTML with inline styles for mail clients.
 * `origin` (e.g. https://vaneapp.dev) is where the "Copy code" button points: a mail client runs no scripts, so a real
 * clipboard button is impossible inside the email; /copy (public/copy.html) copies the code with one tap instead.
 * The code travels in the URL fragment, which browsers never send to a server.
 */
export function codeMail(to: string, code: string, purpose: VerifyPurpose, minutes: number, origin: string): Mail {
  const signup = purpose === 'signup';
  const lead = signup ? 'Use this code to finish creating your Vane account.' : 'Use this code to sign in to Vane.';
  const why = signup
    ? "If you didn't try to create an account, you can ignore this email."
    : "You haven't used your account for a few days, so we double-check it's you. If you didn't try to sign in, ignore this email: nobody can get in without this code.";

  const text = `${lead}\n\n${code}\n\nThe code works for ${minutes} minutes.\n${why}\n\n— Vane`;
  const html =
    '<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#070708;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070708;padding:32px 16px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#111114;border:1px solid #26262c;border-radius:20px;"><tr>' +
    '<td style="padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">' +
    '<div style="font-size:20px;font-weight:600;letter-spacing:-0.01em;">vane</div>' +
    `<p style="margin:24px 0 0;font-size:15px;line-height:1.5;color:#d4d4d8;">${lead}</p>` +
    `<div style="margin:20px 0 16px;padding:18px 0 18px 10px;background:#070708;border:1px solid #26262c;border-radius:14px;text-align:center;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:#ffffff;-webkit-user-select:all;user-select:all;">${code}</div>` +
    `<div style="margin:0 0 20px;text-align:center;"><a href="${origin}/copy#${code}" style="display:inline-block;padding:11px 24px;background:#ffffff;border-radius:999px;font-size:14px;font-weight:600;line-height:1;color:#010101;text-decoration:none;">Copy code</a></div>` +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#a1a1aa;">The code works for ${minutes} minutes.</p>` +
    `<p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#71717a;">${why}</p>` +
    '</td></tr></table></td></tr></table></body></html>';

  return { to, subject: `${code} is your Vane code`, text, html };
}

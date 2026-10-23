/**
 * POST /api/contact  { name, email, topic, message, turnstileToken?, website? }   (the form on /about#contact, and every "Tell us" button leads there)
 *   → 200 { ok: true }
 *   → 502 { ok: false, error }  the message was kept but the email could not be sent: the page then shows the address to write to
 *
 * Goes to CONTACT_TO (default info.vaneapp@gmail.com) through Resend, with the sender's address as Reply-To, so answering is one click.
 * Protection: the human check when Turnstile is on, a hidden field bots fill, a limit per address and per sender, no user text in the
 * subject or headers, and everything shown in the email is escaped. The message is also stored in `contact_messages`.
 */
import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../../types';
import { crossOriginViolation, EMAIL_RE, fail, isRecord, json, methodNotAllowed, readJson } from './lib/http';
import { guard } from './lib/guard';
import { emailConfigured, sendMail } from './lib/mail';
import { bump, clientIp, retryAfter } from './lib/throttle';
import { requireHuman } from './lib/turnstile';

export const DEFAULT_CONTACT_TO = 'info.vaneapp@gmail.com';
const TOPICS: Record<string, string> = { question: 'Question', network: 'A network I need', partnership: 'Partnership', problem: 'A problem', other: 'Something else' };
const PER_IP_PER_HOUR = 5;
const PER_SENDER_PER_DAY = 5;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 3000;

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const xo = crossOriginViolation(request);
  if (xo) return xo;
  const blocked = await guard(env, request, 'api');
  if (blocked) return blocked;

  const ip = clientIp(request);
  const ipKey = `contact:ip:${ip}`;
  const wait = await retryAfter(env, ipKey, PER_IP_PER_HOUR);
  if (wait) return fail(429, 'Too many messages from your network. Please try again later.', { 'Retry-After': String(wait) });

  const parsed = await readJson(request, 8192);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isRecord(body)) return fail(400, 'Body must be a JSON object');

  await bump(env, ipKey, 3600);
  if (typeof body.website === 'string' && body.website.trim() !== '') return json({ ok: true });   // a bot filled the hidden field: pretend it worked, send nothing

  const human = await requireHuman(env, request, body.turnstileToken);
  if (human) return human;

  const name = clean(body.name, 80).replace(/[\r\n]+/g, ' ');
  const email = clean(body.email, 254).toLowerCase();
  const message = clean(body.message, MESSAGE_MAX + 1);
  const topic = typeof body.topic === 'string' && body.topic in TOPICS ? body.topic : 'other';
  if (!name) return fail(400, 'Please tell us your name.');
  if (!EMAIL_RE.test(email) || /[\s,;<>]/.test(email)) return fail(400, 'Enter a valid email address so we can answer.');
  if (message.length < MESSAGE_MIN) return fail(400, 'Please write a little more.');
  if (message.length > MESSAGE_MAX) return fail(400, `The message can be up to ${MESSAGE_MAX} characters.`);

  const senderKey = `contact:em:${email}`;
  const again = await retryAfter(env, senderKey, PER_SENDER_PER_DAY);
  if (again) return fail(429, 'You have already written to us several times today. We will answer soon.', { 'Retry-After': String(again) });
  await bump(env, senderKey, 86_400);

  let id: number | null = null;
  try {
    const r = await env.DB.prepare('INSERT INTO contact_messages (topic, name, email, message, ip) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id').bind(topic, name, email, message, ip === 'unknown' ? null : ip).first<{ id: number }>();
    id = r?.id ?? null;
  } catch (err) {
    console.error('contact: could not store the message', err instanceof Error ? err.message : 'unknown');   // the table may not exist yet: the email below still goes out
  }

  const to = env.CONTACT_TO || DEFAULT_CONTACT_TO;
  let sent = false;
  if (emailConfigured(env)) {
    const label = TOPICS[topic];
    sent = await sendMail(env, {
      to,
      replyTo: email,
      subject: `Vane contact: ${label}`,
      text: `${label}\nFrom: ${name} <${email}>\n\n${message}\n`,
      html: `<p><b>${esc(label)}</b></p><p>From: ${esc(name)} &lt;${esc(email)}&gt;</p><p style="white-space:pre-wrap">${esc(message)}</p>`,
    });
  }
  if (sent && id !== null) await env.DB.prepare('UPDATE contact_messages SET mailed = 1 WHERE id = ?1').bind(id).run().catch(() => undefined);
  if (!sent) return fail(502, `We could not send your message right now. Please write to ${to} directly.`);
  return json({ ok: true });
};

export const onRequest: PagesFunction<Env> = async () => methodNotAllowed('POST');

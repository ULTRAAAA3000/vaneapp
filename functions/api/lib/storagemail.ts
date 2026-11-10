/**
 * The three emails about a library that is over its plan (worker/src/storage.ts sends them, once per overage, from the hourly clean-up):
 *
 *   overMail      the hour the account goes over: how much, the deadline, what to do
 *   remindMail    the last 24 hours before the newest uploads are removed (the "deadline to clean up yourself")
 *   removedMail   after the clean-up: how many files were removed and why
 *
 * They are service messages about the person's own account, so they are sent even to someone who unsubscribed from product emails
 * (optional: false) and carry no unsubscribe footer (unsubscribe: false); the text says why they got it. Every value that goes into the
 * HTML is escaped; nothing here reads the database.
 */
import type { Mail } from './mail';

export const OVER_EVENT = 'storage.over.mail';        // logs.event: the first email of an overage was sent
export const REMIND_EVENT = 'storage.remind.mail';    // logs.event: the 24-hour reminder was sent
export const REMOVED_EVENT = 'storage.removed.mail';  // logs.event: the "we removed files" email was sent
export const REMIND_BEFORE_SECONDS = 24 * 3600;

export interface StorageMailContext {
  planLabel: string;      // "Free Trial", "Pro Dashboard" …
  usedBytes: number;
  limitBytes: number;
  deadline: number;       // unix seconds: when the newest uploads start to go
  origin: string;         // https://vaneapp.dev
  removed?: number;       // removedMail: how many files went
}

const MB = 1024 * 1024;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** 1 decimal for small sizes, none from 100 MB up: "9.4 MB", "103 MB". */
export const fmtMb = (bytes: number): string => {
  const mb = bytes / MB;
  return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
};
const when = (t: number): string => `${new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const hoursLeft = (deadline: number, now: number): number => Math.max(1, Math.round((deadline - now) / 3600));

const links = (c: StorageMailContext) => ({ library: `${c.origin}/app#library`, plans: `${c.origin}/pricing` });

function page(heading: string, paras: string[], cta: { href: string; label: string }[], note: string): string {
  const p = paras.map((t) => `<p style="margin:0 0 14px;line-height:1.55">${esc(t)}</p>`).join('');
  const b = cta.map((x, i) => `<a href="${esc(x.href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;${i === 0 ? 'background:#111;color:#fff' : 'background:#f1f1f3;color:#111'}">${esc(x.label)}</a>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111"><h2 style="margin:0 0 14px">${esc(heading)}</h2>${p}<div style="margin:18px 0 6px">${b}</div><p style="margin:22px 0 0;font-size:12px;color:#71717a;line-height:1.5">${esc(note)}</p></div>`;
}
const NOTE = 'You get this email because it is about the files in your own Vane account. It is sent even if you unsubscribed from product emails.';

function sizes(c: StorageMailContext): string {
  const over = Math.max(c.usedBytes - c.limitBytes, 0);
  return `Your library uses ${fmtMb(c.usedBytes)}, but your ${c.planLabel} plan includes ${fmtMb(c.limitBytes)} (${fmtMb(over)} over).`;
}
const RULE = 'If it is still over after that, Vane removes your newest uploads first until the rest fits. Files used by a post that is still scheduled stay until that post goes out.';

export function overMail(to: string, c: StorageMailContext): Mail {
  const l = links(c), dl = when(c.deadline);
  const lines = [sizes(c), `You have until ${dl} (3 days) to free up space: delete files you no longer need, or move to a plan with more room.`, RULE];
  return {
    to, optional: false, unsubscribe: false,
    subject: 'Your Vane library is over your plan',
    text: `${lines.join('\n\n')}\n\nOpen your library: ${l.library}\nSee plans: ${l.plans}\n\n${NOTE}\n`,
    html: page('Your library is over your plan', lines, [{ href: l.library, label: 'Open my library' }, { href: l.plans, label: 'See plans' }], NOTE),
  };
}

export function remindMail(to: string, c: StorageMailContext, now: number): Mail {
  const l = links(c), dl = when(c.deadline), h = hoursLeft(c.deadline, now);
  const lines = [`About ${plural(h, 'hour', 'hours')} left (until ${dl}). ${sizes(c)}`, `After that Vane removes your newest uploads until the library fits. Delete what you do not need now, or move to a plan with more room, and nothing is removed.`, 'Files used by a post that is still scheduled stay until that post goes out.'];
  return {
    to, optional: false, unsubscribe: false,
    subject: 'Last day: Vane will remove files from your library',
    text: `${lines.join('\n\n')}\n\nOpen your library: ${l.library}\nSee plans: ${l.plans}\n\n${NOTE}\n`,
    html: page('Last day to clean up your library', lines, [{ href: l.library, label: 'Open my library' }, { href: l.plans, label: 'See plans' }], NOTE),
  };
}

export function removedMail(to: string, c: StorageMailContext): Mail {
  const l = links(c), n = c.removed ?? 0;
  const lines = [`Your library stayed over your ${c.planLabel} plan (${fmtMb(c.limitBytes)}) after the 3 days, so Vane removed ${plural(n, 'file', 'files')}, newest first.`, 'Files used by a post that is still scheduled were kept. If your library is still slightly over, it clears once that post has been sent.', 'To keep more files, move to a plan with more room.'];
  return {
    to, optional: false, unsubscribe: false,
    subject: `Vane removed ${plural(n, 'file', 'files')} from your library`,
    text: `${lines.join('\n\n')}\n\nOpen your library: ${l.library}\nSee plans: ${l.plans}\n\n${NOTE}\n`,
    html: page(`${plural(n, 'file', 'files')} removed from your library`, lines, [{ href: l.plans, label: 'See plans' }, { href: l.library, label: 'Open my library' }], NOTE),
  };
}

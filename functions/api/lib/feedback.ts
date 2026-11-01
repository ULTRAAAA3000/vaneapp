/**
 * Feedback & Roadmap board: the rules for an idea, shared by the dashboard endpoint (functions/api/feedback.ts)
 * and the admin one (functions/api/admin/feedback.ts). Tables: feedback_items, feedback_votes (schema.sql).
 */
export const FEEDBACK_KINDS = ['network', 'feature', 'bug', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_STATUSES = ['open', 'planned', 'building', 'done', 'declined'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const TITLE_MIN = 3;
export const TITLE_MAX = 80;
export const BODY_MAX = 500;
/** New ideas one person can add in 24 hours, and how many of their ideas can be on the board at once. */
export const IDEAS_PER_DAY = 5;
export const IDEAS_ON_BOARD = 25;

/** Text from a person: control characters out, spaces collapsed, cut to `max`. Not a string gives an empty string. */
export function cleanText(v: unknown, max: number, keepLineBreaks = false): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  let s = v.replace(keepLineBreaks ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  s = keepLineBreaks ? s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max).trim();
}

/** The key two titles are compared by to spot a duplicate: lower case, letters and digits only. */
export const titleKey = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export type Suggestion = { ok: true; kind: FeedbackKind; title: string; body: string } | { ok: false; error: string };

export function validateSuggestion(b: Record<string, unknown>): Suggestion {
  const kind = typeof b.kind === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(b.kind) ? (b.kind as FeedbackKind) : 'feature';
  const title = cleanText(b.title, TITLE_MAX + 1);
  if (title.length < TITLE_MIN) return { ok: false, error: `Give the idea a short title (at least ${TITLE_MIN} characters).` };
  if (title.length > TITLE_MAX) return { ok: false, error: `Keep the title under ${TITLE_MAX} characters.` };
  if (typeof b.body === 'string' && b.body.length > BODY_MAX * 2) return { ok: false, error: `Keep the details under ${BODY_MAX} characters.` };
  const body = cleanText(b.body, BODY_MAX + 1, true);
  if (body.length > BODY_MAX) return { ok: false, error: `Keep the details under ${BODY_MAX} characters.` };
  if (/https?:\/\//i.test(title + ' ' + body)) return { ok: false, error: 'Links are not allowed here. Describe the idea in words.' };
  return { ok: true, kind, title, body };
}

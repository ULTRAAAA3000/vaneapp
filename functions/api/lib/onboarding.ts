/**
 * The onboarding checklist: the card at the top of the dashboard that walks a new person to their first post.
 * What counts as done is read from the account itself, never stored, so it cannot drift:
 *
 *   channel      at least one channel is connected
 *   key          an API key was created (a revoked one still counts: the step was done)
 *   post         a post was actually SENT (from the editor or through Claude / Notion / the API; scheduled is not enough)
 *   integration  a key was made for an integration (Claude, Notion, Obsidian, Make, Zapier, ChatGPT, WordPress)
 *
 * The table `onboarding_progress` only remembers the card: closed with the cross, or the confetti already shown.
 * An account that is already complete the first time the card is looked at is marked as celebrated at once: old news gets no confetti.
 */
import type { Env } from '../../../types';
import { isMissingSchema } from './integrations';

export type StepId = 'channel' | 'key' | 'post' | 'integration';
export const STEP_IDS: readonly StepId[] = ['channel', 'key', 'post', 'integration'];

export interface OnboardingState {
  steps: { id: StepId; done: boolean }[];
  done: number;
  total: number;
  /** The card is not shown (closed, or already celebrated). */
  hidden: boolean;
  /** All steps are done and the confetti has not been shown yet: show it, then POST action "celebrated". */
  celebrate: boolean;
}

const HIDDEN: OnboardingState = { steps: STEP_IDS.map((id) => ({ id, done: false })), done: 0, total: STEP_IDS.length, hidden: true, celebrate: false };

export async function loadOnboarding(env: Env, userId: string, now = Math.floor(Date.now() / 1000)): Promise<OnboardingState> {
  try {
    const r = await env.DB
      .prepare(`SELECT
          EXISTS(SELECT 1 FROM channels WHERE user_id = ?1) AS channel,
          EXISTS(SELECT 1 FROM api_keys WHERE user_id = ?1) AS key,
          EXISTS(SELECT 1 FROM posts WHERE user_id = ?1 AND status = 'sent') AS post,
          EXISTS(SELECT 1 FROM api_keys WHERE user_id = ?1 AND integration IS NOT NULL AND integration <> 'api') AS integration`)
      .bind(userId)
      .first<Record<StepId, number>>();
    const steps = STEP_IDS.map((id) => ({ id, done: !!r?.[id] }));
    const done = steps.filter((s) => s.done).length;
    const complete = done === steps.length;

    let row = await env.DB
      .prepare('SELECT dismissed_at, celebrated_at FROM onboarding_progress WHERE user_id = ?1')
      .bind(userId)
      .first<{ dismissed_at: number | null; celebrated_at: number | null }>();
    if (!row) {
      const celebrated = complete ? now : null;                       // already complete on first sight: nothing to celebrate
      await env.DB
        .prepare('INSERT OR IGNORE INTO onboarding_progress (user_id, created_at, celebrated_at) VALUES (?1, ?2, ?3)')
        .bind(userId, now, celebrated)
        .run();
      row = { dismissed_at: null, celebrated_at: celebrated };
    }
    const hidden = row.dismissed_at !== null || row.celebrated_at !== null;
    return { steps, done, total: steps.length, hidden, celebrate: complete && row.dismissed_at === null && row.celebrated_at === null };
  } catch (err) {
    if (!isMissingSchema(err)) console.error('onboarding failed', err instanceof Error ? err.message : 'unknown');
    return HIDDEN;                                                    // the card is an extra: never break the dashboard for it
  }
}

/** "dismiss" closes the card for good; "celebrated" is only accepted when every step really is done. Returns false when it was refused. */
export async function markOnboarding(env: Env, userId: string, action: 'dismiss' | 'celebrated', now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (action === 'celebrated') {
    const s = await loadOnboarding(env, userId, now);
    if (s.done !== s.total) return false;
  }
  await env.DB
    .prepare(`INSERT INTO onboarding_progress (user_id, created_at, dismissed_at, celebrated_at) VALUES (?1, ?2, ?3, ?4)
              ON CONFLICT(user_id) DO UPDATE SET dismissed_at = COALESCE(dismissed_at, excluded.dismissed_at), celebrated_at = COALESCE(celebrated_at, excluded.celebrated_at)`)
    .bind(userId, now, action === 'dismiss' ? now : null, action === 'celebrated' ? now : null)
    .run();
  return true;
}

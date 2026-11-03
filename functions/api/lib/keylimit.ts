/**
 * How many active API keys an account may have. Kept apart from paid.ts because the cron worker imports that one, and it has no use
 * for the API-key code.
 */
import type { Env } from '../../../types';
import { MAX_KEYS_PER_USER } from './apikeys';
import { loadSubscription } from './usage';

/** The Free Trial has room for a few assistants (say Claude, Notion and one script); a paid plan for a key per agent environment. */
export const FREE_MAX_KEYS = 3;

/** How many active keys this account may have (a key already made is never taken away: this only decides whether a new one can be made). */
export async function maxKeysFor(env: Pick<Env, 'DB'>, userId: string): Promise<number> {
  // Any paid plan, the Developer API plan included (keys are what it is for): only the Free Trial is held to FREE_MAX_KEYS.
  const sub = await loadSubscription(env as Env, userId).catch(() => null);
  return sub && sub.plan !== 'free' ? MAX_KEYS_PER_USER : FREE_MAX_KEYS;
}

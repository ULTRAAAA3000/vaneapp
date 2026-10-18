/**
 * vane-cron — a standalone Worker (Pages Functions can't run on a schedule).
 * Cloudflare calls `scheduled()` every minute (see wrangler.toml → [triggers]).
 */
import type { CronEnv } from '../../types';
import { purgeExpiredIdempotencyKeys } from '../../functions/api/lib/idempotency';
import { runDuePosts } from './dispatch';

export default {
  async scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDuePosts(env)
        .catch((err) => {
          // Don't rethrow: the next minute simply tries again.
          console.error('vane-cron: run failed:', err instanceof Error ? err.message : 'unknown');
        })
        // Housekeeping: Idempotency-Keys are remembered for 24 hours (a no-op when none has expired, and when the table is not there yet).
        .then(() => purgeExpiredIdempotencyKeys(env, Math.floor(Date.now() / 1000)))
        .catch(() => undefined),
    );
  },

  // The Worker has no public surface (workers_dev is off); this only answers if someone routes to it.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<CronEnv>;

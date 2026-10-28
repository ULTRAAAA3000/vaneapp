/**
 * vane-cron — a standalone Worker (Pages Functions can't run on a schedule).
 * Cloudflare calls `scheduled()` every minute (see wrangler.toml → [triggers]).
 */
import type { CronEnv } from '../../types';
import { purgeExpiredIdempotencyKeys } from '../../functions/api/lib/idempotency';
import { purgeOldApiUsage } from '../../functions/api/lib/integrations';
import { runDueVideoPublications } from '../../functions/api/lib/videopublish';
import { deliverDueWebhooks, purgeOldWebhookDeliveries } from '../../functions/api/lib/webhooks';
import { sweepOrders } from '../../functions/api/lib/billingcheck';
import { runBotAlerts } from '../../functions/api/lib/analyticsbot';
import { sendWeeklyReports } from '../../functions/api/lib/analyticsreport';
import { collectFollowers, collectPostMetrics, purgeOldMetrics } from '../../functions/api/lib/metrics';
import { runDuePosts } from './dispatch';
import { isRenewalMinute, renewExpiringTokens } from './tokens';

export default {
  async scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDuePosts(env)
        .catch((err) => {
          // Don't rethrow: the next minute simply tries again.
          console.error('vane-cron: run failed:', err instanceof Error ? err.message : 'unknown');
        })
        // Vane Studio: publish queued videos to their channels, retry the ones whose pause is over (never blocks or breaks posting).
        .then(() => runDueVideoPublications(env, Math.floor(Date.now() / 1000)))
        .catch((err) => console.error('vane-cron: video publishing failed:', err instanceof Error ? err.message : 'unknown'))
        // Housekeeping: Idempotency-Keys are remembered for 24 hours (a no-op when none has expired, and when the table is not there yet).
        .then(() => purgeExpiredIdempotencyKeys(env, Math.floor(Date.now() / 1000)))
        .catch(() => undefined)
        // Webhooks: send what the posts above just queued (and retries that are due), then tidy up. Never blocks or breaks posting.
        .then(() => deliverDueWebhooks(env, Math.floor(Date.now() / 1000)))
        .then(() => purgeOldWebhookDeliveries(env, Math.floor(Date.now() / 1000)))
        // API usage counters (the admin's Integrations page) are kept for 120 days.
        .then(() => purgeOldApiUsage(env))
        .catch((err) => console.error('vane-cron: webhooks failed:', err instanceof Error ? err.message : 'unknown'))
        // Payments: expire unpaid orders and find crypto payments whose buyer left the checkout page.
        .then(() => sweepOrders(env as never, Math.floor(Date.now() / 1000)))
        .catch((err) => console.error('vane-cron: payments failed:', err instanceof Error ? err.message : 'unknown'))
        // Analytics: every 5th minute read the results of recently published posts and today's follower counts; once a day tidy up.
        .then(async () => {
          const t = Math.floor(Date.now() / 1000);
          if (Math.floor(t / 60) % 5 === 0) {
            await collectPostMetrics(env, t);
            await collectFollowers(env, t);
            await sendWeeklyReports(env, t);
            await runBotAlerts(env, t);
          }
          if (isRenewalMinute(t)) await purgeOldMetrics(env, t);
        })
        .catch((err) => console.error('vane-cron: analytics failed:', err instanceof Error ? err.message : 'unknown'))
        // Once a day: renew LinkedIn / Threads sign-ins that are running out (see tokens.ts).
        .then(() => (isRenewalMinute(Math.floor(Date.now() / 1000)) ? renewExpiringTokens(env, Math.floor(Date.now() / 1000)) : undefined))
        .catch((err) => console.error('vane-cron: sign-in renewal failed:', err instanceof Error ? err.message : 'unknown')),
    );
  },

  // The Worker has no public surface (workers_dev is off); this only answers if someone routes to it.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<CronEnv>;

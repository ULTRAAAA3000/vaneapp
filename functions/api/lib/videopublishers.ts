/**
 * Publishers: the part of Vane Studio that talks to ONE video network (YouTube, TikTok, Instagram Reels).
 * Everything around it (the queue, retries with a growing pause, history, the dashboard) is network-agnostic and lives in
 * ./videopublish.ts. A publisher only has to answer one question: "here is a video and a channel, put it there": and say
 * whether a failure is worth retrying.
 *
 * TO PLUG IN A NETWORK once it has approved Vane:
 *   1. write its publisher: an object with `publish(env, job)` (read the file from `env.MEDIA` by `job.video.r2Key`, use the
 *      channel's own credentials, call the network), and add it to REAL below under the network's id;
 *   2. open the connect flow (see functions/api/lib/videochannels.ts).
 * Until a network has a publisher here, a job for it fails at once with "not available yet" (and is not retried).
 *
 * LOCAL DEV AND TESTS: when VIDEO_PUBLISH_MOCK=1 (in .dev.vars; never in production) a channel whose credentials are JSON
 * like {"mock":"ok"} behaves as a fake network:
 *   {"mock":"ok"}                          succeeds (after reading the first bytes of the file from R2, proving media access)
 *   {"mock":"flaky","failures":2}          fails with a retryable error 2 times, then succeeds
 *   {"mock":"fail","retryable":false,"error":"Quota exceeded"}   always fails (retryable or not)
 */
import type { CronEnv, VideoPrivacy } from '../../../types';
import type { VideoPlatform } from './videochannels';

/** What a publisher needs; both the Pages env and the cron worker's env satisfy it. */
export type PublishEnv = Pick<CronEnv, 'DB' | 'MEDIA' | 'ENCRYPTION_KEY' | 'VIDEO_PUBLISH_MOCK'>;

export interface PublishJob {
  publicationId: string;
  /** 1 for the first try, 2 for the first retry, … */
  attempt: number;
  /** what the user chose for THIS publication (it may differ from the library entry) */
  title: string;
  description: string;
  privacy: VideoPrivacy;
  video: { id: string; tags: string[]; r2Key: string; sizeBytes: number; contentType: string };
  /** `credentials` is exactly what is stored (encrypted for real networks): the publisher decrypts it itself */
  channel: { id: string; platform: VideoPlatform; name: string; credentials: string };
}

export type PublishOutcome =
  | { ok: true; externalId: string; url: string | null }
  /** retryable: a temporary trouble (network, rate limit, 5xx) worth trying again; otherwise the user has to act */
  | { ok: false; retryable: boolean; error: string };

export interface VideoPublisher {
  publish(env: PublishEnv, job: PublishJob): Promise<PublishOutcome>;
}

/** The real networks. Empty until each one is approved: see the note at the top of this file. */
const REAL: Partial<Record<VideoPlatform, VideoPublisher>> = {};

// ───────────────────────── the fake network (dev and tests only) ─────────────────────────

interface MockSpec { mock: string; failures?: number; retryable?: boolean; error?: string }

function parseMock(credentials: string): MockSpec | null {
  try {
    const v: unknown = JSON.parse(credentials);
    return typeof v === 'object' && v !== null && typeof (v as MockSpec).mock === 'string' ? (v as MockSpec) : null;
  } catch {
    return null;
  }
}

const MOCK: VideoPublisher = {
  async publish(env, job) {
    const spec = parseMock(job.channel.credentials);
    if (!spec) return { ok: false, retryable: false, error: 'Bad mock credentials.' };
    if (spec.mock === 'fail') return { ok: false, retryable: spec.retryable === true, error: spec.error ?? 'Mock failure.' };
    if (spec.mock === 'flaky' && job.attempt <= (spec.failures ?? 1)) return { ok: false, retryable: true, error: `Mock temporary failure (attempt ${job.attempt}).` };
    if (spec.mock !== 'ok' && spec.mock !== 'flaky') return { ok: false, retryable: false, error: `Unknown mock behaviour "${spec.mock}".` };

    // A real publisher streams the file from R2; the fake one at least proves it can open it and that it is a video.
    const head = env.MEDIA ? await env.MEDIA.get(job.video.r2Key, { range: { offset: 0, length: 12 } }) : null;
    if (!head) return { ok: false, retryable: false, error: 'The video file could not be read from storage.' };
    const bytes = new Uint8Array(await head.arrayBuffer());
    if (String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return { ok: false, retryable: false, error: 'The stored file is not an MP4/MOV.' };

    const q = new URLSearchParams({ privacy: job.privacy, title: job.title, size: String(job.video.sizeBytes) });
    return { ok: true, externalId: `mock-${job.publicationId.slice(0, 8)}`, url: `https://example.test/${job.channel.platform}/${job.publicationId}?${q.toString()}` };
  },
};

/** The publisher for a channel, or null when its network has none yet. */
export function publisherFor(env: PublishEnv, platform: VideoPlatform, credentials: string): VideoPublisher | null {
  if (env.VIDEO_PUBLISH_MOCK === '1' && parseMock(credentials)) return MOCK;
  return REAL[platform] ?? null;
}

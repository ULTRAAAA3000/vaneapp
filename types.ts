/**
 * Vane — shared types: Cloudflare bindings (Env) + D1 row shapes.
 * Requires: npm i -D @cloudflare/workers-types
 */
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

// ───────────────────────── Environment ─────────────────────────
export interface Env {
  /** D1 database (binding name must match wrangler.toml) */
  DB: D1Database;
  /** Pages' static-files binding: always there on Cloudflare Pages (functions/_middleware.ts serves a page from it under another path) */
  ASSETS: Fetcher;
  /** R2 bucket for post media and the Vane Studio video library */
  MEDIA?: R2Bucket;             // optional: uploads are enabled only when the R2 bucket is bound
  /** Local dev and tests only: lets a channel whose credentials say {"mock": …} act as a fake network (see functions/api/lib/videopublishers.ts). Never set in production. */
  VIDEO_PUBLISH_MOCK?: string;
  /** Local dev and tests only: Vane Studio AI answers with canned text instead of calling Workers AI (see functions/api/lib/videoai.ts). Never set in production. */
  VIDEO_AI_MOCK?: string;
  /** Cloudflare Workers AI (wrangler.toml [ai]): the AI tools in the editor are off without it */
  /** optional: the Workers AI model id to use instead of the built-in one */
  AI_MODEL?: string;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** optional: with it, pictures are checked for adult and violent content by OpenAI's free moderation endpoint (without it Workers AI is used). See documentation/MODERATION.md */
  OPENAI_API_KEY?: string;
  /** '1' switches every content check off (local development and tests only) */
  MODERATION_OFF?: string;

  /** Secrets (wrangler secret put / Pages → Settings → Variables) */
  ENCRYPTION_KEY?: string;      // for encrypting channels.credentials (>= 32 random chars)
  JWT_SECRET?: string;          // signs/verifies API bearer tokens (>= 32 chars)
  STRIPE_SECRET_KEY?: string;
  MONOBANK_TOKEN?: string;          // Monobank Acquiring merchant token (secret): card / Apple Pay / Google Pay checkout is off without it
  CRYPTO_WALLET?: string;           // plain var: the Solana address that receives USDT / USDC (crypto checkout is off without it)
  SOLANA_RPC_URL?: string;          // optional: a Solana RPC address (Helius, QuickNode); the public one is used when empty
  SYSTEM_BOT_TOKEN?: string;        // token of the shared Vane bot used by Quick Connect
  ANALYTICS_BOT_TOKEN?: string;     // token of the Vane Analytics bot (BotFather); without it the bot tab says "coming soon"
  ANALYTICS_BOT_SECRET?: string;    // proves webhook calls for that bot really come from Telegram
  ANALYTICS_BOT_USERNAME?: string;  // its username without @ (default: VaneAnalyticsBot)
  TELEGRAM_WEBHOOK_SECRET?: string; // proves webhook calls really come from Telegram

  ADMIN_PASSWORD_HASH?: string;     // /admin password, PBKDF2 hash from `npm run admin:hash` (admin is OFF without it)
  GSC_SERVICE_ACCOUNT?: string;     // Google service-account JSON key (Search Console tab in /admin)
  PROXYCHECK_KEY?: string;          // optional: proxycheck.io key, enables the VPN / proxy lookup
  TURNSTILE_SECRET_KEY?: string;    // Cloudflare Turnstile secret; bot check on sign-in / sign-up is enforced when set together with the site key
  RESEND_API_KEY?: string;          // Resend API key; emailed 6-digit codes are enforced when set together with EMAIL_FROM

  /** Plain vars */
  APP_URL?: string;             // e.g. https://vaneapp.dev
  ADMIN_EMAIL?: string;         // /admin login (e-mail)
  ADMIN_USERNAME?: string;      // optional second login name for /admin
  ADMIN_ALLOW_IPS?: string;     // optional: comma list of addresses / CIDR ranges allowed to use /admin
  GSC_SITE_URL?: string;        // Search Console property, e.g. sc-domain:vaneapp.dev
  TURNSTILE_SITE_KEY?: string;  // Cloudflare Turnstile site key (public, rendered on /login)
  SHIELD_OFF?: string;          // "1" switches the API shield off (functions/api/lib/shield.ts): the emergency brake if it ever blocks the wrong people
  CONTACT_TO?: string;          // optional: where the contact form on /about sends messages (default info.vaneapp@gmail.com)
  EMAIL_FROM?: string;          // sender on a domain verified in Resend, e.g. "Vane <noreply@vaneapp.dev>"

  /** LinkedIn (Share on LinkedIn + Sign In with LinkedIn using OpenID Connect): the connect button is off until both are set */
  LINKEDIN_CLIENT_ID?: string;      // plain var
  LINKEDIN_CLIENT_SECRET?: string;  // secret
  LINKEDIN_VERSION?: string;        // optional: the Linkedin-Version header, YYYYMM (default in channels/linkedin.ts)
  /** Sign in with GitHub / Google: each button is off until both of its values are set */
  GITHUB_CLIENT_ID?: string;        // plain var
  GITHUB_CLIENT_SECRET?: string;    // secret
  GOOGLE_CLIENT_ID?: string;        // plain var
  GOOGLE_CLIENT_SECRET?: string;    // secret
  /** Vane Studio → YouTube (a separate Google OAuth client with the youtube.upload scope): the connect button is off until both are set */
  /** Vane Post → Reddit (OAuth app of type "web app") and Facebook Pages (Meta app with Facebook Login): each connect button is off until both are set */
  REDDIT_CLIENT_ID?: string;        // plain var
  REDDIT_CLIENT_SECRET?: string;    // secret
  FACEBOOK_APP_ID?: string;         // plain var
  FACEBOOK_APP_SECRET?: string;     // secret
  PINTEREST_APP_ID?: string;        // plain var
  PINTEREST_APP_SECRET?: string;    // secret
  /** Vane Studio → Instagram Reels (Meta app with Instagram API / Instagram Login): the connect button is off until both are set */
  INSTAGRAM_APP_ID?: string;        // plain var
  INSTAGRAM_APP_SECRET?: string;    // secret
  /** Vane Studio → TikTok (Login Kit + Content Posting API): the connect button is off until both are set */
  TIKTOK_CLIENT_KEY?: string;       // plain var
  TIKTOK_CLIENT_SECRET?: string;    // secret
  YOUTUBE_CLIENT_ID?: string;       // plain var
  YOUTUBE_CLIENT_SECRET?: string;   // secret
  /** Threads (Meta app with the Threads API): the connect button is off until both are set */
  THREADS_APP_ID?: string;          // plain var
  THREADS_APP_SECRET?: string;      // secret (also checks Meta's deauthorize / data-deletion calls)
  SYSTEM_BOT_USERNAME?: string; // shared bot username without @ (default: VanePublishBot)
}

// ───────────────────────── Enums ─────────────────────────
export type Plan = 'free' | 'pro';
export type ChannelType = 'telegram' | 'x' | 'linkedin' | 'webhook' | 'bluesky' | 'mastodon' | 'threads' | 'discord' | 'devto' | 'reddit' | 'facebook' | 'pinterest';
export type PostStatus =
  | 'draft'
  | 'scheduled'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ───────────────────────── Rows ─────────────────────────
/** All timestamps are unix epoch seconds (UTC). */
export interface WaitlistRow {
  id: number;
  email: string;
  created_at: number;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  timezone: string;
  plan: Plan;
  stripe_customer_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChannelRow {
  id: string;
  user_id: string;
  type: ChannelType;
  name: string;
  /** JSON string, encrypted. Decrypt → ChannelCredentials */
  credentials: string;
  is_active: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface PostRow {
  id: string;
  group_id: string;
  user_id: string;
  channel_id: string;
  content: string;
  /** JSON string: string[] of R2 object keys OR external https URLs (told apart by the "https://" prefix) */
  media_keys: string;
  scheduled_at: number;
  status: PostStatus;
  attempts: number;
  external_id: string | null;
  error: string | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LogRow {
  id: number;
  user_id: string | null;
  post_id: string | null;
  channel_id: string | null;
  level: LogLevel;
  event: string;
  message: string | null;
  /** JSON string */
  meta: string | null;
  created_at: number;
}

// ───────────────────────── Decrypted channel credentials ─────────────────────────
export type ChannelCredentials =
  | { type: 'telegram'; botToken: string; chatId: string }
  | { type: 'x'; accessToken: string; refreshToken?: string; expiresAt?: number }
  | { type: 'linkedin'; accessToken: string; refreshToken?: string; urn: string; name?: string; expiresAt?: number; refreshExpiresAt?: number }
  | { type: 'threads'; accessToken: string; userId: string; username: string; expiresAt: number }
  | { type: 'mastodon'; instance: string; accountId: string; acct: string; accessToken: string }
  | { type: 'bluesky'; service: string; identifier: string; did: string; appPassword: string }
  | { type: 'discord'; webhookUrl: string; webhookId: string; guildId: string | null; channelId: string | null }
  | { type: 'devto'; apiKey: string; userId: number; username: string }
  | { type: 'reddit'; username: string; subreddit: string; accessToken: string; refreshToken: string; expiresAt: number }
  | { type: 'facebook'; pageId: string; pageName: string; accessToken: string }
  | { type: 'pinterest'; username: string; boardId: string; boardName: string; accessToken: string; refreshToken: string; expiresAt: number }
  | { type: 'webhook'; url: string; secret?: string };

// ───────────────────────── API contracts ─────────────────────────
export interface WaitlistRequest {
  email: string;
  /** honeypot — real users leave it empty */
  website?: string;
}

export type WaitlistResponse =
  | { ok: true; status: 'joined' | 'already_joined' }
  | { ok: false; error: string };

// ───────────────────────── Channels API ─────────────────────────
/** What the API ever returns about a channel. Credentials are never included. */
export interface ChannelPublic {
  id: string;
  platform: ChannelType;
  name: string;
  isActive: boolean;
  createdAt: number;
  /** LinkedIn / Threads only: unix seconds when the saved sign-in stops working (the dashboard offers "Reconnect" before that) */
  expiresAt?: number;
}

export interface AddChannelRequest {
  platform: ChannelType;
  name: string;
  /** 'custom' (default): the user's own bot · 'quick': the shared Vane bot after ownership proof */
  method?: 'custom' | 'quick';
  /** telegram custom: { botToken, chatId }  (chatId: "@channel", "-100…" or a number) · telegram quick: { verificationId } · bluesky: { identifier, appPassword } */
  credentials: { botToken: string; chatId: string | number } | { verificationId: string } | { identifier: string; appPassword: string };
}

export type ApiError = { ok: false; error: string };

export type ListChannelsResponse = { ok: true; channels: ChannelPublic[] } | ApiError;

export type AddChannelResponse =
  | {
      ok: true;
      channel: ChannelPublic;
      telegram: { chatType: string; chatTitle: string | null; botUsername: string | null };
    }
  | ApiError;

export type DeleteChannelResponse = { ok: true; deletedScheduledPosts: number } | ApiError;

// ───────────────────────── Posts API ─────────────────────────
export interface CreatePostRequest {
  content: string;
  /** public https URL of an image (optional) */
  mediaUrl?: string | null;
  channelIds: string[];
  /** ISO-8601 with timezone ("2026-10-20T09:00:00Z") or unix seconds. Must be in the future. */
  scheduledAt: string | number;
}

export type CreatePostResponse =
  | {
      ok: true;
      groupId: string;
      /** unix seconds */
      scheduledAt: number;
      posts: { id: string; channelId: string; status: 'scheduled' }[];
    }
  | ApiError;

// ───────────────────────── Auth API (stage 3) ─────────────────────────
export interface UserPublic {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
}

export interface RegisterRequest { email: string; password: string; name?: string; timezone?: string }
export interface LoginRequest { email: string; password: string }

export type AuthResponse = { ok: true; user: UserPublic } | ApiError;
export interface UserFeatures {
  uploads: boolean;
  /** Quick Connect (shared bot) is configured on this server */
  quickConnect: boolean;
  /** e.g. "@VanePublishBot" when quickConnect is true */
  systemBot: string | null;
  /** the LinkedIn / Threads app is configured on this server, so their connect buttons work */
  linkedin: boolean;
  threads: boolean;
  reddit: boolean;
  facebook: boolean;
  pinterest: boolean;
}
export type MeResponse = { ok: true; user: UserPublic; features: UserFeatures } | ApiError;

// ───────────────────────── Email verification (6-digit codes) ─────────────────────────
export type VerifyPurpose = 'signup' | 'login';

/** Sent with HTTP 202 by register / login / resend once a code was emailed. No session exists yet. */
export interface VerifyChallenge {
  email: string;
  purpose: VerifyPurpose;
  /** seconds from now until the code stops working */
  expiresIn: number;
  /** seconds from now until a new code can be requested (relative, so a wrong clock on the device can't break the timer) */
  resendIn: number;
}

export interface VerifyRequest { email: string; code: string; purpose: VerifyPurpose }

export type VerifyStartResponse = { ok: true; verify: VerifyChallenge } | ApiError;

// ───────────────────────── Posts list (stage 3) ─────────────────────────
export interface PostPublic {
  id: string;
  /** posts created together (one per channel) share a groupId */
  groupId: string;
  channelId: string;
  channelName: string;
  platform: ChannelType;
  content: string;
  mediaUrl: string | null;
  /** 'image' | 'video' — derived from the attached file */
  mediaKind: 'image' | 'video' | null;
  /** unix seconds */
  scheduledAt: number;
  status: PostStatus;
  /** delivery attempts made so far (the sender retries temporary failures) */
  attempts: number;
  error: string | null;
  sentAt: number | null;
  /** where the published post can be opened on its network (https); null while unsent or when the network gives no link */
  url: string | null;
}

export type ListPostsResponse = { ok: true; posts: PostPublic[] } | ApiError;

// ───────────────────────── Cron worker (stage 4) ─────────────────────────
/** Bindings of the separate `vane-cron` Worker (see worker/wrangler.toml). */
export interface CronEnv {
  DB: D1Database;
  MEDIA?: R2Bucket;          // the video library: a network's publisher reads the file from here (see worker/wrangler.toml)
  VIDEO_PUBLISH_MOCK?: string; // local dev only, see Env
  ENCRYPTION_KEY?: string;   // MUST be the same value as on the Pages project
  SYSTEM_BOT_TOKEN?: string; // MUST be the same as on Pages: needed to publish to Quick Connect channels
  ANALYTICS_BOT_TOKEN?: string; // the same secret as on Pages: lets the cron send Analytics bot alerts
  APP_URL?: string;          // public origin, used to turn stored R2 keys into URLs
  LINKEDIN_CLIENT_ID?: string;     // only to renew a LinkedIn sign-in that came with a refresh token
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_VERSION?: string;       // the same optional value as on Pages
  MONOBANK_TOKEN?: string;         // the same secret as on Pages: lets the cron ask Monobank about card orders whose webhook never came
  RESEND_API_KEY?: string;         // the same secret as on Pages: lets the cron send the weekly Analytics report
  EMAIL_FROM?: string;             // the same variable as on Pages
  JWT_SECRET?: string;             // the same secret as on Pages: signs the unsubscribe link in that email
  CRYPTO_WALLET?: string;          // the same as on Pages: lets the cron find crypto payments even when the buyer closed the checkout page
  SOLANA_RPC_URL?: string;        // the same optional value as on Pages
  REDDIT_CLIENT_ID?: string;      // the same as on Pages: renews the Reddit access (an hour) before each post
  REDDIT_CLIENT_SECRET?: string;  // the same secret as on Pages
  PINTEREST_APP_ID?: string;      // the same as on Pages: renews the Pinterest access before a pin
  PINTEREST_APP_SECRET?: string;  // the same secret as on Pages
  YOUTUBE_CLIENT_ID?: string;     // the same as on Pages: renews the YouTube access before each upload
  YOUTUBE_CLIENT_SECRET?: string; // the same secret as on Pages
  TIKTOK_CLIENT_KEY?: string;     // the same as on Pages: renews the TikTok access (a day) before each post
  TIKTOK_CLIENT_SECRET?: string;  // the same secret as on Pages
}

// ───────────────────────── Quick Connect (stage 2 of the upgrade) ─────────────────────────
export interface QuickStartRequest { chat: string }

export type QuickStartResponse =
  | {
      ok: true;
      verificationId: string;
      /** one-time code the user must post in the channel, e.g. "VANE-7K3F9QXA" */
      code: string;
      /** unix seconds */
      expiresAt: number;
      bot: string;
      chat: { title: string | null; type: string };
    }
  | ApiError;

export type QuickStatusResponse = { ok: true; verified: boolean; expired: boolean; expiresAt: number } | ApiError;

// ───────────────────────── Public API: keys, plans, usage (API part 1) ─────────────────────────
export type { PlanId, SubscriptionStatus } from './functions/api/lib/plans';
import type { PlanId, SubscriptionStatus } from './functions/api/lib/plans';

/** cpost_… keys use the text/media endpoints; cvid_… keys use the Video Engine (/api/v1/video/*). */
export type KeyScope = 'post' | 'video';
/** live: real posts, counted · test: answers are simulated, nothing is posted and nothing is counted */
export type KeyMode = 'live' | 'test';

/** What the API ever returns about a key. The secret is shown once, on creation, and the hash never leaves the database. */
export interface ApiKeyPublic {
  id: string;
  name: string;
  scope: KeyScope;
  mode: KeyMode;
  /** masked for display, e.g. "cpost_live_••••ab12" */
  display: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** where the owner said the key is used ("Used with"), null when not said */
  integration: 'claude' | 'notion' | 'chatgpt' | 'make' | 'zapier' | 'wordpress' | 'obsidian' | 'api' | null;
}

export interface CreateApiKeyRequest {
  name: string;
  mode?: KeyMode;
  scope?: KeyScope;
  /** claude | chatgpt | make | zapier | wordpress | api (optional) */
  integration?: string | null;
}

export type CreateApiKeyResponse =
  | {
      ok: true;
      key: ApiKeyPublic;
      /** the full key. Shown ONCE: only its SHA-256 is stored, so it can never be shown again */
      secret: string;
    }
  | ApiError;

export type ListApiKeysResponse = { ok: true; keys: ApiKeyPublic[]; max: number } | ApiError;

/** limit − used = remaining. On the Free Trial UI and API posts share one total, so both buckets show that total. */
export interface UsageBucket {
  limit: number;
  used: number;
  remaining: number;
}

export interface UsageSummary {
  plan: {
    id: PlanId;
    label: string;
    status: SubscriptionStatus;
    /** a paid plan that is not active any more: the Free Trial limits apply until a payment renews it */
    lapsed: boolean;
    apiAddon: boolean;
    /** unix seconds, null = no expiry */
    currentPeriodEnd: number | null;
  };
  period: {
    /** 'lifetime' or 'YYYY-MM' (UTC) */
    key: string;
    /** unix seconds when the monthly quota resets, null for a lifetime quota */
    resetsAt: number | null;
  };
  /** how many more API posts this account can send */
  api: UsageBucket;
  ui: UsageBucket;
  /** Free Trial only */
  shared: UsageBucket | null;
  /** AI generations (Smart Re-formatter, Post Generator, Tone, Hook & CTA); the free tools are not counted */
  ai: {
    /** credits the plan includes; null = no fixed amount (unlimited, or billed per generation: see perGenerationUsd) */
    limit: number | null;
    used: number;
    remaining: number | null;
    /** set when every generation is billed (Developer API): USD per generation */
    perGenerationUsd: number | null;
    /** can a premium generation run for this account right now? false = Developer API without extra-usage billing */
    billable: boolean;
    /** extra credits an admin gave to this account (already included in `remaining`) */
    bonus: number;
    /** this account's AI Pass (monthly credits on top of the plan, included in `remaining`) */
    pass: { active: boolean; credits: number; used: number; remaining: number; endsAt: number | null };
    /** the AI Pass offer for accounts that do not have it; null = nothing to offer */
    offer: { priceUsd: number; credits: number; interval: string; overageUsd: number | null } | null;
    /** "when credits run out": stop, or pay per extra credit. rateUsd = the price of one extra credit (null: nothing to pay for) */
    extra: { enabled: boolean; rateUsd: number | null };
  };
  /** may this account send live API requests? */
  apiAccess: boolean;
  overage: {
    enabled: boolean;
    /** price per post beyond the quota (USD), null when this plan is never billed for extras */
    postUsd: number | null;
    aiPostUsd: number | null;
    posts: number;
    costUsd: number;
  };
}

export type UsageResponse = { ok: true; usage: UsageSummary } | ApiError;

// ───────────────────────── Vane Studio / Video Engine (separate dashboard, API: /api/video/*, /api/v1/video/*) ─────────────────────────
export type VideoStatus = 'uploading' | 'ready' | 'failed';
export type VideoContentType = 'video/mp4' | 'video/quicktime';

export interface VideoRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  /** JSON string: string[] */
  tags: string;
  status: VideoStatus;
  r2_key: string;
  content_type: VideoContentType;
  size_bytes: number;
  part_size: number;
  upload_id: string | null;
  upload_expires_at: number | null;
  error: string | null;
  source: 'ui' | 'api';
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** A video row joined with its optional preview/length and its public link (what every library query returns). */
export interface VideoRowJoined extends VideoRow {
  thumb_key: string | null;
  cover_key: string | null;
  cover_type: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  link_token: string | null;
}

/** What the API ever returns about a video. The R2 key and the multipart upload id never leave the server. */
export interface VideoPublic {
  id: string;
  title: string;
  description: string;
  tags: string[];
  status: VideoStatus;
  contentType: VideoContentType;
  sizeBytes: number;
  /** why a failed video was rejected */
  error: string | null;
  createdAt: number;
  completedAt: number | null;
  /** unfinished uploads only: unix seconds after which the upload is thrown away */
  uploadExpiresAt: number | null;
  /** dashboard only: where the owner streams it (needs the session cookie). Not set in the public API. */
  fileUrl: string | null;
  /** dashboard only: the preview frame (needs the session cookie) */
  thumbnailUrl: string | null;
  /** true when the owner uploaded their own cover (otherwise the preview is a frame taken from the video) */
  hasCover: boolean;
  /** the cover at an address anyone can open: only when the video has a public link and a cover. Networks and link previews use it. */
  coverUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** the public link, if the owner made one: anyone with it can watch and download the video */
  publicUrl: string | null;
}

export interface StartVideoUploadRequest {
  /** the file's size in bytes */
  size: number;
  contentType: VideoContentType;
  /** used for the default title */
  fileName?: string;
  title?: string;
  description?: string;
  tags?: string[];
}

export type StartVideoUploadResponse =
  | {
      ok: true;
      videoId: string;
      /** every chunk but the last must be exactly this many bytes */
      partSize: number;
      partCount: number;
      uploadedParts: number[];
      /** unix seconds */
      expiresAt: number;
      video: VideoPublic;
      /** test keys only: nothing was stored */
      simulated?: true;
    }
  | ApiError;

// ───────────────────────── Vane Studio publishing ─────────────────────────
export type VideoPrivacy = 'private' | 'unlisted' | 'public';
export type VideoPublicationStatus = 'queued' | 'publishing' | 'published' | 'failed';

export interface VideoPublicationPublic {
  id: string;
  videoId: string;
  videoTitle: string | null;
  platform: 'youtube' | 'tiktok' | 'instagram';
  channelName: string;
  title: string;
  description: string;
  privacy: VideoPrivacy;
  status: VideoPublicationStatus;
  attempts: number;
  maxAttempts: number;
  /** only while queued: when the next attempt is due (unix seconds) */
  nextAttemptAt: number | null;
  error: string | null;
  /** where the published video lives on the network */
  url: string | null;
  createdAt: number;
  publishedAt: number | null;
}

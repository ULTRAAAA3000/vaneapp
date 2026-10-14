/**
 * Vane — shared types: Cloudflare bindings (Env) + D1 row shapes.
 * Requires: npm i -D @cloudflare/workers-types
 */
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

// ───────────────────────── Environment ─────────────────────────
export interface Env {
  /** D1 database (binding name must match wrangler.toml) */
  DB: D1Database;
  /** R2 bucket for post media */
  MEDIA?: R2Bucket;             // optional: uploads are enabled only when the R2 bucket is bound

  /** Secrets (wrangler secret put / Pages → Settings → Variables) */
  ENCRYPTION_KEY?: string;      // for encrypting channels.credentials (>= 32 random chars)
  JWT_SECRET?: string;          // signs/verifies API bearer tokens (>= 32 chars)
  STRIPE_SECRET_KEY?: string;

  /** Plain vars */
  APP_URL?: string;             // e.g. https://vaneapp.dev
}

// ───────────────────────── Enums ─────────────────────────
export type Plan = 'free' | 'pro';
export type ChannelType = 'telegram' | 'x' | 'linkedin' | 'webhook';
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
  | { type: 'linkedin'; accessToken: string; refreshToken?: string; urn: string; expiresAt?: number }
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
}

export interface AddChannelRequest {
  platform: ChannelType;
  name: string;
  /** telegram: { botToken, chatId }  (chatId: "@channel", "-100…" or a number) */
  credentials: { botToken: string; chatId: string | number };
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
export type MeResponse = { ok: true; user: UserPublic; features: { uploads: boolean } } | ApiError;

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
  /** unix seconds */
  scheduledAt: number;
  status: PostStatus;
  error: string | null;
  sentAt: number | null;
}

export type ListPostsResponse = { ok: true; posts: PostPublic[] } | ApiError;

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
  MEDIA: R2Bucket;

  /** Secrets (wrangler secret put / Pages → Settings → Variables) */
  ENCRYPTION_KEY?: string;      // for encrypting channels.credentials
  JWT_SECRET?: string;
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
  /** JSON string: string[] of R2 keys */
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

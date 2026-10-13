#!/usr/bin/env node
/**
 * Dev helper: mint a JWT for testing the API before login/registration exists.
 *
 *   node scripts/dev-token.mjs <JWT_SECRET> [userId] [hours=24]
 *
 * Prints the token and the SQL that creates the matching user row.
 * Use the SAME JWT_SECRET that the API runs with (.dev.vars locally, Pages secret in prod).
 */
import { createHmac, randomUUID } from 'node:crypto';

const [secret, userId = randomUUID(), hours = '24'] = process.argv.slice(2);
if (!secret || secret.length < 32) {
  console.error('Usage: node scripts/dev-token.mjs <JWT_SECRET (>=32 chars)> [userId] [hours]');
  process.exit(1);
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const body = b64u(JSON.stringify({ sub: userId, iat: now, exp: now + Math.floor(Number(hours) * 3600) }));
const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');

console.log(`\nuser id : ${userId}`);
console.log(`token   : ${head}.${body}.${sig}\n`);
console.log('Create the user (local):');
console.log(`npx wrangler d1 execute vane-db --local --command "INSERT OR IGNORE INTO users (id, email) VALUES ('${userId}', 'dev@vaneapp.dev')"\n`);

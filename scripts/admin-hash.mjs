#!/usr/bin/env node
/**
 * Makes the value for the ADMIN_PASSWORD_HASH secret (same PBKDF2 format as user passwords).
 *
 *   npm run admin:hash            → asks for the password (typing is hidden)
 *   echo 'pw' | npm run admin:hash → reads it from a pipe
 *
 * Then store it (never put it in a file in the repo):
 *   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name=vaneapp
 *   npx wrangler pages secret put ADMIN_EMAIL --project-name=vaneapp
 */
import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 100_000; // the Workers ceiling, must match functions/api/lib/password.ts
const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  process.stdout.write('Admin password (hidden): ');
  return new Promise((resolve) => {
    let pw = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (c === '\u0003') process.exit(130); // Ctrl-C
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1);
        else pw += c;
      }
    });
  });
}

const password = await readPassword();
if (password.length < 12) {
  console.error('Use at least 12 characters (a long random passphrase is best).');
  process.exit(1);
}
if (/12345|qwer|qwas|password|admin/i.test(password)) {
  console.error('⚠  This password contains a guessable pattern (12345 / qwer / admin / password…). It will work, but pick a random one.');
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
console.log(`pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`);

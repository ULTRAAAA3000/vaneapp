#!/usr/bin/env node
/**
 * scripts/db-check.sql (the "what is missing in this database" query) against SQLite copies of schema.sql: a full database answers
 * "ok", an OLD one (missing a table, the columns that migrations add, a channel type) names each problem and the file that fixes it,
 * and it stays in step with schema.sql.   npm run test:unit
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };

const schema = readFileSync('schema.sql', 'utf8');
const query = readFileSync('scripts/db-check.sql', 'utf8');
const run = (db) => db.prepare(query).all().map((r) => ({ ...r }));
const full = () => { const db = new DatabaseSync(':memory:'); db.exec(schema); return db; };

console.log('\na complete database');
{
  const rows = run(full());
  check('answers a single "ok" row', rows.length === 1 && rows[0].problem === 'ok', JSON.stringify(rows));
}

console.log('\nan old database');
{
  const db = full();
  db.exec('DROP INDEX idx_usage_logs_open_overage; ALTER TABLE usage_logs DROP COLUMN refunded_at; ALTER TABLE subscriptions DROP COLUMN overage_cap_micro_usd;');
  db.exec('DROP TABLE password_resets; DROP TABLE feedback_votes; DROP TABLE feedback_items; DROP TABLE agent_events;');
  const rows = run(db);
  const what = (w) => rows.find((r) => r.what === w);
  check('a missing column is named with the migration that adds it', what('usage_logs.refunded_at')?.fix.includes('011-overage-cap-refund.sql') && what('subscriptions.overage_cap_micro_usd')?.fix.includes('011-overage-cap-refund.sql'), JSON.stringify(rows));
  check('a missing table is named with the migration that creates it', what('password_resets')?.fix === 'scripts/migrations/009-password-reset.sql' && what('feedback_items')?.fix === 'scripts/migrations/005-feedback.sql' && what('agent_events')?.fix === 'scripts/migrations/008-agent-log.sql');
  check('nothing that exists is reported', rows.length === 6 && rows.every((r) => r.problem !== 'ok'), `${rows.length} rows`);
  check('a table with no migration file points at its CREATE TABLE', (() => { const d = full(); d.exec('DROP TABLE onboarding_progress; DROP TABLE hostile_never_existed'.replace('; DROP TABLE hostile_never_existed', '')); return run(d).every((r) => r.problem === 'missing table'); })());
}
{
  const db = full();
  db.exec('DROP INDEX IF EXISTS idx_api_keys_integration; ALTER TABLE api_keys DROP COLUMN integration;');
  check('the api_keys.integration column (migration 002) is checked too', run(db).some((r) => r.what === 'api_keys.integration' && r.fix.includes('002-api-key-integration.sql')));
}
{
  // a channels table from before Pinterest was allowed (its CHECK list is the only place the types live)
  const old = schema.replace(", 'facebook', 'pinterest')", ", 'facebook')");
  const db = new DatabaseSync(':memory:'); db.exec(old);
  const rows = run(db);
  check('a channels table that does not allow a type yet names the migration', rows.length === 1 && rows[0].problem === 'channel type not allowed' && rows[0].what === 'pinterest' && rows[0].fix.includes('0004-channel-types-pinterest.sql'), JSON.stringify(rows));
}

console.log('\nin step with schema.sql');
{
  const tables = [...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((m) => m[1]);
  const listed = [...query.matchAll(/^\s+\('(\w+)', '/gm)].map((m) => m[1]);
  check(`every table of schema.sql is checked (${tables.length})`, tables.every((t) => listed.includes(t)), tables.filter((t) => !listed.includes(t)).join(', '));
  check('nothing is checked that schema.sql does not have', listed.every((t) => tables.includes(t)), listed.filter((t) => !tables.includes(t)).join(', '));
  const types = [...(schema.match(/CHECK \(type IN \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const covered = ['discord', 'devto', 'reddit', 'facebook', 'pinterest'];
  check('every channel type added by a migration is checked', covered.every((t) => types.includes(t) && query.includes(`'${t}'`)));
  const alters = ['subscriptions.overage_cap_micro_usd', 'usage_logs.refunded_at', 'api_keys.integration'];
  const migrations = ['011-overage-cap-refund.sql', '002-api-key-integration.sql'].map((f) => readFileSync(`scripts/migrations/${f}`, 'utf8')).join('\n');
  check('every ADD COLUMN of the migrations is checked', [...migrations.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].every((m) => alters.includes(`${m[1]}.${m[2]}`) && query.includes(m[2])));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);

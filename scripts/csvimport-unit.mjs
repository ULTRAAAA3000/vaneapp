#!/usr/bin/env node
/**
 * The spreadsheet import (public/assets/csv-import.js): reading the file, the dates, the network names and the row checks.
 * The real file runs in an isolated context with a fake page.   npm run test:unit
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync('public/assets/csv-import.js', 'utf8');
const ctx = { Vane: {}, document: { getElementById: () => null }, window: null };
ctx.window = ctx;
vm.runInNewContext(code, ctx);
const csv = ctx.Vane.csvImport;

let passed = 0;
const failed = [];
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${extra}`); } };
const channels = [
  { id: 'c1', platform: 'telegram', name: 'My channel', isActive: true },
  { id: 'c2', platform: 'bluesky', name: 'me.bsky.social', isActive: true },
  { id: 'c3', platform: 'devto', name: 'Dev.to blog', isActive: true },
  { id: 'c4', platform: 'discord', name: 'Off', isActive: false },
];
const NOW = new Date(2026, 10, 10, 12, 0).getTime();

console.log('\nreading the file');
{
  const t = csv.parse('﻿text,date\r\n"Hello, ""world""",2026-11-20 09:30\r\n"two\nlines",2026-11-21 10:00\r\n\r\n');
  check('a BOM, quotes, a comma and a line break inside quotes', t.length === 3 && t[1][0] === 'Hello, "world"' && t[2][0] === 'two\nlines', JSON.stringify(t));
  const s = csv.parse('text;date;networks\nHi;20.11.2026 09:30;telegram, bluesky\n');
  check('a semicolon file (Excel) is read too', s.length === 2 && s[1][0] === 'Hi' && s[1][2] === 'telegram, bluesky', JSON.stringify(s));
  check('a tab file is read too', csv.parse('text\tdate\nA\t2026-11-20 09:30')[1][1] === '2026-11-20 09:30');
  check('an empty file has no rows', csv.parse('').length === 0 && csv.parse('\n\n').length === 0);
}
console.log('\ncolumns and dates');
{
  const c = csv.columns(['Content', 'When', 'Channels', 'Image URL']);
  check('other names for the columns work', c.text === 0 && c.date === 1 && c.networks === 2 && c.image === 3, JSON.stringify(c));
  const d = csv.parseDate('2026-11-20 09:30');
  check('2026-11-20 09:30 is local time', d.getFullYear() === 2026 && d.getMonth() === 10 && d.getDate() === 20 && d.getHours() === 9 && d.getMinutes() === 30);
  const e = csv.parseDate('20.11.2026 9:05');
  check('20.11.2026 9:05 is read', e.getDate() === 20 && e.getMonth() === 10 && e.getHours() === 9 && e.getMinutes() === 5);
  check('an ISO date with a zone is read', csv.parseDate('2026-11-20T09:30:00Z').getTime() === Date.UTC(2026, 10, 20, 9, 30));
  check('31 February, a month 13 and plain text are refused', csv.parseDate('2026-02-31 10:00') === null && csv.parseDate('2026-13-01 10:00') === null && csv.parseDate('tomorrow') === null && csv.parseDate('') === null);
}
console.log('\nnetworks');
{
  check('empty means every connected channel (not the switched-off one)', JSON.stringify(csv.pickChannels('', channels).ids) === '["c1","c2","c3"]');
  check('names are matched by network or by channel name, any case', JSON.stringify(csv.pickChannels('Telegram; BLUESKY', channels).ids) === '["c1","c2"]' && JSON.stringify(csv.pickChannels('me.bsky.social', channels).ids) === '["c2"]');
  check('dev.to and devto are the same network', JSON.stringify(csv.pickChannels('Dev.to', channels).ids) === '["c3"]');
  check('a network that is not connected is named in the error', /“mastodon”/.test(csv.pickChannels('telegram; mastodon', channels).error));
  check('a switched-off channel is not connected', !!csv.pickChannels('discord', channels).error);
  check('nothing connected at all', !!csv.pickChannels('', []).error);
}
console.log('\nthe rows');
{
  const t = csv.parse([
    'text,date,networks,image',
    'Good post,2026-11-20 09:30,telegram,',
    ',2026-11-20 09:30,,',
    'Bad date,soon,,',
    'Past,2026-11-01 09:30,,',
    'Far,2029-01-01 09:30,,',
    'Image,2026-11-20 09:30,,http://example.com/a.png',
    'Unknown net,2026-11-20 09:30,myspace,',
    'Everywhere,2026-11-22 18:00,,https://example.com/a.png',
  ].join('\n'));
  const r = csv.check(t, channels, NOW);
  const err = r.rows.map((x) => x.error);
  check('a good row has no error and its channel', err[0] === '' && r.rows[0].ids.length === 1 && r.rows[0].ids[0] === 'c1');
  check('an empty text is caught', /empty/.test(err[1]));
  check('an unreadable date is caught', /Could not read the date/.test(err[2]));
  check('a date in the past is caught', /past/.test(err[3]));
  check('a date more than a year away is caught', /year ahead/.test(err[4]));
  check('an http image is refused', /https/.test(err[5]));
  check('an unknown network is caught', /myspace/.test(err[6]));
  check('a row with all channels and an https image is good', err[7] === '' && r.rows[7].ids.length === 3 && r.rows[7].image === 'https://example.com/a.png');
  check('row numbers match the spreadsheet (header is row 1)', r.rows[0].line === 2 && r.rows[7].line === 9);
  check('a missing column is explained', /“text” and “date”/.test(csv.check(csv.parse('a,b\n1,2'), channels, NOW).error));
  check('a file with only a header is explained', /at least one post/.test(csv.check(csv.parse('text,date'), channels, NOW).error));
  const many = ['text,date'].concat(Array.from({ length: 230 }, (_, i) => `P${i},2026-11-20 09:30`)).join('\n');
  const m = csv.check(csv.parse(many), channels, NOW);
  check('more than 200 rows: the first 200 are used, the rest is counted', m.rows.length === 200 && m.cut === 30);
}
console.log('\nthe template');
{
  const r = csv.check(csv.parse(csv.template(NOW)), channels, NOW);
  check('the downloadable template is valid as it is', r.rows.length === 2 && r.rows.every((x) => x.error === ''), JSON.stringify(r.rows.map((x) => x.error)));
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);

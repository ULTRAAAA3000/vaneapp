// Unit tests for the Live Analytics card helpers (public/assets/insights.js): Vane.insights.period and fmtSaved.
// Run: node scripts/live-card-unit.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const win = {};
vm.runInNewContext(readFileSync('public/assets/insights.js', 'utf8'), { window: win, Intl, Date, Math, Object, Array, String, RegExp, Number });
const { period, fmtSaved, MIN_PER_DELIVERY } = win.Vane.insights;

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// Wednesday 2026-10-28, noon. Helper: a delivery N days ago at 10:00.
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();
const at = (daysAgo, h = 10) => Math.floor(new Date(2026, 9, 28 - daysAgo, h, 0, 0).getTime() / 1000);
const post = (daysAgo, status = 'sent', platform = 'telegram') => ({ status, platform, channelId: platform, sentAt: at(daysAgo), scheduledAt: at(daysAgo) });

console.log('period');
let p = period([post(0), post(1), post(2, 'sent', 'bluesky'), post(10), post(3, 'cancelled')], NOW, 7);
eq('week counts sent in the last 7 days only', p.sent, 3);
eq('cancelled posts are ignored', p.failed, 0);
eq('two platforms', p.platforms, 2);
eq('minutes = sent x estimate', p.minutes, 3 * MIN_PER_DELIVERY);
eq('no failures: rate is 100', p.rate, 100);
p = period([post(0), post(10)], NOW, 30);
eq('month includes a post from 10 days ago', p.sent, 2);

console.log('rate');
const many = (sent, failedN) => [...Array(sent)].map(() => post(1)).concat([...Array(failedN)].map(() => post(1, 'failed')));
eq('998 of 1000 settled with 2 failed -> 99.8', period(many(998, 2), NOW, 7).rate, 99.8);
eq('999 sent, 1 failed is 99.9, not rounded up to 100', period(many(999, 1), NOW, 7).rate, 99.9);
eq('9999 sent, 1 failed still shows below 100', period(many(9999, 1), NOW, 7).rate, 99.9);
eq('only failures -> 0', period(many(0, 3), NOW, 7).rate, 0);
eq('nothing finished -> null', period([], NOW, 7).rate, null);
eq('a failure outside the period does not count', period([post(1), post(20, 'failed')], NOW, 7).failed, 0);

console.log('weekday buckets (Monday first)');
// 2026-10-28 is a Wednesday (index 2); 1 day ago is Tuesday (1); 2 days ago Monday (0).
p = period([post(0), post(0), post(1), post(2), post(2), post(2)], NOW, 7);
eq('buckets', p.byWeekday, [3, 1, 2, 0, 0, 0, 0]);
eq('peak is Monday', p.peak, 0);
eq('today is Wednesday', p.today, 2);
eq('no posts -> no peak', period([], NOW, 7).peak, -1);

console.log('truncated history');
const full = [...Array(200)].map(() => post(2));
eq('a full list that reaches into the period is truncated', period(full, NOW, 30, 200).truncated, true);
eq('a full list that ends before the period is complete', period([...Array(200)].map(() => post(40)), NOW, 30, 200).truncated, false);
eq('a short list is complete', period([post(2)], NOW, 30, 200).truncated, false);

console.log('fmtSaved');
eq('0 minutes', fmtSaved(0), '0 minutes');
eq('1 minute', fmtSaved(1), '1 minute');
eq('25 minutes', fmtSaved(25), '25 minutes');
eq('short minutes', fmtSaved(25, true), '25 min');
eq('1 hour', fmtSaved(60), '1 hour');
eq('4.5 hours', fmtSaved(270), '4.5 hours');
eq('short hours', fmtSaved(270, true), '4.5 h');
eq('whole hours drop the .0', fmtSaved(120, true), '2 h');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

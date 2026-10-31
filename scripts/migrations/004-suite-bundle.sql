-- Run ONCE on an existing database:  npm run db:migrate:suite
-- The Suite bundle now also carries 75 API posts a month with live API keys. (Analytics Pro and the AI Pass come from the code: a Suite order
-- switches both on, lib/billing.ts → activate.) This file only changes what the plan row says:
--  * limits: apiPostsPerMonth 75 and apiAccess 1 are SET, everything else you edited in /admin → Plans (prices, posts, AI credits) stays.
--  * features + tagline: replaced ONLY while they are still the original text; if you edited them in the admin, change them there.
-- The price is NOT touched here (you set it in /admin → Plans: $40 a month; the new seed yearly price is $399).
UPDATE plans SET limits = json_set(limits, '$.apiPostsPerMonth', 75, '$.apiAccess', 1), updated_at = unixepoch() WHERE id = 'suite';
UPDATE plans SET features = '["Everything in Vane Post Pro: 1,000 posts a month, unlimited channels","Everything in Vane Studio: video library and publishing","Analytics Pro: reports across all your networks","Vane AI Pass included, on top of the plan''s own AI credits","API access: 75 API posts a month","Post a new video to all your networks in one click","One payment, one renewal date, one invoice"]',
  tagline = 'Posting, video, analytics and AI in one plan.', updated_at = unixepoch()
  WHERE id = 'suite' AND features = '["Everything in Vane Post Pro: 1,000 posts a month, unlimited channels","Everything in Vane Studio: video library, API and AI","Post a new video to all your networks in one click","One payment, one renewal date, one invoice","Vane AI Pass included"]';

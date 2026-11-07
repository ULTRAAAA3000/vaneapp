-- Run ONCE on an existing database:  npm run db:migrate:library-storage
-- Library storage per plan: Free Trial 10 MB, every paid plan 100 MB (Pro Dashboard, Vane Suite, Developer API).
--  * limits: storageMb is SET only where it is still empty, so a value you already typed in /admin → Plans stays.
--  * features: the line is added ONLY while the plan still has its original text. If you edited the features in the admin, add the line there
--    ("10 MB media library" / "100 MB media library"). Prices and everything else are not touched.
-- The limit is applied while the "Enforce limits" switch is on (like the channel limit). Files already uploaded are never removed: an account
-- that is over the limit can still use what it has and delete, it just cannot upload more until it is under the limit again.
UPDATE plans SET limits = json_set(limits, '$.storageMb', 10),  updated_at = unixepoch() WHERE id = 'free' AND json_extract(limits, '$.storageMb') IS NULL;
UPDATE plans SET limits = json_set(limits, '$.storageMb', 100), updated_at = unixepoch() WHERE id IN ('api', 'pro', 'suite') AND json_extract(limits, '$.storageMb') IS NULL;

UPDATE plans SET features = REPLACE(features, '"Free AI utilities","Try the dashboard and the API"', '"Free AI utilities","10 MB media library","Try the dashboard and the API"'), updated_at = unixepoch()
  WHERE id = 'free' AND features LIKE '%"Free AI utilities","Try the dashboard and the API"%';
UPDATE plans SET features = REPLACE(features, '"Media library on Cloudflare R2"', '"100 MB media library on Cloudflare R2"'), updated_at = unixepoch()
  WHERE id = 'pro' AND features LIKE '%"Media library on Cloudflare R2"%';
UPDATE plans SET features = REPLACE(features, '"Everything in Vane Post Pro: 1,000 posts a month, unlimited channels"', '"Everything in Vane Post Pro: 1,000 posts a month, unlimited channels, 100 MB media library"'), updated_at = unixepoch()
  WHERE id = 'suite' AND features LIKE '%"Everything in Vane Post Pro: 1,000 posts a month, unlimited channels"%';

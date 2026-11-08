-- Takes the "waitlist" wording off the plan buttons (/ and /pricing). Run once in Cloudflare → D1 → vane-db → Console. Safe to repeat: a row only changes while it still holds the old label, labels edited in /admin → Plans are left alone.
UPDATE plans SET cta_label = 'Get started' WHERE cta_label = 'Join the waitlist';
UPDATE plans SET cta_label = 'Coming soon' WHERE cta_label = 'Get notified';

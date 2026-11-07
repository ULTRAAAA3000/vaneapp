-- Brings the catalog text in line with the live prices. Run once in Cloudflare → D1 → vane-db → Console. Safe to repeat: each row only changes while it still holds the old value.
UPDATE plans SET yearly_price_cents = 12000 WHERE id = 'pro' AND yearly_price_cents = 9900;
UPDATE plans SET tagline = 'Posting, video, analytics and AI in one plan.' WHERE id = 'suite' AND tagline = 'Vane Post Pro and Vane Studio together.';

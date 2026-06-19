-- Optional per-page password protection. Nullable + no default, so this is a
-- safe additive migration on the live table: existing rows stay NULL
-- (unprotected) and the running app is unaffected until the new code ships.
--
-- Stores a single self-describing PBKDF2 string: `pbkdf2$<iters>$<salt>$<hash>`
-- (base64url). NULL means the page is public.
ALTER TABLE pages ADD COLUMN password_hash TEXT;

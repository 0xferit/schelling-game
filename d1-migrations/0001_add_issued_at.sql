-- Add issued_at column to auth_challenges for wallet-signature sessions.
-- The column is nullable because ALTER TABLE ADD COLUMN in SQLite cannot
-- add NOT NULL without a default. Old rows (if any) will have NULL; the
-- application handles this by rejecting challenges with missing issued_at.
ALTER TABLE auth_challenges ADD COLUMN issued_at INTEGER;

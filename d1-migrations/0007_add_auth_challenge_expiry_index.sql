-- Speed up periodic cleanup of expired auth challenges.
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at
ON auth_challenges(expires_at);

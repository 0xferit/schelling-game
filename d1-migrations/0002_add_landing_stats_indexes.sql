-- Add indexes for landing page aggregate queries.
CREATE INDEX IF NOT EXISTS idx_matches_started_at ON matches(started_at);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);

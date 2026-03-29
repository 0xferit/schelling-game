ALTER TABLE vote_logs ADD COLUMN prompt_type TEXT;
ALTER TABLE vote_logs ADD COLUMN revealed_input_text TEXT;
ALTER TABLE vote_logs ADD COLUMN revealed_bucket_key TEXT;
ALTER TABLE vote_logs ADD COLUMN revealed_bucket_label TEXT;
ALTER TABLE vote_logs ADD COLUMN normalization_mode TEXT;
ALTER TABLE vote_logs ADD COLUMN normalization_run_id TEXT;
ALTER TABLE vote_logs ADD COLUMN winning_bucket_keys_json TEXT;

CREATE TABLE IF NOT EXISTS normalization_runs (
  run_id             TEXT PRIMARY KEY,
  match_id           TEXT NOT NULL,
  game_number        INTEGER NOT NULL,
  prompt_id          INTEGER NOT NULL,
  mode               TEXT NOT NULL,
  model              TEXT,
  normalizer_prompt  TEXT,
  request_json       TEXT,
  response_json      TEXT,
  created_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS normalization_verdicts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  match_id               TEXT NOT NULL,
  game_number            INTEGER NOT NULL,
  prompt_id              INTEGER NOT NULL,
  normalized_input_text  TEXT NOT NULL,
  bucket_key             TEXT NOT NULL,
  bucket_label           TEXT NOT NULL,
  created_at             TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_normalization_runs_match_game
  ON normalization_runs(match_id, game_number);

CREATE INDEX IF NOT EXISTS idx_normalization_verdicts_run_id
  ON normalization_verdicts(run_id);

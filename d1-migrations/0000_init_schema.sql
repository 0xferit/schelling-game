-- Base D1 schema for Schelling Game.
-- Together with subsequent migrations, this mirrors the production schema.

CREATE TABLE IF NOT EXISTS accounts (
  account_id           TEXT PRIMARY KEY,
  display_name         TEXT UNIQUE,
  token_balance        INTEGER DEFAULT 0,
  leaderboard_eligible INTEGER DEFAULT 1,
  created_at           TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_stats (
  account_id      TEXT PRIMARY KEY REFERENCES accounts(account_id),
  games_played    INTEGER DEFAULT 0,
  rounds_played   INTEGER DEFAULT 0,
  coherent_rounds INTEGER DEFAULT 0,
  current_streak  INTEGER DEFAULT 0,
  longest_streak  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge_id   TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  message        TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used           INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS matches (
  match_id     TEXT PRIMARY KEY,
  started_at   TEXT DEFAULT (datetime('now')),
  ended_at     TEXT,
  round_count  INTEGER DEFAULT 10,
  player_count INTEGER,
  status       TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id              TEXT REFERENCES matches(match_id),
  account_id            TEXT REFERENCES accounts(account_id),
  display_name_snapshot TEXT,
  starting_balance      INTEGER,
  ending_balance        INTEGER,
  net_delta             INTEGER,
  result                TEXT DEFAULT 'active',
  PRIMARY KEY (match_id, account_id)
);

CREATE TABLE IF NOT EXISTS vote_logs (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id                    TEXT,
  round_number                INTEGER,
  question_id                 INTEGER,
  account_id                  TEXT,
  display_name_snapshot       TEXT,
  revealed_option_index       INTEGER,
  revealed_option_label       TEXT,
  won_round                   INTEGER,
  earns_coordination_credit   INTEGER,
  ante_amount                 INTEGER DEFAULT 60,
  round_payout                INTEGER DEFAULT 0,
  net_delta                   INTEGER DEFAULT 0,
  player_count                INTEGER,
  valid_reveal_count          INTEGER,
  top_count                   INTEGER,
  winner_count                INTEGER,
  winning_option_indexes_json TEXT,
  voided                      INTEGER DEFAULT 0,
  void_reason                 TEXT,
  timestamp                   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS example_votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  option_index  INTEGER NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS question_ratings (
  question_id  INTEGER NOT NULL,
  account_id   TEXT NOT NULL,
  match_id     TEXT NOT NULL,
  round_number INTEGER,
  rating       TEXT NOT NULL,
  PRIMARY KEY (question_id, account_id, match_id)
);

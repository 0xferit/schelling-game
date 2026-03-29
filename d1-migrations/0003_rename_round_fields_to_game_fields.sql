-- Align persisted D1 schema terminology with the canonical model:
-- matches contain games, not rounds.

ALTER TABLE player_stats RENAME COLUMN games_played TO matches_played;
ALTER TABLE player_stats RENAME COLUMN rounds_played TO games_played;
ALTER TABLE player_stats RENAME COLUMN coherent_rounds TO coherent_games;

ALTER TABLE matches RENAME COLUMN round_count TO game_count;

ALTER TABLE vote_logs RENAME COLUMN round_number TO game_number;
ALTER TABLE vote_logs RENAME COLUMN won_round TO won_game;
ALTER TABLE vote_logs RENAME COLUMN round_payout TO game_payout;

ALTER TABLE question_ratings RENAME COLUMN round_number TO game_number;

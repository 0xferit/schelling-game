import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AccountWithStats,
  AuthChallengeRow,
  CreateChallengeParams,
  CreateMatchParams,
  AddMatchPlayerParams,
  UpdateMatchPlayerParams,
  VoteLogEntry,
  VoteLogRow,
  UpdatePlayerStatsParams,
  LeaderboardEntry,
  PlayerRankEntry,
  PlayerStatsRow,
} from './types/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'schelling.db');

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema(): void {
  db!.exec(`
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
  `);
}

// ---------------------------------------------------------------------------
// Auth challenge queries
// ---------------------------------------------------------------------------

function createChallenge({ challengeId, walletAddress, message, nonce, expiresAt }: CreateChallengeParams): void {
  getDb().prepare(`
    INSERT INTO auth_challenges (challenge_id, wallet_address, message, nonce, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(challengeId, walletAddress, message, nonce, expiresAt);
}

function getChallenge(challengeId: string): AuthChallengeRow | null {
  const row = getDb().prepare(
    'SELECT * FROM auth_challenges WHERE challenge_id = ?'
  ).get(challengeId) as AuthChallengeRow | undefined;
  if (!row) return null;
  if (row.used) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

function markChallengeUsed(challengeId: string): void {
  getDb().prepare(
    'UPDATE auth_challenges SET used = 1 WHERE challenge_id = ?'
  ).run(challengeId);
}

// ---------------------------------------------------------------------------
// Account queries
// ---------------------------------------------------------------------------

function upsertAccount(accountId: string): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO accounts (account_id) VALUES (?)
    ON CONFLICT(account_id) DO NOTHING
  `).run(accountId);
  d.prepare(`
    INSERT INTO player_stats (account_id) VALUES (?)
    ON CONFLICT(account_id) DO NOTHING
  `).run(accountId);
}

function getAccount(accountId: string): AccountWithStats | undefined {
  return getDb().prepare(`
    SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds,
           s.current_streak, s.longest_streak
    FROM accounts a
    LEFT JOIN player_stats s ON a.account_id = s.account_id
    WHERE a.account_id = ?
  `).get(accountId) as AccountWithStats | undefined;
}

function setDisplayName(accountId: string, displayName: string): void {
  const d = getDb();
  const existing = d.prepare(
    'SELECT account_id FROM accounts WHERE display_name = ? AND account_id != ?'
  ).get(displayName, accountId) as { account_id: string } | undefined;
  if (existing) {
    throw new Error(`Display name "${displayName}" is already taken`);
  }
  d.prepare(
    'UPDATE accounts SET display_name = ? WHERE account_id = ?'
  ).run(displayName, accountId);
}

function getAccountByDisplayName(displayName: string): AccountWithStats | undefined {
  return getDb().prepare(`
    SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds,
           s.current_streak, s.longest_streak
    FROM accounts a
    LEFT JOIN player_stats s ON a.account_id = s.account_id
    WHERE a.display_name = ?
  `).get(displayName) as AccountWithStats | undefined;
}

function updateBalance(accountId: string, delta: number): void {
  getDb().prepare(
    'UPDATE accounts SET token_balance = token_balance + ? WHERE account_id = ?'
  ).run(delta, accountId);
}

// ---------------------------------------------------------------------------
// Match queries
// ---------------------------------------------------------------------------

function createMatch({ matchId, playerCount }: CreateMatchParams): void {
  getDb().prepare(`
    INSERT INTO matches (match_id, player_count) VALUES (?, ?)
  `).run(matchId, playerCount);
}

function addMatchPlayer({ matchId, accountId, displayNameSnapshot, startingBalance }: AddMatchPlayerParams): void {
  getDb().prepare(`
    INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance)
    VALUES (?, ?, ?, ?)
  `).run(matchId, accountId, displayNameSnapshot, startingBalance);
}

function updateMatchPlayer({ matchId, accountId, endingBalance, netDelta, result }: UpdateMatchPlayerParams): void {
  getDb().prepare(`
    UPDATE match_players
    SET ending_balance = ?, net_delta = ?, result = ?
    WHERE match_id = ? AND account_id = ?
  `).run(endingBalance, netDelta, result, matchId, accountId);
}

function endMatch(matchId: string): void {
  getDb().prepare(`
    UPDATE matches SET ended_at = datetime('now'), status = 'completed'
    WHERE match_id = ?
  `).run(matchId);
}

// ---------------------------------------------------------------------------
// Vote log queries
// ---------------------------------------------------------------------------

function insertVoteLog(entry: VoteLogEntry): void {
  getDb().prepare(`
    INSERT INTO vote_logs
      (match_id, round_number, question_id, account_id, display_name_snapshot,
       revealed_option_index, revealed_option_label, won_round, earns_coordination_credit,
       ante_amount, round_payout, net_delta, player_count, valid_reveal_count,
       top_count, winner_count, winning_option_indexes_json, voided, void_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.matchId,
    entry.roundNumber,
    entry.questionId,
    entry.accountId,
    entry.displayNameSnapshot,
    entry.revealedOptionIndex ?? null,
    entry.revealedOptionLabel ?? null,
    entry.wonRound ? 1 : 0,
    entry.earnsCoordinationCredit ? 1 : 0,
    entry.anteAmount ?? 60,
    entry.roundPayout ?? 0,
    entry.netDelta ?? 0,
    entry.playerCount,
    entry.validRevealCount ?? null,
    entry.topCount ?? null,
    entry.winnerCount ?? null,
    entry.winningOptionIndexesJson ?? null,
    entry.voided ? 1 : 0,
    entry.voidReason ?? null,
  );
}

function getAllVoteLogs(): VoteLogRow[] {
  return getDb().prepare('SELECT * FROM vote_logs ORDER BY id ASC').all() as VoteLogRow[];
}

// ---------------------------------------------------------------------------
// Player stats
// ---------------------------------------------------------------------------

function updatePlayerStats(accountId: string, { roundsPlayed, coherentRounds, isGameEnd, wonRound, earnsCoordinationCredit }: UpdatePlayerStatsParams): void {
  const d = getDb();

  const stats = d.prepare('SELECT * FROM player_stats WHERE account_id = ?').get(accountId) as PlayerStatsRow | undefined;
  if (!stats) return;

  let newStreak = stats.current_streak;

  if (earnsCoordinationCredit) {
    // Coordination credit: increment streak
    newStreak = stats.current_streak + 1;
  } else if (wonRound) {
    // Won round but topCount was 1 (no coordination credit): break streak
    newStreak = 0;
  } else {
    // Lost round: break streak
    newStreak = 0;
  }

  const longestStreak = Math.max(stats.longest_streak, newStreak);

  const gamesIncrement = isGameEnd ? 1 : 0;

  d.prepare(`
    UPDATE player_stats SET
      games_played    = games_played + ?,
      rounds_played   = rounds_played + ?,
      coherent_rounds = coherent_rounds + ?,
      current_streak  = ?,
      longest_streak  = ?
    WHERE account_id = ?
  `).run(
    gamesIncrement,
    roundsPlayed ?? 0,
    coherentRounds ?? 0,
    newStreak,
    longestStreak,
    accountId,
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function getLeaderboard(limit: number = 50): LeaderboardEntry[] {
  return getDb().prepare(`
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY a.token_balance DESC, s.coherent_rounds DESC, a.display_name ASC
      ) AS rank,
      a.display_name AS displayName,
      a.token_balance AS tokenBalance,
      a.leaderboard_eligible AS leaderboardEligible,
      s.games_played AS gamesPlayed,
      s.rounds_played AS roundsPlayed,
      s.coherent_rounds AS coherentRounds,
      CASE WHEN s.rounds_played > 0
        THEN ROUND(100.0 * s.coherent_rounds / s.rounds_played, 1)
        ELSE 0
      END AS coherentPct,
      s.current_streak AS currentStreak,
      s.longest_streak AS longestStreak,
      CASE WHEN s.games_played > 0
        THEN ROUND(1.0 * a.token_balance / s.games_played, 1)
        ELSE 0
      END AS avgNetTokensPerGame
    FROM accounts a
    JOIN player_stats s ON a.account_id = s.account_id
    WHERE a.leaderboard_eligible = 1
    ORDER BY a.token_balance DESC, s.coherent_rounds DESC, a.display_name ASC
    LIMIT ?
  `).all(limit) as LeaderboardEntry[];
}

function getPlayerRank(accountId: string): PlayerRankEntry | null {
  const d = getDb();

  const row = d.prepare(`
    SELECT
      a.account_id,
      a.display_name AS displayName,
      a.token_balance AS tokenBalance,
      a.leaderboard_eligible AS leaderboardEligible,
      s.games_played AS gamesPlayed,
      s.rounds_played AS roundsPlayed,
      s.coherent_rounds AS coherentRounds,
      CASE WHEN s.rounds_played > 0
        THEN ROUND(100.0 * s.coherent_rounds / s.rounds_played, 1)
        ELSE 0
      END AS coherentPct,
      s.current_streak AS currentStreak,
      s.longest_streak AS longestStreak,
      CASE WHEN s.games_played > 0
        THEN ROUND(1.0 * a.token_balance / s.games_played, 1)
        ELSE 0
      END AS avgNetTokensPerGame
    FROM accounts a
    JOIN player_stats s ON a.account_id = s.account_id
    WHERE a.account_id = ?
  `).get(accountId) as PlayerRankEntry | undefined;

  if (!row) return null;

  const rank = (d.prepare(`
    SELECT COUNT(*) + 1 AS rank
    FROM accounts a2
    JOIN player_stats s2 ON a2.account_id = s2.account_id
    WHERE a2.leaderboard_eligible = 1
      AND (
        a2.token_balance > ?
        OR (a2.token_balance = ? AND s2.coherent_rounds > ?)
        OR (a2.token_balance = ? AND s2.coherent_rounds = ? AND a2.display_name < ?)
      )
  `).get(
    row.tokenBalance,
    row.tokenBalance, row.coherentRounds,
    row.tokenBalance, row.coherentRounds, row.displayName ?? '',
  ) as { rank: number }).rank;

  return { ...row, rank };
}

// ---------------------------------------------------------------------------
// Leaderboard eligibility
// ---------------------------------------------------------------------------

function setLeaderboardEligible(accountId: string, eligible: boolean): void {
  getDb().prepare(
    'UPDATE accounts SET leaderboard_eligible = ? WHERE account_id = ?'
  ).run(eligible ? 1 : 0, accountId);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default {
  getDb,
  createChallenge,
  getChallenge,
  markChallengeUsed,
  upsertAccount,
  getAccount,
  setDisplayName,
  getAccountByDisplayName,
  updateBalance,
  createMatch,
  addMatchPlayer,
  updateMatchPlayer,
  endMatch,
  insertVoteLog,
  getAllVoteLogs,
  updatePlayerStats,
  getLeaderboard,
  getPlayerRank,
  setLeaderboardEligible,
};

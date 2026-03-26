// DO SQLite checkpoint persistence for GameRoom match state.
// All functions take a SqlStorage instance as their first argument
// so they can be called from the GameRoom class without coupling.

import type { Question } from '../types/domain';

// Matches the WorkerMatchState interface in worker.ts but only the
// serializable fields needed for checkpointing.
export interface CheckpointableMatch {
  matchId: string;
  phase: string;
  currentRound: number;
  totalRounds: number;
  questions: Question[];
  phaseEnteredAt: number;
  lastSettledRound: number;
  players: Map<
    string,
    {
      accountId: string;
      displayName: string;
      startingBalance: number;
      currentBalance: number;
      committed: boolean;
      revealed: boolean;
      hash: string | null;
      optionIndex: number | null;
      salt: string | null;
      forfeited: boolean;
      disconnectedAt: number | null;
    }
  >;
}

export interface RestoredPlayer {
  accountId: string;
  displayName: string;
  startingBalance: number;
  currentBalance: number;
  committed: boolean;
  revealed: boolean;
  hash: string | null;
  optionIndex: number | null;
  salt: string | null;
  forfeited: boolean;
  disconnectedAt: number | null;
}

export interface RestoredMatch {
  matchId: string;
  phase: string;
  currentRound: number;
  totalRounds: number;
  questions: Question[];
  phaseEnteredAt: number;
  lastSettledRound: number;
  players: Map<string, RestoredPlayer>;
}

export type PlayerActionFields = Partial<{
  committed: boolean;
  revealed: boolean;
  hash: string | null;
  optionIndex: number | null;
  salt: string | null;
  forfeited: boolean;
  currentBalance: number;
  disconnectedAt: number | null;
}>;

interface SqlStorage {
  exec(
    query: string,
    ...params: unknown[]
  ): { toArray(): unknown[] } & Iterable<Record<string, unknown>>;
}

export function initCheckpointTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS match_checkpoints (
      match_id        TEXT PRIMARY KEY,
      phase           TEXT NOT NULL,
      current_round   INTEGER NOT NULL,
      total_rounds    INTEGER NOT NULL,
      questions_json  TEXT NOT NULL,
      phase_entered_at INTEGER NOT NULL,
      last_settled_round INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS player_checkpoints (
      match_id         TEXT NOT NULL,
      account_id       TEXT NOT NULL,
      display_name     TEXT NOT NULL,
      starting_balance INTEGER NOT NULL,
      current_balance  INTEGER NOT NULL,
      committed        INTEGER NOT NULL DEFAULT 0,
      revealed         INTEGER NOT NULL DEFAULT 0,
      hash             TEXT,
      option_index     INTEGER,
      salt             TEXT,
      forfeited        INTEGER NOT NULL DEFAULT 0,
      disconnected_at  INTEGER,
      PRIMARY KEY (match_id, account_id)
    )
  `);
}

export function checkpointMatch(
  sql: SqlStorage,
  match: CheckpointableMatch,
): void {
  sql.exec('BEGIN');
  try {
    sql.exec(
      `DELETE FROM player_checkpoints WHERE match_id = ?`,
      match.matchId,
    );
    sql.exec(
      `INSERT OR REPLACE INTO match_checkpoints
        (match_id, phase, current_round, total_rounds, questions_json, phase_entered_at, last_settled_round, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      match.matchId,
      match.phase,
      match.currentRound,
      match.totalRounds,
      JSON.stringify(match.questions),
      match.phaseEnteredAt,
      match.lastSettledRound,
      Date.now(),
    );
    for (const p of match.players.values()) {
      sql.exec(
        `INSERT INTO player_checkpoints
          (match_id, account_id, display_name, starting_balance, current_balance,
           committed, revealed, hash, option_index, salt, forfeited, disconnected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        match.matchId,
        p.accountId,
        p.displayName,
        p.startingBalance,
        p.currentBalance,
        p.committed ? 1 : 0,
        p.revealed ? 1 : 0,
        p.hash,
        p.optionIndex,
        p.salt,
        p.forfeited ? 1 : 0,
        p.disconnectedAt,
      );
    }
    sql.exec('COMMIT');
  } catch (err) {
    try {
      sql.exec('ROLLBACK');
    } catch {}
    console.error('DO storage: checkpoint failed for', match.matchId, err);
  }
}

export function checkpointPlayerAction(
  sql: SqlStorage,
  matchId: string,
  accountId: string,
  fields: PlayerActionFields,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.committed !== undefined) {
    sets.push('committed = ?');
    vals.push(fields.committed ? 1 : 0);
  }
  if (fields.revealed !== undefined) {
    sets.push('revealed = ?');
    vals.push(fields.revealed ? 1 : 0);
  }
  if (fields.hash !== undefined) {
    sets.push('hash = ?');
    vals.push(fields.hash);
  }
  if (fields.optionIndex !== undefined) {
    sets.push('option_index = ?');
    vals.push(fields.optionIndex);
  }
  if (fields.salt !== undefined) {
    sets.push('salt = ?');
    vals.push(fields.salt);
  }
  if (fields.forfeited !== undefined) {
    sets.push('forfeited = ?');
    vals.push(fields.forfeited ? 1 : 0);
  }
  if (fields.currentBalance !== undefined) {
    sets.push('current_balance = ?');
    vals.push(fields.currentBalance);
  }
  if (fields.disconnectedAt !== undefined) {
    sets.push('disconnected_at = ?');
    vals.push(fields.disconnectedAt);
  }
  if (sets.length === 0) return;
  vals.push(matchId, accountId);
  sql.exec(
    `UPDATE player_checkpoints SET ${sets.join(', ')} WHERE match_id = ? AND account_id = ?`,
    ...vals,
  );
}

export function deleteMatchCheckpoint(sql: SqlStorage, matchId: string): void {
  sql.exec(`DELETE FROM player_checkpoints WHERE match_id = ?`, matchId);
  sql.exec(`DELETE FROM match_checkpoints WHERE match_id = ?`, matchId);
}

export function restoreMatchesFromStorage(
  sql: SqlStorage,
  staleThresholdMs: number,
): RestoredMatch[] {
  const now = Date.now();
  const rows = [
    ...sql.exec(`SELECT * FROM match_checkpoints WHERE phase != 'ended'`),
  ];

  const restored: RestoredMatch[] = [];

  for (const row of rows) {
    const phaseEnteredAt = row.phase_entered_at as number;

    if (now - phaseEnteredAt > staleThresholdMs) {
      deleteMatchCheckpoint(sql, row.match_id as string);
      continue;
    }

    try {
      const playerRows = [
        ...sql.exec(
          `SELECT * FROM player_checkpoints WHERE match_id = ?`,
          row.match_id as string,
        ),
      ];

      const players = new Map<string, RestoredPlayer>();

      for (const pr of playerRows) {
        const accountId = pr.account_id as string;
        players.set(accountId, {
          accountId,
          displayName: pr.display_name as string,
          startingBalance: pr.starting_balance as number,
          currentBalance: pr.current_balance as number,
          committed: !!(pr.committed as number),
          revealed: !!(pr.revealed as number),
          hash: pr.hash as string | null,
          optionIndex: pr.option_index as number | null,
          salt: pr.salt as string | null,
          forfeited: !!(pr.forfeited as number),
          disconnectedAt:
            (pr.disconnected_at as number | null) ?? phaseEnteredAt,
        });
      }

      restored.push({
        matchId: row.match_id as string,
        players,
        questions: JSON.parse(row.questions_json as string),
        currentRound: row.current_round as number,
        totalRounds: row.total_rounds as number,
        phase: row.phase as string,
        phaseEnteredAt,
        lastSettledRound: row.last_settled_round as number,
      });
    } catch (err) {
      console.error('DO storage: failed to restore match', row.match_id, err);
      deleteMatchCheckpoint(sql, row.match_id as string);
    }
  }

  return restored;
}

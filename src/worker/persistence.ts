// DO SQLite checkpoint persistence for GameRoom match state.
// All functions take a SqlStorage instance as their first argument
// so they can be called from the GameRoom class without coupling.

import type { SchellingPrompt } from '../types/domain';
import type { GameResultMessage } from '../types/messages';

// ---------------------------------------------------------------------------
// Persisted state: single source of truth for checkpointable fields.
// worker.ts extends these with runtime-only fields (ws, timers).
// ---------------------------------------------------------------------------

export interface PersistedPlayerState {
  accountId: string;
  displayName: string;
  startingBalance: number;
  currentBalance: number;
  committed: boolean;
  revealed: boolean;
  hash: string | null;
  optionIndex: number | null;
  answerText: string | null;
  normalizedRevealText: string | null;
  salt: string | null;
  forfeited: boolean;
  forfeitedAtGame: number | null;
  disconnectedAt: number | null;
}

export interface PersistedMatchFields {
  matchId: string;
  phase: string;
  currentGame: number;
  totalGames: number;
  prompts: SchellingPrompt[];
  phaseEnteredAt: number;
  lastSettledGame: number;
  lastGameResult: GameResultMessage['result'] | null;
  aiAssisted: boolean;
}

export interface CheckpointableMatch extends PersistedMatchFields {
  players: Map<string, PersistedPlayerState>;
}

export type RestoredMatch = CheckpointableMatch;

export type PlayerActionFields = Partial<
  Pick<
    PersistedPlayerState,
    | 'committed'
    | 'revealed'
    | 'hash'
    | 'optionIndex'
    | 'answerText'
    | 'normalizedRevealText'
    | 'salt'
    | 'forfeited'
    | 'forfeitedAtGame'
    | 'currentBalance'
    | 'disconnectedAt'
  >
>;

interface SqlStorage {
  exec(
    query: string,
    ...params: unknown[]
  ): { toArray(): unknown[] } & Iterable<Record<string, unknown>>;
}

function getColumnNames(sql: SqlStorage, tableName: string): Set<string> {
  return new Set(
    [...sql.exec(`PRAGMA table_info(${tableName})`)].map(
      (column) => (column as Record<string, unknown>).name as string,
    ),
  );
}

function renameColumnIfNeeded(
  sql: SqlStorage,
  tableName: string,
  oldName: string,
  newName: string,
): void {
  const columns = getColumnNames(sql, tableName);
  if (!columns.has(oldName) || columns.has(newName)) return;
  sql.exec(`ALTER TABLE ${tableName} RENAME COLUMN ${oldName} TO ${newName}`);
}

export function initCheckpointTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS match_checkpoints (
      match_id        TEXT PRIMARY KEY,
      phase           TEXT NOT NULL,
      current_game    INTEGER NOT NULL,
      total_games     INTEGER NOT NULL,
      prompts_json    TEXT NOT NULL,
      phase_entered_at INTEGER NOT NULL,
      last_settled_game INTEGER NOT NULL DEFAULT 0,
      last_game_result_json TEXT,
      ai_assisted     INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    )
  `);
  renameColumnIfNeeded(
    sql,
    'match_checkpoints',
    'current_round',
    'current_game',
  );
  renameColumnIfNeeded(sql, 'match_checkpoints', 'total_rounds', 'total_games');
  renameColumnIfNeeded(
    sql,
    'match_checkpoints',
    'last_settled_round',
    'last_settled_game',
  );
  renameColumnIfNeeded(
    sql,
    'match_checkpoints',
    'last_round_result_json',
    'last_game_result_json',
  );
  renameColumnIfNeeded(
    sql,
    'match_checkpoints',
    'questions_json',
    'prompts_json',
  );

  if (!getColumnNames(sql, 'match_checkpoints').has('last_game_result_json')) {
    sql.exec(
      'ALTER TABLE match_checkpoints ADD COLUMN last_game_result_json TEXT',
    );
  }
  if (!getColumnNames(sql, 'match_checkpoints').has('ai_assisted')) {
    sql.exec(
      'ALTER TABLE match_checkpoints ADD COLUMN ai_assisted INTEGER NOT NULL DEFAULT 0',
    );
  }

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
      answer_text      TEXT,
      normalized_reveal_text TEXT,
      salt             TEXT,
      forfeited        INTEGER NOT NULL DEFAULT 0,
      forfeited_at_game INTEGER,
      disconnected_at  INTEGER,
      PRIMARY KEY (match_id, account_id)
    )
  `);
  renameColumnIfNeeded(
    sql,
    'player_checkpoints',
    'forfeited_at_round',
    'forfeited_at_game',
  );

  if (!getColumnNames(sql, 'match_checkpoints').has('ai_assisted')) {
    sql.exec(
      'ALTER TABLE match_checkpoints ADD COLUMN ai_assisted INTEGER NOT NULL DEFAULT 0',
    );
  }

  if (!getColumnNames(sql, 'player_checkpoints').has('forfeited_at_game')) {
    sql.exec(
      'ALTER TABLE player_checkpoints ADD COLUMN forfeited_at_game INTEGER',
    );
  }
  if (!getColumnNames(sql, 'player_checkpoints').has('answer_text')) {
    sql.exec('ALTER TABLE player_checkpoints ADD COLUMN answer_text TEXT');
  }
  if (
    !getColumnNames(sql, 'player_checkpoints').has('normalized_reveal_text')
  ) {
    sql.exec(
      'ALTER TABLE player_checkpoints ADD COLUMN normalized_reveal_text TEXT',
    );
  }
}

export function checkpointMatch(
  sql: SqlStorage,
  match: CheckpointableMatch,
): void {
  // DO storage auto-coalesces writes within a single JS turn, so explicit
  // transactions are unnecessary. Durable Objects forbid raw BEGIN/COMMIT
  // statements; use the JS transactionSync() API if atomicity is needed.
  try {
    sql.exec(
      `DELETE FROM player_checkpoints WHERE match_id = ?`,
      match.matchId,
    );
    sql.exec(
      `INSERT OR REPLACE INTO match_checkpoints
        (match_id, phase, current_game, total_games, prompts_json, phase_entered_at, last_settled_game, last_game_result_json, ai_assisted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      match.matchId,
      match.phase,
      match.currentGame,
      match.totalGames,
      JSON.stringify(match.prompts),
      match.phaseEnteredAt,
      match.lastSettledGame,
      match.lastGameResult ? JSON.stringify(match.lastGameResult) : null,
      match.aiAssisted ? 1 : 0,
      Date.now(),
    );
    for (const p of match.players.values()) {
      sql.exec(
        `INSERT INTO player_checkpoints
          (match_id, account_id, display_name, starting_balance, current_balance,
           committed, revealed, hash, option_index, answer_text, normalized_reveal_text, salt, forfeited, forfeited_at_game, disconnected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        match.matchId,
        p.accountId,
        p.displayName,
        p.startingBalance,
        p.currentBalance,
        p.committed ? 1 : 0,
        p.revealed ? 1 : 0,
        p.hash,
        p.optionIndex,
        p.answerText,
        p.normalizedRevealText,
        p.salt,
        p.forfeited ? 1 : 0,
        p.forfeitedAtGame,
        p.disconnectedAt,
      );
    }
  } catch (err) {
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
  if (fields.answerText !== undefined) {
    sets.push('answer_text = ?');
    vals.push(fields.answerText);
  }
  if (fields.normalizedRevealText !== undefined) {
    sets.push('normalized_reveal_text = ?');
    vals.push(fields.normalizedRevealText);
  }
  if (fields.salt !== undefined) {
    sets.push('salt = ?');
    vals.push(fields.salt);
  }
  if (fields.forfeited !== undefined) {
    sets.push('forfeited = ?');
    vals.push(fields.forfeited ? 1 : 0);
  }
  if (fields.forfeitedAtGame !== undefined) {
    sets.push('forfeited_at_game = ?');
    vals.push(fields.forfeitedAtGame);
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

      const players = new Map<string, PersistedPlayerState>();
      const currentGame =
        (row.current_game as number | undefined) ??
        (row.current_round as number);
      const totalGames =
        (row.total_games as number | undefined) ?? (row.total_rounds as number);
      const lastSettledGame =
        (row.last_settled_game as number | undefined) ??
        (row.last_settled_round as number);

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
          answerText: pr.answer_text as string | null,
          normalizedRevealText: pr.normalized_reveal_text as string | null,
          salt: pr.salt as string | null,
          forfeited: !!(pr.forfeited as number),
          forfeitedAtGame:
            (pr.forfeited_at_game as number | null) ??
            (pr.forfeited_at_round as number | null) ??
            ((pr.forfeited as number) ? currentGame - 1 : null),
          disconnectedAt: (pr.disconnected_at as number | null) ?? now,
        });
      }

      const lastGameResultRaw =
        (row.last_game_result_json as string | null) ??
        (row.last_round_result_json as string | null);

      restored.push({
        matchId: row.match_id as string,
        players,
        prompts: JSON.parse(
          ((row.prompts_json as string | null) ??
            (row.questions_json as string | null)) as string,
        ),
        currentGame,
        totalGames,
        phase: row.phase as string,
        phaseEnteredAt,
        lastSettledGame,
        lastGameResult: lastGameResultRaw
          ? JSON.parse(lastGameResultRaw)
          : null,
        aiAssisted: !!(row.ai_assisted as number),
      });
    } catch (err) {
      console.error('DO storage: failed to restore match', row.match_id, err);
      deleteMatchCheckpoint(sql, row.match_id as string);
    }
  }

  return restored;
}

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

interface CheckpointStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

type SqlRow = Record<string, unknown>;

function isRecord(value: unknown): value is SqlRow {
  return typeof value === 'object' && value !== null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function readString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Invalid checkpoint data: ${key} must be a string`);
  }
  return value;
}

function readNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`Invalid checkpoint data: ${key} must be a string or null`);
  }
  return value;
}

function readNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (!isSafeInteger(value)) {
    throw new Error(`Invalid checkpoint data: ${key} must be a safe integer`);
  }
  return value;
}

function readNumberField(
  row: SqlRow,
  primaryKey: string,
  fallbackKey?: string,
): number {
  const primaryValue = row[primaryKey];
  if (isSafeInteger(primaryValue)) return primaryValue;
  if (fallbackKey) {
    const fallbackValue = row[fallbackKey];
    if (isSafeInteger(fallbackValue)) return fallbackValue;
  }
  throw new Error(
    `Invalid checkpoint data: expected ${primaryKey}${fallbackKey ? ` or ${fallbackKey}` : ''}`,
  );
}

function readNullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (!isSafeInteger(value)) {
    throw new Error(
      `Invalid checkpoint data: ${key} must be a safe integer or null`,
    );
  }
  return value;
}

function readBooleanLike(row: SqlRow, key: string): boolean {
  const value = row[key];
  if (value === 0 || value === 1) return value === 1;
  if (value === false || value === true) return value;
  throw new Error(
    `Invalid checkpoint data: ${key} must be 0, 1, false, or true`,
  );
}

function readOptionalBooleanLike(row: SqlRow, key: string): boolean {
  const value = row[key];
  if (value === null || value === undefined) return false;
  return readBooleanLike(row, key);
}

function readStringField(
  row: SqlRow,
  primaryKey: string,
  fallbackKey?: string,
): string {
  const primaryValue = row[primaryKey];
  if (typeof primaryValue === 'string') return primaryValue;
  if (fallbackKey) {
    const fallbackValue = row[fallbackKey];
    if (typeof fallbackValue === 'string') return fallbackValue;
  }
  throw new Error(
    `Invalid checkpoint data: expected ${primaryKey}${fallbackKey ? ` or ${fallbackKey}` : ''}`,
  );
}

function readNullableStringField(
  row: SqlRow,
  primaryKey: string,
  fallbackKey?: string,
): string | null {
  const primaryValue = row[primaryKey];
  if (primaryValue === null || primaryValue === undefined) return null;
  if (typeof primaryValue === 'string') return primaryValue;
  if (fallbackKey) {
    const fallbackValue = row[fallbackKey];
    if (fallbackValue === null || fallbackValue === undefined) return null;
    if (typeof fallbackValue === 'string') return fallbackValue;
  }
  throw new Error(
    `Invalid checkpoint data: expected ${primaryKey}${fallbackKey ? ` or ${fallbackKey}` : ''}`,
  );
}

function parseJsonField<T>(
  raw: string,
  label: string,
  validate: (value: unknown) => value is T,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid checkpoint data: ${label} is not valid JSON`);
  }
  if (!validate(parsed)) {
    throw new Error(`Invalid checkpoint data: ${label} has unexpected shape`);
  }
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isSchellingPrompt(value: unknown): value is SchellingPrompt {
  if (!isRecord(value)) return false;
  if (!isSafeInteger(value.id) || typeof value.text !== 'string') return false;
  if (typeof value.category !== 'string' || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'select') {
    return isStringArray(value.options) && value.options.length > 0;
  }
  if (value.type === 'open_text') {
    return (
      isSafeInteger(value.maxLength) &&
      value.maxLength > 0 &&
      typeof value.placeholder === 'string'
    );
  }
  return false;
}

function isSchellingPromptArray(value: unknown): value is SchellingPrompt[] {
  return Array.isArray(value) && value.every(isSchellingPrompt);
}

function isMatchPhase(value: unknown): value is PersistedMatchFields['phase'] {
  return (
    value === 'commit' ||
    value === 'reveal' ||
    value === 'normalizing' ||
    value === 'results' ||
    value === 'settling' ||
    value === 'ending'
  );
}

function isGameResultPlayer(
  value: unknown,
): value is GameResultMessage['result']['players'][number] {
  if (!isRecord(value)) return false;
  return (
    typeof value.accountId === 'string' &&
    typeof value.displayName === 'string' &&
    (value.revealedOptionIndex === null ||
      isSafeInteger(value.revealedOptionIndex)) &&
    (value.revealedOptionLabel === null ||
      typeof value.revealedOptionLabel === 'string') &&
    (value.revealedInputText === null ||
      typeof value.revealedInputText === 'string') &&
    (value.revealedBucketKey === null ||
      typeof value.revealedBucketKey === 'string') &&
    (value.revealedBucketLabel === null ||
      typeof value.revealedBucketLabel === 'string') &&
    typeof value.wonGame === 'boolean' &&
    typeof value.earnsCoordinationCredit === 'boolean' &&
    isSafeInteger(value.antePaid) &&
    isSafeInteger(value.gamePayout) &&
    isSafeInteger(value.netDelta) &&
    isSafeInteger(value.newBalance)
  );
}

function isGameResult(value: unknown): value is GameResultMessage['result'] {
  if (!isRecord(value)) return false;
  return (
    typeof value.voided === 'boolean' &&
    (value.voidReason === null || typeof value.voidReason === 'string') &&
    isSafeInteger(value.playerCount) &&
    isSafeInteger(value.pot) &&
    isSafeInteger(value.dustBurned) &&
    isSafeInteger(value.validRevealCount) &&
    isSafeInteger(value.topCount) &&
    Array.isArray(value.winningOptionIndexes) &&
    value.winningOptionIndexes.every(isSafeInteger) &&
    Array.isArray(value.winningBucketKeys) &&
    value.winningBucketKeys.every((item) => typeof item === 'string') &&
    isSafeInteger(value.winnerCount) &&
    isSafeInteger(value.payoutPerWinner) &&
    (value.normalizationMode === null ||
      value.normalizationMode === 'llm' ||
      value.normalizationMode === 'fallback_exact') &&
    Array.isArray(value.players) &&
    value.players.every(isGameResultPlayer)
  );
}

function readMatchRow(row: SqlRow): {
  matchId: string;
  phase: string;
  currentGame: number;
  totalGames: number;
  prompts: SchellingPrompt[];
  phaseEnteredAt: number;
  lastSettledGame: number;
  lastGameResult: GameResultMessage['result'] | null;
  aiAssisted: boolean;
} {
  const matchId = readString(row, 'match_id');
  const phase = readString(row, 'phase');
  if (!isMatchPhase(phase)) {
    throw new Error(
      `Invalid checkpoint data: phase must be commit, reveal, normalizing, results, settling, or ending`,
    );
  }
  const currentGame = readNumberField(row, 'current_game', 'current_round');
  const totalGames = readNumberField(row, 'total_games', 'total_rounds');
  const phaseEnteredAt = readNumber(row, 'phase_entered_at');
  const lastSettledGame = readNumberField(
    row,
    'last_settled_game',
    'last_settled_round',
  );
  const promptsJson = readStringField(row, 'prompts_json', 'questions_json');
  const lastGameResultJson = readNullableStringField(
    row,
    'last_game_result_json',
    'last_round_result_json',
  );
  const aiAssisted = readOptionalBooleanLike(row, 'ai_assisted');

  return {
    matchId,
    phase,
    currentGame,
    totalGames,
    prompts: parseJsonField(
      promptsJson,
      'prompts_json',
      isSchellingPromptArray,
    ),
    phaseEnteredAt,
    lastSettledGame,
    lastGameResult: lastGameResultJson
      ? parseJsonField(
          lastGameResultJson,
          'last_game_result_json',
          isGameResult,
        )
      : null,
    aiAssisted,
  };
}

function readPlayerRow(
  row: SqlRow,
  currentGame: number,
  now: number,
): PersistedPlayerState {
  return {
    accountId: readString(row, 'account_id'),
    displayName: readString(row, 'display_name'),
    startingBalance: readNumber(row, 'starting_balance'),
    currentBalance: readNumber(row, 'current_balance'),
    committed: readBooleanLike(row, 'committed'),
    revealed: readBooleanLike(row, 'revealed'),
    hash: readNullableString(row, 'hash'),
    optionIndex: readNullableNumber(row, 'option_index'),
    answerText: readNullableStringField(row, 'answer_text'),
    normalizedRevealText: readNullableStringField(
      row,
      'normalized_reveal_text',
    ),
    salt: readNullableString(row, 'salt'),
    forfeited: readBooleanLike(row, 'forfeited'),
    forfeitedAtGame:
      readNullableNumber(row, 'forfeited_at_game') ??
      readNullableNumber(row, 'forfeited_at_round') ??
      (readBooleanLike(row, 'forfeited') ? currentGame - 1 : null),
    disconnectedAt: readNullableNumber(row, 'disconnected_at') ?? now,
  };
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
  storage: CheckpointStorage,
  match: CheckpointableMatch,
): void {
  storage.transactionSync(() => {
    const { sql } = storage;
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
  });
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
    try {
      const matchRow = readMatchRow(row);

      if (now - matchRow.phaseEnteredAt > staleThresholdMs) {
        deleteMatchCheckpoint(sql, matchRow.matchId);
        continue;
      }

      const playerRows = [
        ...sql.exec(
          `SELECT * FROM player_checkpoints WHERE match_id = ?`,
          matchRow.matchId,
        ),
      ];

      const players = new Map<string, PersistedPlayerState>();
      for (const pr of playerRows) {
        const player = readPlayerRow(pr, matchRow.currentGame, now);
        players.set(player.accountId, player);
      }

      restored.push({
        matchId: matchRow.matchId,
        players,
        prompts: matchRow.prompts,
        currentGame: matchRow.currentGame,
        totalGames: matchRow.totalGames,
        phase: matchRow.phase,
        phaseEnteredAt: matchRow.phaseEnteredAt,
        lastSettledGame: matchRow.lastSettledGame,
        lastGameResult: matchRow.lastGameResult,
        aiAssisted: matchRow.aiAssisted,
      });
    } catch (err) {
      console.error('DO storage: failed to restore match', row.match_id, err);
      deleteMatchCheckpoint(sql, String(row.match_id));
    }
  }

  return restored;
}

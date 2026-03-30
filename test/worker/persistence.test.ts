import { describe, expect, it, vi } from 'vitest';
import {
  checkpointMatch,
  restoreMatchesFromStorage,
} from '../../src/worker/persistence';
import { must } from './helpers';

/**
 * Minimal mock of the SqlStorage interface used by persistence.ts.
 * Rows are returned from pre-configured query results.
 */
function createMockSql(
  matchRows: Record<string, unknown>[],
  playerRows: Record<string, unknown>[],
) {
  const exec = vi.fn((query: string, ...params: unknown[]) => {
    const results: Record<string, unknown>[] = [];

    if (query.includes('match_checkpoints')) {
      // Return all match rows for the SELECT query
      results.push(...matchRows);
    } else if (query.includes('player_checkpoints')) {
      const matchId = params[0] as string;
      results.push(...playerRows.filter((r) => r.match_id === matchId));
    }

    return {
      toArray: () => results,
      [Symbol.iterator]: function* () {
        yield* results;
      },
    };
  });

  return {
    exec,
    transactionSync: vi.fn((fn: () => unknown) => fn()),
  };
}

function createCheckpointMatch() {
  return {
    matchId: 'match-1',
    phase: 'results',
    currentGame: 2,
    totalGames: 10,
    prompts: [
      {
        id: 1,
        text: 'Choose one',
        type: 'select',
        category: 'culture',
        options: ['A', 'B'],
      },
    ],
    phaseEnteredAt: Date.now(),
    lastSettledGame: 1,
    lastGameResult: null,
    aiAssisted: false,
    players: new Map([
      [
        '0xplayer',
        {
          accountId: '0xplayer',
          displayName: 'Player',
          startingBalance: 1000,
          currentBalance: 980,
          committed: true,
          revealed: true,
          hash: 'abc',
          optionIndex: 0,
          answerText: null,
          normalizedRevealText: null,
          salt: 'b'.repeat(32),
          forfeited: false,
          forfeitedAtGame: null,
          disconnectedAt: null,
        },
      ],
    ]),
  };
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

describe('restoreMatchesFromStorage', () => {
  it('wraps checkpoint writes in transactionSync', () => {
    const exec = vi.fn((query: string) => {
      if (query.includes('INSERT INTO player_checkpoints')) {
        throw new Error('write failed');
      }
      return {
        toArray: () => [],
        [Symbol.iterator]: function* () {
          yield* [];
        },
      };
    });
    const transactionSync = vi.fn((fn: () => unknown) => fn());
    const storage = {
      sql: {
        exec,
      },
      transactionSync,
    };

    expect(() =>
      checkpointMatch(storage as never, createCheckpointMatch() as never),
    ).toThrow('write failed');
    expect(transactionSync).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toContain('DELETE FROM player_checkpoints');
  });

  it('drops malformed checkpoints instead of restoring them', () => {
    const matchRows = [
      {
        match_id: 'match-bad',
        phase: 'commit',
        current_game: 1,
        total_games: 10,
        prompts_json: '{"id":1,"text":"bad"}',
        phase_entered_at: Date.now(),
        last_settled_game: 0,
      },
    ];
    const sql = createMockSql(matchRows, []);

    const restored = restoreMatchesFromStorage(sql, STALE_THRESHOLD_MS);

    expect(restored).toHaveLength(0);
    expect(
      sql.exec.mock.calls.some(([query]) =>
        String(query).includes(
          'DELETE FROM match_checkpoints WHERE match_id = ?',
        ),
      ),
    ).toBe(true);
  });

  it('drops malformed player checkpoints instead of restoring them', () => {
    const matchRows = [
      {
        match_id: 'match-1',
        phase: 'commit',
        current_game: 1,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 1,
            text: 'Test',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: Date.now(),
        last_settled_game: 0,
      },
    ];
    const playerRows = [
      {
        match_id: 'match-1',
        account_id: '0xplayer',
        display_name: 'Player',
        starting_balance: 'bad',
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        answer_text: null,
        normalized_reveal_text: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
    ];
    const sql = createMockSql(matchRows, playerRows);

    const restored = restoreMatchesFromStorage(sql, STALE_THRESHOLD_MS);

    expect(restored).toHaveLength(0);
    expect(
      sql.exec.mock.calls.some(([query]) =>
        String(query).includes(
          'DELETE FROM match_checkpoints WHERE match_id = ?',
        ),
      ),
    ).toBe(true);
  });

  it('restores legacy checkpoints that still use questions_json', () => {
    const matchRows = [
      {
        match_id: 'match-legacy',
        phase: 'commit',
        current_game: 2,
        total_games: 10,
        questions_json: JSON.stringify([
          {
            id: 1,
            text: 'Legacy prompt',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: Date.now(),
        last_settled_game: 1,
      },
    ];

    const playerRows = [
      {
        match_id: 'match-legacy',
        account_id: '0xlegacy',
        display_name: 'Legacy',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
    ];

    const restored = restoreMatchesFromStorage(
      createMockSql(matchRows, playerRows),
      STALE_THRESHOLD_MS,
    );

    const match = must(restored[0], 'Expected restored legacy match');
    expect(match.prompts).toHaveLength(1);
    expect(must(match.prompts[0], 'Expected restored legacy prompt').text).toBe(
      'Legacy prompt',
    );
  });

  it('restores in-flight settling and ending checkpoints', () => {
    const matchRows = [
      {
        match_id: 'match-settling',
        phase: 'settling',
        current_game: 3,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 1,
            text: 'Prompt',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: Date.now(),
        last_settled_game: 2,
      },
      {
        match_id: 'match-ending',
        phase: 'ending',
        current_game: 10,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 2,
            text: 'Prompt',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: Date.now(),
        last_settled_game: 10,
      },
    ];

    const playerRows = [
      {
        match_id: 'match-settling',
        account_id: '0xsettling',
        display_name: 'Settling',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        answer_text: null,
        normalized_reveal_text: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
      {
        match_id: 'match-ending',
        account_id: '0xending',
        display_name: 'Ending',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        answer_text: null,
        normalized_reveal_text: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
    ];

    const restored = restoreMatchesFromStorage(
      createMockSql(matchRows, playerRows),
      STALE_THRESHOLD_MS,
    );

    expect(
      restored.find((match) => match.matchId === 'match-settling')?.phase,
    ).toBe('settling');
    expect(
      restored.find((match) => match.matchId === 'match-ending')?.phase,
    ).toBe('ending');
  });

  it('restores in-flight normalizing checkpoints', () => {
    const matchRows = [
      {
        match_id: 'match-normalizing',
        phase: 'normalizing',
        current_game: 4,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 1009,
            text: 'Pick a city.',
            type: 'open_text',
            category: 'culture',
            maxLength: 64,
            placeholder: 'e.g. New York',
            answerSpec: { kind: 'free_text' },
            aiNormalization: 'required',
            canonicalExamples: ['New York', 'NYC'],
          },
        ]),
        phase_entered_at: Date.now(),
        last_settled_game: 3,
      },
    ];

    const playerRows = [
      {
        match_id: 'match-normalizing',
        account_id: '0xnormalizing',
        display_name: 'Normalizing',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 1,
        revealed: 1,
        hash: 'a'.repeat(64),
        option_index: null,
        answer_text: 'NYC',
        normalized_reveal_text: 'nyc',
        salt: 'b'.repeat(32),
        forfeited: 0,
        disconnected_at: null,
      },
    ];

    const restored = restoreMatchesFromStorage(
      createMockSql(matchRows, playerRows),
      STALE_THRESHOLD_MS,
    );

    const match = must(restored[0], 'Expected restored normalizing match');
    expect(match.phase).toBe('normalizing');
    const player = must(
      match.players.get('0xnormalizing'),
      'Expected restored normalizing player state',
    );
    expect(player.answerText).toBe('NYC');
    expect(player.normalizedRevealText).toBe('nyc');
  });

  it('restores open-text answer fields from player checkpoints', () => {
    const matchRows = [
      {
        match_id: 'match-open-text',
        phase: 'reveal',
        current_game: 1,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 101,
            text: 'Type the most iconic city in England.',
            type: 'open_text',
            category: 'culture',
            maxLength: 64,
            placeholder: 'e.g. London',
          },
        ]),
        phase_entered_at: Date.now(),
        last_settled_game: 0,
      },
    ];

    const playerRows = [
      {
        match_id: 'match-open-text',
        account_id: '0xopen',
        display_name: 'OpenText',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 1,
        revealed: 1,
        hash: 'a'.repeat(64),
        option_index: null,
        answer_text: 'New York',
        normalized_reveal_text: 'new york',
        salt: 'b'.repeat(32),
        forfeited: 0,
        disconnected_at: null,
      },
    ];

    const restored = restoreMatchesFromStorage(
      createMockSql(matchRows, playerRows),
      STALE_THRESHOLD_MS,
    );

    const match = must(restored[0], 'Expected restored open-text match');
    const player = must(
      match.players.get('0xopen'),
      'Expected restored open-text player state',
    );

    expect(player.answerText).toBe('New York');
    expect(player.normalizedRevealText).toBe('new york');
  });

  it('sets disconnectedAt to restore time (not phaseEnteredAt) when disconnected_at is NULL', () => {
    // Simulate a match that started 20 seconds ago: long enough that
    // a player whose disconnectedAt was set to phaseEnteredAt would
    // have exceeded the 15 s grace period and be forfeited immediately.
    const phaseEnteredAt = Date.now() - 20_000;

    const matchRows = [
      {
        match_id: 'match-1',
        phase: 'commit',
        current_game: 1,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 1,
            text: 'Test',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: phaseEnteredAt,
        last_settled_game: 0,
      },
    ];

    const playerRows = [
      {
        match_id: 'match-1',
        account_id: '0xconnected',
        display_name: 'Connected',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        // NULL: player was connected when the checkpoint was written
        disconnected_at: null,
      },
      {
        match_id: 'match-1',
        account_id: '0xdisconnected',
        display_name: 'Disconnected',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        // Explicit timestamp: this player really disconnected 5 s ago
        disconnected_at: Date.now() - 5_000,
      },
    ];

    const sql = createMockSql(matchRows, playerRows);
    const before = Date.now();
    const restored = restoreMatchesFromStorage(sql, STALE_THRESHOLD_MS);
    const after = Date.now();

    expect(restored).toHaveLength(1);
    const match = must(restored[0], 'Expected restored match');
    expect(match.players.size).toBe(2);

    // The previously-connected player (disconnected_at = NULL) should
    // have disconnectedAt set to approximately "now" (the restore time),
    // NOT to phaseEnteredAt (which was 20 s ago). This ensures the
    // grace timer gives them the full 15 s window after restore.
    const connected = must(
      match.players.get('0xconnected'),
      'Expected connected player state',
    );
    expect(connected.disconnectedAt).toBeGreaterThanOrEqual(before);
    expect(connected.disconnectedAt).toBeLessThanOrEqual(after);

    // The explicitly-disconnected player keeps their original timestamp.
    const disconnected = must(
      match.players.get('0xdisconnected'),
      'Expected disconnected player state',
    );
    const secondPlayerRow = must(
      playerRows[1],
      'Expected second player row in fixture data',
    );
    expect(disconnected.disconnectedAt).toBe(secondPlayerRow.disconnected_at);
  });

  it('uses a consistent timestamp for all NULL disconnected_at players in the same restore call', () => {
    const phaseEnteredAt = Date.now() - 20_000;

    const matchRows = [
      {
        match_id: 'match-1',
        phase: 'commit',
        current_game: 1,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 1,
            text: 'Q',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: phaseEnteredAt,
        last_settled_game: 0,
      },
    ];

    const playerRows = [
      {
        match_id: 'match-1',
        account_id: '0xplayer1',
        display_name: 'P1',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
      {
        match_id: 'match-1',
        account_id: '0xplayer2',
        display_name: 'P2',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
    ];

    const sql = createMockSql(matchRows, playerRows);
    const restored = restoreMatchesFromStorage(sql, STALE_THRESHOLD_MS);

    const match = must(restored[0], 'Expected restored match');
    const p1 = must(match.players.get('0xplayer1'), 'Expected player 1 state');
    const p2 = must(match.players.get('0xplayer2'), 'Expected player 2 state');

    // Both players should share the exact same disconnectedAt timestamp
    // because the function captures `now` once at the top rather than
    // calling Date.now() per player.
    expect(p1.disconnectedAt).toBe(p2.disconnectedAt);
  });

  it('legacy checkpoint: forfeited player is detached (forfeitedAtGame < currentGame)', () => {
    const matchRows = [
      {
        match_id: 'match-1',
        phase: 'commit',
        current_game: 5,
        total_games: 10,
        prompts_json: JSON.stringify([
          {
            id: 1,
            text: 'Q',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: Date.now(),
        last_settled_game: 4,
      },
    ];

    const playerRows = [
      {
        match_id: 'match-1',
        account_id: '0xactive',
        display_name: 'Active',
        starting_balance: 1000,
        current_balance: 760,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        // No forfeited_at_game column: legacy row
        disconnected_at: null,
      },
      {
        match_id: 'match-1',
        account_id: '0xquitter',
        display_name: 'Quitter',
        starting_balance: 1000,
        current_balance: 400,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 1,
        // No forfeited_at_game column: legacy row
        disconnected_at: Date.now() - 30_000,
      },
    ];

    const sql = createMockSql(matchRows, playerRows);
    const restored = restoreMatchesFromStorage(sql, STALE_THRESHOLD_MS);

    const match = must(restored[0], 'Expected restored match');
    const quitter = must(
      match.players.get('0xquitter'),
      'Expected quitter state',
    );
    expect(quitter.forfeited).toBe(true);
    // Must be less than currentGame so settlement treats them as detached
    expect(quitter.forfeitedAtGame).toBe(4);
    expect(quitter.forfeitedAtGame).toBeLessThan(match.currentGame);

    const active = must(
      match.players.get('0xactive'),
      'Expected active player state',
    );
    expect(active.forfeitedAtGame).toBeNull();
  });

  it('restores aiAssisted from checkpoint rows and defaults legacy rows to false', () => {
    const phaseEnteredAt = Date.now();
    const baseMatchRow = {
      phase: 'commit',
      current_game: 1,
      total_games: 10,
      prompts_json: JSON.stringify([
        {
          id: 1,
          text: 'Q',
          type: 'select',
          category: 'number',
          options: ['A', 'B'],
        },
      ]),
      phase_entered_at: phaseEnteredAt,
      last_settled_game: 0,
    };
    const playerRows = [
      {
        match_id: 'match-ai',
        account_id: '0xplayer',
        display_name: 'P1',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
      {
        match_id: 'match-legacy',
        account_id: '0xplayer',
        display_name: 'P1',
        starting_balance: 1000,
        current_balance: 1000,
        committed: 0,
        revealed: 0,
        hash: null,
        option_index: null,
        salt: null,
        forfeited: 0,
        disconnected_at: null,
      },
    ];

    const restored = restoreMatchesFromStorage(
      createMockSql(
        [
          {
            ...baseMatchRow,
            match_id: 'match-ai',
            ai_assisted: 1,
          },
          {
            ...baseMatchRow,
            match_id: 'match-legacy',
          },
        ],
        playerRows,
      ),
      STALE_THRESHOLD_MS,
    );

    const aiMatch = restored.find((match) => match.matchId === 'match-ai');
    const legacyMatch = restored.find(
      (match) => match.matchId === 'match-legacy',
    );

    expect(aiMatch?.aiAssisted).toBe(true);
    expect(legacyMatch?.aiAssisted).toBe(false);
  });
});

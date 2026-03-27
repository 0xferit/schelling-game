import { describe, expect, it } from 'vitest';
import { restoreMatchesFromStorage } from '../../src/worker/persistence';
import { must } from './helpers';

/**
 * Minimal mock of the SqlStorage interface used by persistence.ts.
 * Rows are returned from pre-configured query results.
 */
function createMockSql(
  matchRows: Record<string, unknown>[],
  playerRows: Record<string, unknown>[],
) {
  return {
    exec(query: string, ...params: unknown[]) {
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
    },
  };
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

describe('restoreMatchesFromStorage', () => {
  it('sets disconnectedAt to restore time (not phaseEnteredAt) when disconnected_at is NULL', () => {
    // Simulate a match that started 20 seconds ago: long enough that
    // a player whose disconnectedAt was set to phaseEnteredAt would
    // have exceeded the 15 s grace period and be forfeited immediately.
    const phaseEnteredAt = Date.now() - 20_000;

    const matchRows = [
      {
        match_id: 'match-1',
        phase: 'commit',
        current_round: 1,
        total_rounds: 10,
        questions_json: JSON.stringify([
          {
            id: 1,
            text: 'Test',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: phaseEnteredAt,
        last_settled_round: 0,
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
        current_round: 1,
        total_rounds: 10,
        questions_json: JSON.stringify([
          {
            id: 1,
            text: 'Q',
            type: 'select',
            category: 'number',
            options: ['A', 'B'],
          },
        ]),
        phase_entered_at: phaseEnteredAt,
        last_settled_round: 0,
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
});

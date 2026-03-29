import { describe, expect, it, vi } from 'vitest';
import { createCommitHash } from '../../src/domain/commitReveal';
import type { Question } from '../../src/types/domain';
import type { RoundResultMessage } from '../../src/types/messages';
import type { Env } from '../../src/types/worker-env';
import { GameRoom } from '../../src/worker';
import { must } from './helpers';

function makeSqlResult(rows: Array<Record<string, unknown>> = []) {
  return {
    toArray: () => rows,
    *[Symbol.iterator]() {
      yield* rows;
    },
  };
}

function createRoom(db: D1Database = {} as D1Database) {
  const waitUntil = vi.fn((_task: Promise<unknown>) => undefined);
  const state = {
    waitUntil,
    storage: {
      sql: {
        exec: vi.fn((query: string) => {
          if (query.includes('PRAGMA table_info(match_checkpoints)')) {
            return makeSqlResult([{ name: 'last_round_result_json' }]);
          }
          if (query.includes('PRAGMA table_info(player_checkpoints)')) {
            return makeSqlResult([{ name: 'forfeited_at_round' }]);
          }
          return makeSqlResult();
        }),
      },
    },
  } as unknown as DurableObjectState;

  const room = new GameRoom(state, { DB: db } as Env);
  return { room, waitUntil };
}

function createMatch() {
  const question: Question = {
    id: 1,
    text: 'Pick one',
    type: 'select',
    category: 'culture',
    options: ['A', 'B'],
  };

  return {
    matchId: 'match-1',
    players: new Map(),
    questions: [question],
    currentRound: 1,
    totalRounds: 1,
    phase: 'reveal',
    phaseEnteredAt: Date.now(),
    lastSettledRound: 0,
    commitTimer: null,
    revealTimer: null,
    resultsTimer: null,
    lastRoundResult: null,
  };
}

describe('GameRoom async task tracking', () => {
  it('tracks websocket message handling with state.waitUntil', async () => {
    const { room, waitUntil } = createRoom();
    const handleMessage = vi
      .spyOn(room, '_handleMessage')
      .mockResolvedValue(undefined);

    const listeners = new Map<string, (evt: MessageEvent) => void>();
    const ws = {
      addEventListener: vi.fn(
        (type: string, handler: (evt: MessageEvent) => void) => {
          listeners.set(type, handler);
        },
      ),
    } as unknown as WebSocket;

    room._setupWsListeners(ws, 'acct-1');

    const onMessage = listeners.get('message');
    expect(onMessage).toBeDefined();

    must(
      onMessage,
      'Expected message listener',
    )({
      data: JSON.stringify({ type: 'join_queue' }),
    } as MessageEvent);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
    expect(handleMessage).toHaveBeenCalledWith('acct-1', {
      type: 'join_queue',
    });
  });

  it('tracks reveal-triggered round finalization with state.waitUntil', async () => {
    const { room, waitUntil } = createRoom();
    const finalizeRound = vi
      .spyOn(room, '_finalizeRound')
      .mockResolvedValue(undefined);
    vi.spyOn(room, '_checkpointPlayerAction').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastRevealStatus').mockImplementation(() => {});

    const salt = 'a'.repeat(64);
    const player = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 100,
      currentBalance: 100,
      committed: true,
      revealed: false,
      hash: createCommitHash(0, salt),
      optionIndex: null,
      salt: null,
      forfeited: false,
      disconnectedAt: null,
      graceTimer: null,
    };
    const match = createMatch();
    match.players.set(player.accountId, player);

    room.playerMatchIndex.set(player.accountId, match.matchId);
    room.activeMatches.set(match.matchId, match);

    room._handleReveal(player.accountId, {
      type: 'reveal',
      optionIndex: 0,
      salt,
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
    expect(finalizeRound).toHaveBeenCalledWith(match);
    expect(player.revealed).toBe(true);
    expect(player.optionIndex).toBe(0);
    expect(player.salt).toBe(salt);
  });

  it('tracks settled results-phase forfeit balance persistence with state.waitUntil', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const { room, waitUntil } = createRoom({
      prepare,
    } as unknown as D1Database);
    const checkpointPlayerAction = vi
      .spyOn(room, '_checkpointPlayerAction')
      .mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'results';
    match.currentRound = 3;
    match.totalRounds = 10;
    match.lastSettledRound = 3;
    match.lastRoundResult = {
      roundNum: 3,
    } as RoundResultMessage['result'];

    const player = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 1000,
      currentBalance: 940,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtRound: null,
      disconnectedAt: null,
      graceTimer: null,
    };
    match.players.set(player.accountId, player);

    room._forfeitPlayer(match, player.accountId);

    expect(player.currentBalance).toBe(520);
    expect(checkpointPlayerAction).toHaveBeenCalledWith(
      match.matchId,
      'acct-1',
      {
        forfeited: true,
        forfeitedAtRound: 3,
        currentBalance: 520,
      },
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
    expect(prepare).toHaveBeenCalledWith(
      'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
    );
    expect(bind).toHaveBeenCalledWith(520, 'acct-1');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not persist balance to D1 for commit-phase forfeit (avoids race with _finalizeRound)', () => {
    const prepare = vi.fn();
    const { room, waitUntil } = createRoom({
      prepare,
    } as unknown as D1Database);
    vi.spyOn(room, '_checkpointPlayerAction').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'commit';
    match.currentRound = 3;
    match.totalRounds = 10;

    const player = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 1000,
      currentBalance: 940,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtRound: null,
      disconnectedAt: null,
      graceTimer: null,
    };
    match.players.set(player.accountId, player);

    room._forfeitPlayer(match, player.accountId);

    expect(player.currentBalance).toBe(520);
    expect(player.forfeited).toBe(true);
    expect(player.forfeitedAtRound).toBe(3);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('tracks match start from _startFormingMatch with state.waitUntil', async () => {
    const { room, waitUntil } = createRoom();
    const startMatch = vi
      .spyOn(room, '_startMatch')
      .mockResolvedValue(undefined);
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {});

    // Set up a forming match with 3 players (minimum odd count)
    room.formingMatch = {
      players: ['acct-1', 'acct-2', 'acct-3'],
      timer: null,
      fillDeadlineMs: null,
    };

    room._startFormingMatch();

    expect(startMatch).toHaveBeenCalledTimes(1);
    expect(
      must(startMatch.mock.calls[0], 'Expected startMatch call')[0],
    ).toEqual(['acct-1', 'acct-2', 'acct-3']);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
  });

  it('returns the newest reserved player when fill closes on an even count', async () => {
    const { room, waitUntil } = createRoom();
    const startMatch = vi
      .spyOn(room, '_startMatch')
      .mockResolvedValue(undefined);
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {});

    room.formingMatch = {
      players: Array.from({ length: 10 }, (_, i) => `acct-${i + 1}`),
      timer: null,
      fillDeadlineMs: null,
    };

    room._startFormingMatch();

    expect(startMatch).toHaveBeenCalledTimes(1);
    expect(
      must(startMatch.mock.calls[0], 'Expected startMatch call')[0],
    ).toEqual(Array.from({ length: 9 }, (_, i) => `acct-${i + 1}`));
    expect(room.waitingQueue).toEqual(['acct-10']);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
  });

  it('caps immediately formed public matches at 21 players', () => {
    const { room } = createRoom();
    const startFormingMatch = vi
      .spyOn(room, '_startFormingMatch')
      .mockImplementation(() => {});

    room.waitingQueue = Array.from({ length: 25 }, (_, i) => `acct-${i + 1}`);

    room._tryFormMatch();

    expect(startFormingMatch).toHaveBeenCalledTimes(1);
    expect(room.formingMatch?.players).toEqual(
      Array.from({ length: 21 }, (_, i) => `acct-${i + 1}`),
    );
    expect(room.waitingQueue).toEqual([
      'acct-22',
      'acct-23',
      'acct-24',
      'acct-25',
    ]);
  });

  it('immediately starts forming a leftover queue after a full-cap match', () => {
    const { room } = createRoom();
    vi.spyOn(room, '_startMatch').mockResolvedValue(undefined);
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {});

    room.waitingQueue = Array.from({ length: 24 }, (_, i) => `acct-${i + 1}`);
    room._tryFormMatch();

    // 21 reserved for the first match; the chained _tryFormMatch() picks up
    // the remaining 3 into a new formingMatch before the broadcast fires.
    expect(room.waitingQueue).toHaveLength(0);
    expect(room.formingMatch?.players).toEqual([
      'acct-22',
      'acct-23',
      'acct-24',
    ]);

    if (room.formingMatch?.timer) clearTimeout(room.formingMatch.timer);
  });

  it('broadcast reflects new formingMatch after full-cap drain', () => {
    const { room } = createRoom();
    vi.spyOn(room, '_startMatch').mockResolvedValue(undefined);

    let capturedFormingMatch: typeof room.formingMatch = null;
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {
      capturedFormingMatch = room.formingMatch;
    });

    room.waitingQueue = Array.from({ length: 24 }, (_, i) => `acct-${i + 1}`);
    room._tryFormMatch();

    // The final broadcast must see the leftover formingMatch so clients
    // receive the fill timer countdown.
    expect(capturedFormingMatch).not.toBeNull();
    expect(capturedFormingMatch?.players).toHaveLength(3);

    if (room.formingMatch?.timer) clearTimeout(room.formingMatch.timer);
  });

  it('tracks match end after results with state.waitUntil', async () => {
    const { room, waitUntil } = createRoom();
    const endMatch = vi.spyOn(room, '_endMatch').mockResolvedValue(undefined);
    const startCommitPhase = vi
      .spyOn(room, '_startCommitPhase')
      .mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'results';

    room._advanceAfterResults(match);

    expect(startCommitPhase).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
    expect(endMatch).toHaveBeenCalledWith(match);
  });
});

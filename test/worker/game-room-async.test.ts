import { describe, expect, it, vi } from 'vitest';
import { createCommitHash } from '../../src/domain/commitReveal';
import type { Question } from '../../src/types/domain';
import type { Env } from '../../src/types/worker-env';
import { GameRoom } from '../../src/worker';

function makeSqlResult(rows: Array<Record<string, unknown>> = []) {
  return {
    toArray: () => rows,
    *[Symbol.iterator]() {
      yield* rows;
    },
  };
}

function createRoom() {
  const waitUntil = vi.fn((_task: Promise<unknown>) => undefined);
  const state = {
    waitUntil,
    storage: {
      sql: {
        exec: vi.fn((query: string) => {
          if (query.includes('PRAGMA table_info(match_checkpoints)')) {
            return makeSqlResult([{ name: 'last_round_result_json' }]);
          }
          return makeSqlResult();
        }),
      },
    },
  } as unknown as DurableObjectState;

  const room = new GameRoom(state, { DB: {} as D1Database } as Env);
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

    onMessage!({
      data: JSON.stringify({ type: 'join_queue' }),
    } as MessageEvent);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
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
    await waitUntil.mock.calls[0]![0];
    expect(finalizeRound).toHaveBeenCalledWith(match);
    expect(player.revealed).toBe(true);
    expect(player.optionIndex).toBe(0);
    expect(player.salt).toBe(salt);
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
    expect(startMatch.mock.calls[0]![0]).toEqual([
      'acct-1',
      'acct-2',
      'acct-3',
    ]);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
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
    expect(startMatch.mock.calls[0]![0]).toEqual(
      Array.from({ length: 9 }, (_, i) => `acct-${i + 1}`),
    );
    expect(room.waitingQueue).toEqual(['acct-10']);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
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
    await waitUntil.mock.calls[0]![0];
    expect(endMatch).toHaveBeenCalledWith(match);
  });
});

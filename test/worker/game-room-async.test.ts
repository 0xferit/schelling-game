import { describe, expect, it, vi } from 'vitest';
import { createCommitHash } from '../../src/domain/commitReveal';
import { GAME_ANTE, RESULTS_DURATION } from '../../src/domain/constants';
import type { Question } from '../../src/types/domain';
import type { GameResultMessage } from '../../src/types/messages';
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

function createRoom(envOverrides: Partial<Env> = {}) {
  const waitUntil = vi.fn((_task: Promise<unknown>) => undefined);
  const state = {
    waitUntil,
    storage: {
      sql: {
        exec: vi.fn((query: string) => {
          if (query.includes('PRAGMA table_info(match_checkpoints)')) {
            return makeSqlResult([{ name: 'last_game_result_json' }]);
          }
          if (query.includes('PRAGMA table_info(player_checkpoints)')) {
            return makeSqlResult([{ name: 'forfeited_at_game' }]);
          }
          return makeSqlResult();
        }),
      },
    },
  } as unknown as DurableObjectState;

  const room = new GameRoom(state, {
    DB: {} as D1Database,
    ...envOverrides,
  } as Env);
  return { room, waitUntil };
}

function createConnectionState(displayName: string) {
  return {
    ws: {
      send: vi.fn(),
    } as unknown as WebSocket,
    displayName,
    startNow: false,
    previousOpponents: new Set<string>(),
  };
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
    currentGame: 1,
    totalGames: 1,
    phase: 'reveal',
    phaseEnteredAt: Date.now(),
    lastSettledGame: 0,
    commitTimer: null,
    revealTimer: null,
    resultsTimer: null,
    lastGameResult: null,
    aiAssisted: false,
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

  it('tracks reveal-triggered game finalization with state.waitUntil', async () => {
    const { room, waitUntil } = createRoom();
    const finalizeGame = vi
      .spyOn(room, '_finalizeGame')
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
    expect(finalizeGame).toHaveBeenCalledWith(match);
    expect(player.revealed).toBe(true);
    expect(player.optionIndex).toBe(0);
    expect(player.salt).toBe(salt);
  });

  it('tracks settled results-phase forfeit balance persistence with state.waitUntil', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const { room, waitUntil } = createRoom({
      DB: { prepare } as unknown as D1Database,
    });
    const checkpointPlayerAction = vi
      .spyOn(room, '_checkpointPlayerAction')
      .mockImplementation(() => {});
    const checkpointMatch = vi
      .spyOn(room, '_checkpointMatch')
      .mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'results';
    match.currentGame = 3;
    match.totalGames = 10;
    match.lastSettledGame = 3;
    const currentBalance = GAME_ANTE * 10;
    const expectedBalance =
      currentBalance - (match.totalGames - match.currentGame) * GAME_ANTE;
    match.lastGameResult = {
      gameNum: 3,
      players: [{ accountId: 'acct-1', newBalance: currentBalance }],
    } as GameResultMessage['result'];

    const player = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: currentBalance,
      currentBalance,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
    };
    match.players.set(player.accountId, player);

    room._forfeitPlayer(match, player.accountId);

    expect(player.currentBalance).toBe(expectedBalance);
    expect(checkpointPlayerAction).toHaveBeenCalledWith(
      match.matchId,
      'acct-1',
      {
        forfeited: true,
        forfeitedAtGame: 3,
        currentBalance: expectedBalance,
      },
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
    expect(prepare).toHaveBeenCalledWith(
      'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
    );
    expect(bind).toHaveBeenCalledWith(expectedBalance, 'acct-1');
    expect(run).toHaveBeenCalledTimes(1);

    // Cached game result must reflect burned balance for reconnect replay
    const cached = match.lastGameResult?.players.find(
      (p) => p.accountId === 'acct-1',
    );
    expect(cached?.newBalance).toBe(expectedBalance);

    // Patched result must be checkpointed so it survives DO eviction
    expect(checkpointMatch).toHaveBeenCalledWith(match);
  });

  it('does not persist balance to D1 for commit-phase forfeit (avoids race with _finalizeGame)', () => {
    const prepare = vi.fn();
    const { room, waitUntil } = createRoom({
      DB: { prepare } as unknown as D1Database,
    });
    vi.spyOn(room, '_checkpointPlayerAction').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'commit';
    match.currentGame = 3;
    match.totalGames = 10;
    const currentBalance = GAME_ANTE * 10;
    const expectedBalance =
      currentBalance - (match.totalGames - match.currentGame) * GAME_ANTE;

    const player = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: currentBalance,
      currentBalance,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
    };
    match.players.set(player.accountId, player);

    // A second non-forfeited player who hasn't committed prevents
    // auto-advance from firing inside _forfeitPlayer.
    match.players.set('acct-2', {
      accountId: 'acct-2',
      displayName: 'Bob',
      ws: null,
      startingBalance: currentBalance,
      currentBalance,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
    });

    room._forfeitPlayer(match, player.accountId);

    expect(player.currentBalance).toBe(expectedBalance);
    expect(player.forfeited).toBe(true);
    expect(player.forfeitedAtGame).toBe(3);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not persist to D1 during mid-settlement results phase (avoids race with in-flight D1 batch)', () => {
    const prepare = vi.fn();
    const { room, waitUntil } = createRoom({
      DB: { prepare } as unknown as D1Database,
    });
    vi.spyOn(room, '_checkpointPlayerAction').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    // phase is 'results' but lastGameResult still has the previous
    // game's value: simulates a grace-timer forfeit firing during
    // _finalizeGame's D1 batch await.
    match.phase = 'results';
    match.currentGame = 3;
    match.totalGames = 10;
    match.lastSettledGame = 3;
    const currentBalance = GAME_ANTE * 10;
    const expectedBalance =
      currentBalance - (match.totalGames - match.currentGame) * GAME_ANTE;
    match.lastGameResult = {
      gameNum: 2,
      players: [],
    } as unknown as GameResultMessage['result'];

    const player = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: currentBalance,
      currentBalance,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
    };
    match.players.set(player.accountId, player);

    room._forfeitPlayer(match, player.accountId);

    expect(player.currentBalance).toBe(expectedBalance);
    expect(player.forfeited).toBe(true);
    // Must not persist or patch: _finalizeGame will read the live
    // playerState.currentBalance when it builds the payload.
    expect(waitUntil).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('tracks match start from _startFormingMatch with state.waitUntil', async () => {
    const { room, waitUntil } = createRoom();
    const startMatch = vi
      .spyOn(room, '_startMatch')
      .mockResolvedValue(undefined);
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {});

    // Set up a forming match with the minimum playable count.
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

  it('starts the full reserved cohort when fill closes on 10 players', async () => {
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
    ).toEqual(Array.from({ length: 10 }, (_, i) => `acct-${i + 1}`));
    expect(room.waitingQueue).toEqual([]);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected waitUntil call')[0];
  });

  it('starts immediately when all humans in a forming match vote start now', () => {
    const { room } = createRoom();
    const startFormingMatch = vi
      .spyOn(room, '_startFormingMatch')
      .mockImplementation(() => {});

    room.connections.set('acct-1', createConnectionState('Alice'));
    room.connections.set('acct-2', createConnectionState('Bob'));
    room.connections.set('acct-3', createConnectionState('Carol'));
    room.formingMatch = {
      players: ['acct-1', 'acct-2', 'acct-3'],
      timer: null,
      fillDeadlineMs: Date.now() + 30_000,
    };

    room._handleSetStartNow('acct-1', { value: true });
    room._handleSetStartNow('acct-2', { value: true });
    expect(startFormingMatch).not.toHaveBeenCalled();

    room._handleSetStartNow('acct-3', { value: true });
    expect(startFormingMatch).toHaveBeenCalledTimes(1);
  });

  it('starts immediately on unanimous start-now votes for an even forming match', () => {
    const { room } = createRoom();
    const startFormingMatch = vi
      .spyOn(room, '_startFormingMatch')
      .mockImplementation(() => {});

    room.connections.set('acct-1', createConnectionState('Alice'));
    room.connections.set('acct-2', createConnectionState('Bob'));
    room.connections.set('acct-3', createConnectionState('Carol'));
    room.connections.set('acct-4', createConnectionState('Drew'));
    room.formingMatch = {
      players: ['acct-1', 'acct-2', 'acct-3', 'acct-4'],
      timer: null,
      fillDeadlineMs: Date.now() + 30_000,
    };

    room._handleSetStartNow('acct-1', { value: true });
    room._handleSetStartNow('acct-2', { value: true });
    room._handleSetStartNow('acct-3', { value: true });
    room._handleSetStartNow('acct-4', { value: true });

    expect(startFormingMatch).toHaveBeenCalledTimes(1);
  });

  it('includes start-now readiness data in queue state', () => {
    const { room } = createRoom();

    room.connections.set('acct-1', createConnectionState('Alice'));
    room.connections.set('acct-2', createConnectionState('Bob'));
    room.connections.set('acct-3', createConnectionState('Carol'));
    room.connections.set('acct-4', createConnectionState('Spectator'));

    must(room.connections.get('acct-1'), 'Expected Alice connection').startNow =
      true;
    must(room.connections.get('acct-3'), 'Expected Carol connection').startNow =
      true;

    room.formingMatch = {
      players: ['acct-1', 'acct-2', 'acct-3'],
      timer: null,
      fillDeadlineMs: Date.now() + 30_000,
    };
    room.waitingQueue = ['acct-5', 'acct-6', 'acct-7'];

    const participantState = room._buildQueueStateMsg('acct-1', true) as {
      startNow: boolean;
      formingMatch: {
        humanPlayerCount: number;
        readyHumanCount: number;
        allowedSizes: number[];
        youCanVoteStartNow: boolean;
      } | null;
    };
    const spectatorState = room._buildQueueStateMsg('acct-4', false) as {
      startNow: boolean;
      formingMatch: {
        humanPlayerCount: number;
        readyHumanCount: number;
        allowedSizes: number[];
        youCanVoteStartNow: boolean;
      } | null;
    };

    expect(participantState.startNow).toBe(true);
    expect(participantState.formingMatch).toMatchObject({
      humanPlayerCount: 3,
      readyHumanCount: 2,
      allowedSizes: [3, 4, 5, 6],
      youCanVoteStartNow: true,
    });
    expect(spectatorState.startNow).toBe(false);
    expect(spectatorState.formingMatch).toMatchObject({
      humanPlayerCount: 3,
      readyHumanCount: 2,
      allowedSizes: [3, 4, 5, 6],
      youCanVoteStartNow: false,
    });
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

  it('injects one bot for two humans and removes it when a third human arrives', () => {
    const { room } = createRoom({ AI_BOT_ENABLED: 'true' });
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {});

    room.connections.set('acct-1', createConnectionState('Alice'));
    room.connections.set('acct-2', createConnectionState('Bob'));
    room.connections.set('acct-3', createConnectionState('Carol'));

    room._handleJoinQueue('acct-1');
    room._handleJoinQueue('acct-2');

    expect(room.waitingQueue).toHaveLength(0);
    expect(room.formingMatch).not.toBeNull();
    const bots =
      room.formingMatch?.players.filter((id) => room._isAiBot(id)) ?? [];
    expect(bots).toHaveLength(1);
    expect(
      room.formingMatch?.players.filter((id) => !room._isAiBot(id)),
    ).toEqual(['acct-1', 'acct-2']);

    room._handleJoinQueue('acct-3');

    expect(room.waitingQueue).toHaveLength(0);
    expect(room.formingMatch?.players).toEqual(['acct-1', 'acct-2', 'acct-3']);

    if (room.formingMatch?.timer) clearTimeout(room.formingMatch.timer);
  });

  it('injects two bots with distinct model indices for a solo human', () => {
    const { room } = createRoom({ AI_BOT_ENABLED: 'true' });
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {});

    room.connections.set('acct-1', createConnectionState('Alice'));

    room._handleJoinQueue('acct-1');

    expect(room.formingMatch).not.toBeNull();
    const bots =
      room.formingMatch?.players.filter((id) => room._isAiBot(id)) ?? [];
    expect(bots).toHaveLength(2);

    const indices = bots.map((id) => room._getBotModelIndex(id));
    expect(new Set(indices).size).toBe(2);

    if (room.formingMatch?.timer) clearTimeout(room.formingMatch.timer);
  });

  it('does not inject a bot for six humans', () => {
    const { room } = createRoom({ AI_BOT_ENABLED: 'true' });
    vi.spyOn(room, '_broadcastQueueState').mockImplementation(() => {});

    for (const [accountId, displayName] of [
      ['acct-1', 'Alice'],
      ['acct-2', 'Bob'],
      ['acct-3', 'Carol'],
      ['acct-4', 'Drew'],
      ['acct-5', 'Eve'],
      ['acct-6', 'Frank'],
    ] as const) {
      room.connections.set(accountId, createConnectionState(displayName));
      room._handleJoinQueue(accountId);
    }

    expect(room.formingMatch).not.toBeNull();
    expect(room.formingMatch?.players).toEqual([
      'acct-1',
      'acct-2',
      'acct-3',
      'acct-4',
      'acct-5',
      'acct-6',
    ]);
    expect(room.formingMatch?.players.some((id) => room._isAiBot(id))).toBe(
      false,
    );

    if (room.formingMatch?.timer) clearTimeout(room.formingMatch.timer);
  });

  it('commits and auto-reveals synthetic AI players through the Workers AI path', async () => {
    const aiRun = vi.fn().mockResolvedValue({
      response: '{"optionIndex":1}',
    });
    const { room, waitUntil } = createRoom({
      AI_BOT_ENABLED: 'true',
      AI_BOT_TIMEOUT_MS: '250',
      AI: {
        run: aiRun,
      },
    });
    vi.spyOn(room, '_checkpointMatch').mockImplementation(() => {});
    vi.spyOn(room, '_checkpointPlayerAction').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastCommitStatus').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastRevealStatus').mockImplementation(() => {});

    const match = createMatch();
    match.currentGame = 0;
    match.phase = 'starting';

    const human = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 100,
      currentBalance: 100,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    };
    const bot = {
      accountId: 'ai-bot:0:test',
      displayName: 'AI Backfill',
      ws: null,
      startingBalance: 0,
      currentBalance: 0,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    };
    match.players.set(human.accountId, human);
    match.players.set(bot.accountId, bot);

    room._startCommitPhase(match);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await must(waitUntil.mock.calls[0], 'Expected AI bot waitUntil call')[0];
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(bot.committed).toBe(true);
    expect(bot.optionIndex).toBe(1);
    expect(bot.hash).toBeTruthy();
    expect(bot.salt).toBeTruthy();

    human.committed = true;
    human.hash = createCommitHash(0, 'a'.repeat(64));

    room._startRevealPhase(match);

    expect(bot.revealed).toBe(true);

    if (match.revealTimer) clearTimeout(match.revealTimer);
  });

  it('uses a plain backfill prompt instead of coaching the model into stronger Schelling behavior', () => {
    const { room } = createRoom();
    const prompt = room._buildAiBotPrompt({
      id: 1,
      text: 'Pick a color.',
      type: 'select',
      category: 'aesthetics',
      options: ['Red', 'Blue', 'Green'],
    });

    expect(prompt).toContain('most human players');
    expect(prompt).not.toContain('Think step by step');
    expect(prompt).not.toContain('Round numbers over odd ones');
  });

  it('does not persist AI bot rows into vote_logs', async () => {
    const prepare = vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({ sql, args }),
    }));
    const batch = vi.fn().mockResolvedValue(undefined);
    const { room } = createRoom({
      DB: { prepare, batch } as unknown as D1Database,
    });
    vi.spyOn(room, '_checkpointMatch').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'reveal';
    match.currentGame = 1;

    match.players.set('acct-1', {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 100,
      currentBalance: 100,
      committed: true,
      revealed: true,
      hash: createCommitHash(0, 'a'.repeat(64)),
      optionIndex: 0,
      salt: 'a'.repeat(64),
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });
    match.players.set('ai-bot:test', {
      accountId: 'ai-bot:test',
      displayName: 'AI Backfill',
      ws: null,
      startingBalance: 0,
      currentBalance: 0,
      committed: true,
      revealed: true,
      hash: createCommitHash(1, 'b'.repeat(64)),
      optionIndex: 1,
      salt: 'b'.repeat(64),
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });

    await room._finalizeGame(match);

    const statements = must(
      batch.mock.calls[0],
      'Expected D1 batch call',
    )[0] as Array<{ sql: string; args: unknown[] }>;
    const voteLogStatements = statements.filter((stmt) =>
      stmt.sql.startsWith('INSERT INTO vote_logs'),
    );

    expect(voteLogStatements).toHaveLength(1);
    expect(voteLogStatements[0]?.args[3]).toBe('acct-1');

    if (match.resultsTimer) clearTimeout(match.resultsTimer);
  });

  it('continues the match when only an AI bot remains after settlement', async () => {
    vi.useFakeTimers();

    try {
      const bind = vi.fn(() => ({}));
      const prepare = vi.fn(() => ({ bind }));
      const batch = vi.fn().mockResolvedValue(undefined);
      const { room } = createRoom({
        DB: { prepare, batch } as unknown as D1Database,
      });
      vi.spyOn(room, '_checkpointMatch').mockImplementation(() => {});
      vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

      const startCommitPhase = vi
        .spyOn(room, '_startCommitPhase')
        .mockImplementation(() => {});
      const endMatch = vi.spyOn(room, '_endMatch').mockResolvedValue(undefined);

      const match = createMatch();
      match.totalGames = 3;
      match.currentGame = 1;
      match.phase = 'reveal';

      const human = {
        accountId: 'acct-1',
        displayName: 'Alice',
        ws: null,
        startingBalance: 100,
        currentBalance: 100,
        committed: false,
        revealed: false,
        hash: null,
        optionIndex: null,
        salt: null,
        forfeited: true,
        forfeitedAtGame: null,
        disconnectedAt: null,
        graceTimer: null,
        pendingAiCommit: false,
      };
      const botSalt = 'b'.repeat(64);
      const bot = {
        accountId: 'ai-bot:0:test',
        displayName: 'AI Backfill',
        ws: null,
        startingBalance: 0,
        currentBalance: 0,
        committed: true,
        revealed: true,
        hash: createCommitHash(1, botSalt),
        optionIndex: 1,
        salt: botSalt,
        forfeited: false,
        forfeitedAtGame: null,
        disconnectedAt: null,
        graceTimer: null,
        pendingAiCommit: false,
      };
      match.players.set(human.accountId, human);
      match.players.set(bot.accountId, bot);

      await room._finalizeGame(match);

      expect(endMatch).not.toHaveBeenCalled();
      expect(startCommitPhase).not.toHaveBeenCalled();
      expect(match.resultsTimer).not.toBeNull();

      vi.advanceTimersByTime(RESULTS_DURATION * 1000);

      expect(startCommitPhase).toHaveBeenCalledWith(match);
      expect(endMatch).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('broadcasts AI-assisted game_start metadata with zero ante', () => {
    const { room } = createRoom();
    vi.spyOn(room, '_checkpointMatch').mockImplementation(() => {});
    vi.spyOn(room, '_maybeScheduleAiBotCommit').mockImplementation(() => {});
    const broadcastToMatch = vi
      .spyOn(room, '_broadcastToMatch')
      .mockImplementation(() => {});

    const match = createMatch();
    match.currentGame = 0;
    match.phase = 'starting';
    match.aiAssisted = true;

    room._startCommitPhase(match);

    expect(broadcastToMatch).toHaveBeenCalledWith(
      match,
      expect.objectContaining({
        type: 'game_started',
        aiAssisted: true,
        gameAnte: 0,
      }),
    );

    if (match.commitTimer) clearTimeout(match.commitTimer);
  });

  it('keeps balances unchanged and skips account/stat writes in AI-assisted matches', async () => {
    const prepare = vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({ sql, args }),
    }));
    const batch = vi.fn().mockResolvedValue(undefined);
    const { room } = createRoom({
      DB: { prepare, batch } as unknown as D1Database,
    });
    vi.spyOn(room, '_checkpointMatch').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'reveal';
    match.currentGame = 1;
    match.aiAssisted = true;

    match.players.set('acct-1', {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 100,
      currentBalance: 100,
      committed: true,
      revealed: true,
      hash: createCommitHash(0, 'a'.repeat(64)),
      optionIndex: 0,
      salt: 'a'.repeat(64),
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });
    match.players.set('ai-bot:0:test', {
      accountId: 'ai-bot:0:test',
      displayName: 'nemotron',
      ws: null,
      startingBalance: 0,
      currentBalance: 0,
      committed: true,
      revealed: true,
      hash: createCommitHash(0, 'b'.repeat(64)),
      optionIndex: 0,
      salt: 'b'.repeat(64),
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });

    await room._finalizeGame(match);

    const alice = must(
      match.players.get('acct-1'),
      'Expected human player state after settlement',
    );
    expect(alice.currentBalance).toBe(100);
    const statements = must(
      batch.mock.calls[0],
      'Expected D1 batch call',
    )[0] as Array<{ sql: string; args: unknown[] }>;
    expect(
      statements.some((stmt) =>
        stmt.sql.includes('UPDATE accounts SET token_balance'),
      ),
    ).toBe(false);
    expect(
      statements.some((stmt) => stmt.sql.includes('UPDATE player_stats')),
    ).toBe(false);

    const voteLog = statements.find((stmt) =>
      stmt.sql.includes('INSERT INTO vote_logs'),
    );
    expect(voteLog).toBeDefined();
    expect(voteLog?.args[9]).toBe(0);
    expect(voteLog?.args[10]).toBe(0);
    expect(voteLog?.args[11]).toBe(0);

    expect(match.lastGameResult?.pot).toBe(0);
    expect(match.lastGameResult?.payoutPerWinner).toBe(0);
    expect(match.lastGameResult?.players[0]?.newBalance).toBe(100);

    if (match.resultsTimer) clearTimeout(match.resultsTimer);
  });

  it('does not burn future-game antes when an AI-assisted match is forfeited', () => {
    const prepare = vi.fn();
    const { room, waitUntil } = createRoom({
      DB: { prepare } as unknown as D1Database,
    });
    vi.spyOn(room, '_checkpointPlayerAction').mockImplementation(() => {});
    vi.spyOn(room, '_broadcastToMatch').mockImplementation(() => {});

    const match = createMatch();
    match.phase = 'commit';
    match.currentGame = 3;
    match.totalGames = 10;
    match.aiAssisted = true;

    const player = {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: GAME_ANTE * 10,
      currentBalance: GAME_ANTE * 10,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    };
    match.players.set(player.accountId, player);
    match.players.set('ai-bot:0:test', {
      accountId: 'ai-bot:0:test',
      displayName: 'nemotron',
      ws: null,
      startingBalance: 0,
      currentBalance: 0,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });

    room._forfeitPlayer(match, player.accountId);

    expect(player.currentBalance).toBe(GAME_ANTE * 10);
    expect(player.forfeited).toBe(true);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('replays self-forfeited status before the current game snapshot on reconnect', () => {
    const { room } = createRoom();
    room.connections.set('acct-1', createConnectionState('Alice'));

    const match = createMatch();
    match.phase = 'commit';
    match.players.set('acct-1', {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 100,
      currentBalance: 100,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: true,
      forfeitedAtGame: 1,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });

    room._sendMatchStateToPlayer(match, 'acct-1');

    const connection = must(
      room.connections.get('acct-1'),
      'Expected Alice connection',
    ) as {
      ws: { send: ReturnType<typeof vi.fn> };
    };
    const sentMessages = connection.ws.send.mock.calls.map(([payload]) =>
      JSON.parse(payload as string),
    );

    expect(sentMessages.map((msg) => msg.type)).toEqual([
      'match_started',
      'player_forfeited',
      'game_started',
    ]);
    expect(sentMessages[1]).toMatchObject({
      type: 'player_forfeited',
      displayName: 'Alice',
      futureGamesPenaltyApplied: true,
    });
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

  it('leaves completed players idle after match end until they rejoin manually', async () => {
    const batch = vi.fn().mockResolvedValue(undefined);
    const bind = vi.fn(() => ({ bind, first: vi.fn(), run: vi.fn() }));
    const prepare = vi.fn(() => ({ bind }));
    const { room } = createRoom({
      DB: { prepare, batch } as unknown as D1Database,
    });
    vi.spyOn(room, '_deleteMatchCheckpoint').mockImplementation(() => {});

    room.connections.set('acct-1', createConnectionState('Alice'));
    room.connections.set('acct-2', createConnectionState('Bob'));
    room.connections.set('acct-3', createConnectionState('Carol'));

    const match = createMatch();
    match.phase = 'results';
    match.players.set('acct-1', {
      accountId: 'acct-1',
      displayName: 'Alice',
      ws: null,
      startingBalance: 100,
      currentBalance: 140,
      committed: true,
      revealed: true,
      hash: null,
      optionIndex: 0,
      salt: 'a'.repeat(64),
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });
    match.players.set('acct-2', {
      accountId: 'acct-2',
      displayName: 'Bob',
      ws: null,
      startingBalance: 100,
      currentBalance: 80,
      committed: true,
      revealed: true,
      hash: null,
      optionIndex: 1,
      salt: 'b'.repeat(64),
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });
    match.players.set('acct-3', {
      accountId: 'acct-3',
      displayName: 'Carol',
      ws: null,
      startingBalance: 100,
      currentBalance: 80,
      committed: true,
      revealed: true,
      hash: null,
      optionIndex: 1,
      salt: 'c'.repeat(64),
      forfeited: false,
      forfeitedAtGame: null,
      disconnectedAt: null,
      graceTimer: null,
      pendingAiCommit: false,
    });

    room.activeMatches.set(match.matchId, match);
    room.playerMatchIndex.set('acct-1', match.matchId);
    room.playerMatchIndex.set('acct-2', match.matchId);
    room.playerMatchIndex.set('acct-3', match.matchId);

    await room._endMatch(match);

    expect(room.waitingQueue).toEqual([]);
    expect(room.playerMatchIndex.has('acct-1')).toBe(false);
    expect(room.playerMatchIndex.has('acct-2')).toBe(false);
    expect(room.playerMatchIndex.has('acct-3')).toBe(false);

    const aliceConnection = must(
      room.connections.get('acct-1'),
      'Expected Alice connection',
    ) as {
      ws: { send: ReturnType<typeof vi.fn> };
    };
    const sentMessages = aliceConnection.ws.send.mock.calls.map(([payload]) =>
      JSON.parse(payload as string),
    );
    expect(sentMessages.at(-1)).toMatchObject({
      type: 'queue_state',
      status: 'idle',
    });
  });
});

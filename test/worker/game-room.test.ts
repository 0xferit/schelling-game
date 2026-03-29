import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createCommitHash } from '../../src/domain/commitReveal';
import { GAME_ANTE, RESULTS_DURATION } from '../../src/domain/constants';
import {
  createTestSession,
  createTestWallet,
  must,
  seedAccount,
} from './helpers';

const BASE = 'https://test.local';
const MATCH_START_TIMEOUT_MS = 40_000;
const GAME_START_TIMEOUT_MS = 45_000;
const MATCH_OVER_TIMEOUT_MS = 20_000;

function makeSalt(gameNum: number, playerIdx: number): string {
  const nibbleA = (gameNum % 16).toString(16);
  const nibbleB = (playerIdx % 16).toString(16);
  return `${nibbleA}${nibbleB}`.repeat(32);
}

/** Helper: collect WebSocket messages into an array for a short window. */
function collectMessages(
  ws: WebSocket,
  timeoutMs = 500,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const handler = (evt: MessageEvent) => {
      messages.push(JSON.parse(evt.data as string));
    };
    ws.addEventListener('message', handler);
    setTimeout(() => {
      ws.removeEventListener('message', handler);
      resolve(messages);
    }, timeoutMs);
  });
}

/** Helper: wait for a specific message type from a WebSocket. */
function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Timed out waiting for "${type}"`));
    }, timeoutMs);
    ws.addEventListener('message', handler);
  });
}

/** Wait for a message that satisfies a predicate. */
function waitForMessageWhere(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('Timed out waiting for matching message'));
    }, timeoutMs);
    ws.addEventListener('message', handler);
  });
}

/** Open a WebSocket for a wallet index, returning the client socket. */
async function connectWs(
  walletIndex: number,
): Promise<{ ws: WebSocket; accountId: string }> {
  const wallet = createTestWallet(walletIndex);
  const { accountId, cookie } = await createTestSession(wallet);

  const resp = await exports.default.fetch(
    new Request(`${BASE}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Cookie: `session=${cookie}`,
      },
    }),
  );
  expect(resp.status).toBe(101);
  const ws = must(resp.webSocket, 'Expected WebSocket upgrade response');
  ws.accept();
  return { ws, accountId };
}

/** Connect a seeded player via WebSocket, returning the client socket. */
async function connectPlayer(
  walletIndex: number,
  displayName: string,
  balance = 0,
): Promise<{ ws: WebSocket; accountId: string }> {
  const wallet = createTestWallet(walletIndex);
  const { accountId } = await createTestSession(wallet);
  await seedAccount(env.DB, accountId, displayName, balance);
  return connectWs(walletIndex);
}

/**
 * Reconnect an already-seeded player via WebSocket without reseeding or
 * updating the account row in D1. Use this instead of connectPlayer when the
 * account already exists and its token_balance must not be reset (e.g. after
 * settlement has altered it).
 */
async function reconnectPlayer(
  walletIndex: number,
): Promise<{ ws: WebSocket; accountId: string }> {
  return connectWs(walletIndex);
}

/** Join queue and start immediately via unanimous start-now votes. */
async function joinPlayersAndStartNow(
  players: Array<{ ws: WebSocket }>,
): Promise<void> {
  const formingPromises = players.map((player) =>
    waitForMessageWhere(
      player.ws,
      (msg) => msg.type === 'queue_state' && msg.status === 'forming',
      3000,
    ),
  );

  for (const player of players) {
    player.ws.send(JSON.stringify({ type: 'join_queue' }));
  }

  await Promise.all(formingPromises);

  for (const player of players) {
    player.ws.send(JSON.stringify({ type: 'set_start_now', value: true }));
  }
}

/** Connect N players, join queue, and await match_started for all. */
async function formMatch(
  wallets: [index: number, name: string][],
): Promise<
  { ws: WebSocket; accountId: string; gameStarted: Record<string, unknown> }[]
> {
  const players: Array<Awaited<ReturnType<typeof connectPlayer>>> = [];
  for (const [index, name] of wallets) {
    players.push(await connectPlayer(index, name));
  }

  const startedPromises = players.map((p) =>
    waitForMessage(p.ws, 'match_started', MATCH_START_TIMEOUT_MS),
  );

  for (const p of players) {
    p.ws.send(JSON.stringify({ type: 'join_queue' }));
  }

  const started = await Promise.all(startedPromises);
  return players.map((p, i) => ({
    ...p,
    gameStarted: must(
      started[i],
      `Expected match_started for player index ${i}`,
    ),
  }));
}

describe('GameRoom Durable Object', () => {
  it('rejects WebSocket without session cookie (401)', async () => {
    const resp = await exports.default.fetch(
      new Request(`${BASE}/ws`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(resp.status).toBe(401);
  });

  it('WebSocket auto-provisions a missing account for a valid session', async () => {
    const wallet = createTestWallet(0);
    const { accountId, cookie } = await createTestSession(wallet);

    await env.DB.batch([
      env.DB.prepare('DELETE FROM player_stats WHERE account_id = ?').bind(
        accountId,
      ),
      env.DB.prepare('DELETE FROM accounts WHERE account_id = ?').bind(
        accountId,
      ),
    ]);

    const resp = await exports.default.fetch(
      new Request(`${BASE}/ws`, {
        headers: {
          Upgrade: 'websocket',
          Cookie: `session=${cookie}`,
        },
      }),
    );

    expect(resp.status).toBe(101);

    const ws = must(resp.webSocket, 'Expected WebSocket upgrade response');
    ws.accept();
    const messages = await collectMessages(ws);
    expect(messages.some((message) => message.type === 'queue_state')).toBe(
      true,
    );

    const account = (await env.DB.prepare(
      'SELECT account_id FROM accounts WHERE account_id = ?',
    )
      .bind(accountId)
      .first()) as { account_id: string } | null;
    const stats = (await env.DB.prepare(
      'SELECT account_id FROM player_stats WHERE account_id = ?',
    )
      .bind(accountId)
      .first()) as { account_id: string } | null;

    expect(account?.account_id).toBe(accountId);
    expect(stats?.account_id).toBe(accountId);
    ws.close();
  });

  it('WebSocket falls back to a wallet-derived display name', async () => {
    // Use wallet 5 so it does not collide with later tests.
    const wallet = createTestWallet(5);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, null);

    const resp = await exports.default.fetch(
      new Request(`${BASE}/ws`, {
        headers: {
          Upgrade: 'websocket',
          Cookie: `session=${cookie}`,
        },
      }),
    );
    expect(resp.status).toBe(101);
    const ws = must(resp.webSocket, 'Expected WebSocket upgrade response');
    ws.accept();
    const messages = await collectMessages(ws);
    const queueMsg = messages.find((m) => m.type === 'queue_state');
    expect(queueMsg).toBeDefined();
    ws.close();
  });

  it('WebSocket connects with valid session + display name', async () => {
    const { ws } = await connectPlayer(6, 'Alice');
    const messages = await collectMessages(ws);

    // Should receive queue_state on connect
    const queueMsg = messages.find((m) => m.type === 'queue_state');
    expect(queueMsg).toBeDefined();
    ws.close();
  });

  it('join_queue and leave_queue cycle works', async () => {
    const { ws } = await connectPlayer(7, 'Bob');

    // Drain initial queue_state
    await collectMessages(ws, 200);

    // Join queue
    ws.send(JSON.stringify({ type: 'join_queue' }));
    const joinMsgs = await collectMessages(ws, 300);
    const joinState = joinMsgs.find((m) => m.type === 'queue_state');
    expect(joinState).toBeDefined();
    expect(
      must(joinState, 'Expected queue_state after join').queuedCount,
    ).toBeGreaterThanOrEqual(1);

    // Leave queue
    ws.send(JSON.stringify({ type: 'leave_queue' }));
    const leaveMsgs = await collectMessages(ws, 300);
    const leaveState = leaveMsgs.find((m) => m.type === 'queue_state');
    expect(leaveState).toBeDefined();

    ws.close();
  });

  it('rejects join_queue when balance is below the allowed floor', async () => {
    const minAllowedBalance = -10 * GAME_ANTE;
    const { ws } = await connectPlayer(9, 'LowBalance', minAllowedBalance - 1);

    // Drain initial queue_state
    await collectMessages(ws, 200);

    ws.send(JSON.stringify({ type: 'join_queue' }));
    const msgs = await collectMessages(ws, 300);
    const errorMsg = msgs.find((m) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(
      must(errorMsg, 'Expected error for insufficient balance').message,
    ).toContain('Balance too low to enter queue');

    ws.close();
  });

  // The fill timer is 30 seconds; the match starts after it expires.
  it('3 players joining queue triggers match formation', {
    timeout: 45_000,
  }, async () => {
    const players = await formMatch([
      [0, 'Player1'],
      [1, 'Player2'],
      [2, 'Player3'],
    ]);

    // Verify match_started has expected structure
    const gs1 = must(players[0], 'Expected first player').gameStarted;
    expect(gs1.matchId).toBeTruthy();
    expect(gs1.players).toBeDefined();
    expect(gs1.gameCount).toBe(10);

    // All three should share the same matchId
    expect(gs1.matchId).toBe(
      must(players[1], 'Expected second player').gameStarted.matchId,
    );
    expect(gs1.matchId).toBe(
      must(players[2], 'Expected third player').gameStarted.matchId,
    );

    for (const p of players) {
      p.ws.close();
    }
  });

  it('reconnect after commit replays game_started with yourCommitted flag', {
    timeout: 55_000,
  }, async () => {
    // Form a match with 3 players (wallet indices 3/4/8 to avoid collisions)
    const p1 = await connectPlayer(3, 'Reconnector');
    const p2 = await connectPlayer(4, 'Bystander1');
    const p3 = await connectPlayer(8, 'Bystander2');

    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    // Listen for game_started before awaiting match_started to avoid missing
    // back-to-back messages from the server.
    const p1GameStart = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    const [gs1] = await Promise.all([p1Started, p2Started, p3Started]);
    const originalMatchId = gs1.matchId;
    expect(originalMatchId).toBeTruthy();

    const roundStart = await p1GameStart;
    expect(roundStart.phase).toBe('commit');

    // Player 1 commits a hash.
    // Set up listener before sending to avoid race with fast DO reply.
    const fakeHash =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const commitStatus = waitForMessage(p1.ws, 'commit_status', 3000);
    p1.ws.send(JSON.stringify({ type: 'commit', hash: fakeHash }));
    await commitStatus;

    // Disconnect player 1
    p1.ws.close();

    // Reconnect the same wallet (same accountId).
    // Register both listeners immediately after reconnectPlayer returns
    // (before any await) so queued replay messages can't dispatch first.
    const p1r = await reconnectPlayer(3);
    const reconnectGameStartedP = waitForMessage(p1r.ws, 'match_started', 3000);
    const reconnectGameStartP = waitForMessage(p1r.ws, 'game_started', 3000);

    const reconnectGameStarted = await reconnectGameStartedP;
    expect(reconnectGameStarted.matchId).toBe(originalMatchId);

    const reconnectRoundStart = await reconnectGameStartP;
    expect(reconnectRoundStart.yourCommitted).toBe(true);
    expect(reconnectRoundStart.yourRevealed).toBe(false);

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('reconnect replays player_disconnected for peers in grace period', {
    timeout: 55_000,
  }, async () => {
    // Use wallet indices 19/20/21 to avoid collisions with other tests.
    const p1 = await connectPlayer(19, 'ReconP1');
    const p2 = await connectPlayer(20, 'ReconP2');
    const p3 = await connectPlayer(21, 'ReconP3');

    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    // Listen for game_started before joining to avoid missing it
    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    await p1Round;

    // Disconnect player 2 so the DO starts a grace timer for them
    const p1DisconnectMsg = waitForMessage(p1.ws, 'player_disconnected', 3000);
    p2.ws.close();
    const disconnectMsg = await p1DisconnectMsg;
    expect(disconnectMsg.displayName).toBe('ReconP2');

    // Disconnect player 1 and reconnect: the replay should include
    // a synthetic player_disconnected for player 2.
    p1.ws.close();

    const p1r = await connectPlayer(19, 'ReconP1');
    const reconnectGameStarted = waitForMessage(p1r.ws, 'match_started', 3000);
    const reconnectDisconnected = waitForMessage(
      p1r.ws,
      'player_disconnected',
      3000,
    );

    await reconnectGameStarted;
    const replayed = await reconnectDisconnected;
    expect(replayed.displayName).toBe('ReconP2');
    expect(typeof replayed.graceSeconds).toBe('number');
    expect(Number.isInteger(replayed.graceSeconds)).toBe(true);
    expect(replayed.graceSeconds).toBeGreaterThan(0);
    expect(replayed.graceSeconds).toBeLessThanOrEqual(15);

    p1r.ws.close();
    p3.ws.close();
  });

  it('reconnect during results phase replays game_result', {
    timeout: 55_000,
  }, async () => {
    // Use wallet indices 10/11/12 to avoid collisions with other tests.
    // Give players a balance so settlement can deduct ante.
    const p1 = await connectPlayer(10, 'ResultP1', 1000);
    const p2 = await connectPlayer(11, 'ResultP2', 1000);
    const p3 = await connectPlayer(12, 'ResultP3', 1000);

    // Listen for match_started before joining queue
    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    // Listen for game_started on all players before joining
    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Round = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Round = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    await Promise.all([p1Round, p2Round, p3Round]);

    // All players commit with option index 0 and distinct salts
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const optionIndex = 0;
    const hash1 = createCommitHash(optionIndex, salt1);
    const hash2 = createCommitHash(optionIndex, salt2);
    const hash3 = createCommitHash(optionIndex, salt3);

    // Listen for phase_change (to reveal) before committing.
    // All non-forfeited players committing triggers auto-advance.
    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: hash1 }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: hash2 }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: hash3 }));

    const phaseChange = await p1PhaseChange;
    expect(phaseChange.phase).toBe('reveal');

    // All players reveal. When all committed players reveal, auto-advance
    // triggers _finalizeGame which enters results phase.
    const p1Result = waitForMessage(p1.ws, 'game_result', 5000);

    p1.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt1 }));
    p2.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt2 }));
    p3.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt3 }));

    // Wait for game_result to confirm we are in results phase
    const originalResult = await p1Result;
    expect(originalResult.type).toBe('game_result');

    // Disconnect player 1 and reconnect during results phase
    p1.ws.close();

    const p1r = await reconnectPlayer(10);
    const reconnectResult = waitForMessage(p1r.ws, 'game_result', 5000);

    const replayedResult = await reconnectResult;
    expect(replayedResult.type).toBe('game_result');
    expect(replayedResult.result).toBeDefined();

    const result = replayedResult.result as Record<string, unknown>;
    expect(result.gameNum).toBe(1);
    expect(result.players).toBeDefined();

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('results-phase reconnect sends remaining time, not full duration', {
    timeout: 65_000,
  }, async () => {
    const WAIT_SECONDS = 3;
    // Use wallet indices 13/14/15 to avoid collisions with other tests.
    const p1 = await connectPlayer(13, 'RemP1', 1000);
    const p2 = await connectPlayer(14, 'RemP2', 1000);
    const p3 = await connectPlayer(15, 'RemP3', 1000);

    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Round = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Round = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    await Promise.all([p1Round, p2Round, p3Round]);

    // All players commit with option index 0
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const optionIndex = 0;
    const hash1 = createCommitHash(optionIndex, salt1);
    const hash2 = createCommitHash(optionIndex, salt2);
    const hash3 = createCommitHash(optionIndex, salt3);

    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: hash1 }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: hash2 }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: hash3 }));

    await p1PhaseChange;

    // All players reveal to enter results phase
    const p1Result = waitForMessage(p1.ws, 'game_result', 5000);

    p1.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt1 }));
    p2.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt2 }));
    p3.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt3 }));

    await p1Result;

    // Wait partway through the results phase
    await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));

    // Disconnect and reconnect player 1
    p1.ws.close();
    const p1r = await connectPlayer(13, 'RemP1', 1000);
    const reconnectResult = await waitForMessage(p1r.ws, 'game_result', 5000);

    // The replayed resultsDuration must reflect remaining time, not the full constant
    const replayedDuration = reconnectResult.resultsDuration as number;
    expect(replayedDuration).toBeLessThan(RESULTS_DURATION);

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('reconnect during results phase replays rating tally and own rating', {
    timeout: 55_000,
  }, async () => {
    // Use wallet indices 16/17/18 to avoid collisions with other tests.
    const p1 = await connectPlayer(16, 'RatingP1', 1000);
    const p2 = await connectPlayer(17, 'RatingP2', 1000);
    const p3 = await connectPlayer(18, 'RatingP3', 1000);

    // Listen for match_started and game_started before joining queue
    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Round = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Round = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    await Promise.all([p1Round, p2Round, p3Round]);

    // All players commit with option index 0 and distinct salts
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const optionIndex = 0;
    const hash1 = createCommitHash(optionIndex, salt1);
    const hash2 = createCommitHash(optionIndex, salt2);
    const hash3 = createCommitHash(optionIndex, salt3);

    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: hash1 }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: hash2 }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: hash3 }));

    await p1PhaseChange;

    // All players reveal to reach results phase
    const p1Result = waitForMessage(p1.ws, 'game_result', 5000);

    p1.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt1 }));
    p2.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt2 }));
    p3.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt3 }));

    await p1Result;

    // Player 1 submits a "like" rating during results phase
    const p1Tally = waitForMessage(p1.ws, 'prompt_rating_tally', 3000);
    p1.ws.send(JSON.stringify({ type: 'prompt_rating', rating: 'like' }));
    const tally = await p1Tally;
    expect(tally.likes).toBe(1);
    expect(tally.dislikes).toBe(0);

    // Disconnect player 1 and reconnect during results phase
    p1.ws.close();

    const p1r = await connectPlayer(16, 'RatingP1', 1000);
    // Listen for both game_result and prompt_rating_tally on reconnect
    const reconnectResult = waitForMessage(p1r.ws, 'game_result', 5000);
    const reconnectTally = waitForMessage(p1r.ws, 'prompt_rating_tally', 5000);

    const replayedResult = await reconnectResult;
    expect(replayedResult.type).toBe('game_result');

    const replayedTally = await reconnectTally;
    expect(replayedTally.likes).toBe(1);
    expect(replayedTally.dislikes).toBe(0);
    expect(replayedTally.yourRating).toBe('like');

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('reconnect after a settled game replays match_started with currentBalance', {
    timeout: 90_000,
  }, async () => {
    // Use wallet indices 22/23/24 to avoid collisions with other tests.
    // Give players a balance so settlement can deduct ante.
    const STARTING_BALANCE = 1000;
    const p1 = await connectPlayer(22, 'BalP1', STARTING_BALANCE);
    const p2 = await connectPlayer(23, 'BalP2', STARTING_BALANCE);
    const p3 = await connectPlayer(24, 'BalP3', STARTING_BALANCE);

    // Listen for match_started and game_started before joining queue
    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    const p1Game1 = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Game1 = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Game1 = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    await Promise.all([p1Game1, p2Game1, p3Game1]);

    // Game 1: p1 and p2 pick option 0, p3 picks option 1.
    // This creates winners (p1, p2) and a loser (p3) so balances change.
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const hash1 = createCommitHash(0, salt1);
    const hash2 = createCommitHash(0, salt2);
    const hash3 = createCommitHash(1, salt3);

    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: hash1 }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: hash2 }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: hash3 }));

    await p1PhaseChange;

    // All reveal
    const p1Result = waitForMessage(p1.ws, 'game_result', 5000);

    p1.ws.send(JSON.stringify({ type: 'reveal', optionIndex: 0, salt: salt1 }));
    p2.ws.send(JSON.stringify({ type: 'reveal', optionIndex: 0, salt: salt2 }));
    p3.ws.send(JSON.stringify({ type: 'reveal', optionIndex: 1, salt: salt3 }));

    const roundResult = await p1Result;
    expect(roundResult.type).toBe('game_result');

    // Wait for game 2 to start (auto-advances after RESULTS_DURATION)
    const p1Game2 = waitForMessage(p1.ws, 'game_started', 30_000);
    await p1Game2;

    // Disconnect player 1 and reconnect during game 2 commit phase
    p1.ws.close();

    const p1r = await reconnectPlayer(22);
    const reconnectGameStarted = waitForMessage(p1r.ws, 'match_started', 5000);

    const gsMsg = await reconnectGameStarted;
    expect(gsMsg.type).toBe('match_started');

    // Verify that currentBalance is present and differs from startingBalance
    // for at least one player (settlement changed balances in game 1).
    const players = gsMsg.players as Array<{
      displayName: string;
      startingBalance: number;
      currentBalance?: number;
    }>;
    const hasChangedBalance = players.some(
      (p) =>
        p.currentBalance !== undefined &&
        p.currentBalance !== p.startingBalance,
    );
    expect(hasChangedBalance).toBe(true);

    // All players should have currentBalance set
    for (const p of players) {
      expect(p.currentBalance).toBeDefined();
      expect(typeof p.currentBalance).toBe('number');
    }

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('runs a full 10-game lifecycle and emits match_over', {
    timeout: 180_000,
  }, async () => {
    const p1 = await connectPlayer(25, 'FullP1', 100_000);
    const p2 = await connectPlayer(26, 'FullP2', 100_000);
    const p3 = await connectPlayer(27, 'FullP3', 100_000);
    const players = [p1, p2, p3];

    const matchStartedPromises = players.map((p) =>
      waitForMessage(p.ws, 'match_started', MATCH_START_TIMEOUT_MS),
    );
    let gameStartedPromises = players.map((p) =>
      waitForMessage(p.ws, 'game_started', GAME_START_TIMEOUT_MS),
    );

    for (const player of players) {
      player.ws.send(JSON.stringify({ type: 'join_queue' }));
    }

    const started = await Promise.all(matchStartedPromises);
    for (const message of started) {
      expect(message.gameCount).toBe(10);
      expect(message.matchId).toBe(started[0].matchId);
    }

    for (let gameNum = 1; gameNum <= 10; gameNum++) {
      const gameStarted = await Promise.all(gameStartedPromises);
      for (const message of gameStarted) {
        expect(message.game).toBe(gameNum);
        expect(message.phase).toBe('commit');
      }

      const phaseChange = waitForMessage(players[0].ws, 'phase_change', 5_000);
      for (let i = 0; i < players.length; i++) {
        const salt = makeSalt(gameNum, i + 1);
        players[i].ws.send(
          JSON.stringify({ type: 'commit', hash: createCommitHash(0, salt) }),
        );
      }
      const phase = await phaseChange;
      expect(phase.phase).toBe('reveal');

      const gameResult = waitForMessage(players[0].ws, 'game_result', 8_000);
      for (let i = 0; i < players.length; i++) {
        const salt = makeSalt(gameNum, i + 1);
        players[i].ws.send(
          JSON.stringify({ type: 'reveal', optionIndex: 0, salt }),
        );
      }

      const result = await gameResult;
      expect(result.type).toBe('game_result');
      expect(result.result.gameNum).toBe(gameNum);

      if (gameNum < 10) {
        gameStartedPromises = players.map((p) =>
          waitForMessage(p.ws, 'game_started', 15_000),
        );
      }
    }

    const matchOver = await waitForMessage(
      players[0].ws,
      'match_over',
      MATCH_OVER_TIMEOUT_MS,
    );
    expect(matchOver.type).toBe('match_over');
    expect(Array.isArray(matchOver.summary.players)).toBe(true);
    expect(matchOver.summary.players).toHaveLength(3);

    for (const player of players) {
      player.ws.close();
    }
  });
});

import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createCommitHash } from '../../src/domain/commitReveal';
import { createTestSession, createTestWallet, seedAccount } from './helpers';

const BASE = 'https://test.local';

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
    let handler!: (evt: MessageEvent) => void;
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Timed out waiting for "${type}"`));
    }, timeoutMs);
    handler = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    ws.addEventListener('message', handler);
  });
}

/** Connect a seeded player via WebSocket, returning the client socket. */
async function connectPlayer(
  walletIndex: number,
  displayName: string,
  balance = 0,
): Promise<{ ws: WebSocket; accountId: string }> {
  const wallet = createTestWallet(walletIndex);
  const { accountId, cookie } = await createTestSession(wallet);
  await seedAccount(env.DB, accountId, displayName, balance);

  const resp = await exports.default.fetch(
    new Request(`${BASE}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Cookie: `session=${cookie}`,
      },
    }),
  );
  expect(resp.status).toBe(101);
  const ws = resp.webSocket!;
  ws.accept();
  return { ws, accountId };
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

  it('rejects WebSocket without display name (403)', async () => {
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
    expect(resp.status).toBe(403);
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
    expect(joinState!.queuedCount).toBeGreaterThanOrEqual(1);

    // Leave queue
    ws.send(JSON.stringify({ type: 'leave_queue' }));
    const leaveMsgs = await collectMessages(ws, 300);
    const leaveState = leaveMsgs.find((m) => m.type === 'queue_state');
    expect(leaveState).toBeDefined();

    ws.close();
  });

  // The fill timer is 20 seconds; the match starts after it expires.
  it('3 players joining queue triggers match formation', {
    timeout: 30_000,
  }, async () => {
    // Connect 3 players with unique wallet indices
    const p1 = await connectPlayer(0, 'Player1');
    const p2 = await connectPlayer(1, 'Player2');
    const p3 = await connectPlayer(2, 'Player3');

    // Set up listeners for game_started before joining.
    // Timeout must exceed the 20 s fill timer.
    const p1Started = waitForMessage(p1.ws, 'game_started', 25_000);
    const p2Started = waitForMessage(p2.ws, 'game_started', 25_000);
    const p3Started = waitForMessage(p3.ws, 'game_started', 25_000);

    // All join queue
    p1.ws.send(JSON.stringify({ type: 'join_queue' }));
    p2.ws.send(JSON.stringify({ type: 'join_queue' }));
    p3.ws.send(JSON.stringify({ type: 'join_queue' }));

    // All should receive game_started (fill timer or immediate at MIN_MATCH_SIZE)
    const [gs1, gs2, gs3] = await Promise.all([
      p1Started,
      p2Started,
      p3Started,
    ]);

    // Verify game_started has expected structure
    expect(gs1.matchId).toBeTruthy();
    expect(gs1.players).toBeDefined();
    expect(gs1.roundCount).toBe(10);

    // All three should share the same matchId
    expect(gs1.matchId).toBe(gs2.matchId);
    expect(gs2.matchId).toBe(gs3.matchId);

    p1.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('reconnect after commit replays round_start with yourCommitted flag', {
    timeout: 35_000,
  }, async () => {
    // Form a match with 3 players (wallet indices 3/4/8 to avoid collisions)
    const p1 = await connectPlayer(3, 'Reconnector');
    const p2 = await connectPlayer(4, 'Bystander1');
    const p3 = await connectPlayer(8, 'Bystander2');

    const p1Started = waitForMessage(p1.ws, 'game_started', 25_000);
    const p2Started = waitForMessage(p2.ws, 'game_started', 25_000);
    const p3Started = waitForMessage(p3.ws, 'game_started', 25_000);

    p1.ws.send(JSON.stringify({ type: 'join_queue' }));
    p2.ws.send(JSON.stringify({ type: 'join_queue' }));
    p3.ws.send(JSON.stringify({ type: 'join_queue' }));

    // Listen for round_start before awaiting game_started to avoid missing
    // back-to-back messages from the server.
    const p1RoundStart = waitForMessage(p1.ws, 'round_start', 28_000);

    const [gs1] = await Promise.all([p1Started, p2Started, p3Started]);
    const originalMatchId = gs1.matchId;
    expect(originalMatchId).toBeTruthy();

    const roundStart = await p1RoundStart;
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
    // Register both listeners immediately after connectPlayer returns
    // (before any await) so queued replay messages can't dispatch first.
    const p1r = await connectPlayer(3, 'Reconnector');
    const reconnectGameStartedP = waitForMessage(p1r.ws, 'game_started', 3000);
    const reconnectRoundStartP = waitForMessage(p1r.ws, 'round_start', 3000);

    const reconnectGameStarted = await reconnectGameStartedP;
    expect(reconnectGameStarted.matchId).toBe(originalMatchId);

    const reconnectRoundStart = await reconnectRoundStartP;
    expect(reconnectRoundStart.yourCommitted).toBe(true);
    expect(reconnectRoundStart.yourRevealed).toBe(false);

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('reconnect during results phase replays round_result', {
    timeout: 35_000,
  }, async () => {
    // Use wallet indices 10/11/12 to avoid collisions with other tests.
    // Give players a balance so settlement can deduct ante.
    const p1 = await connectPlayer(10, 'ResultP1', 1000);
    const p2 = await connectPlayer(11, 'ResultP2', 1000);
    const p3 = await connectPlayer(12, 'ResultP3', 1000);

    // Listen for game_started before joining queue
    const p1Started = waitForMessage(p1.ws, 'game_started', 25_000);
    const p2Started = waitForMessage(p2.ws, 'game_started', 25_000);
    const p3Started = waitForMessage(p3.ws, 'game_started', 25_000);

    // Listen for round_start on all players before joining
    const p1Round = waitForMessage(p1.ws, 'round_start', 28_000);
    const p2Round = waitForMessage(p2.ws, 'round_start', 28_000);
    const p3Round = waitForMessage(p3.ws, 'round_start', 28_000);

    p1.ws.send(JSON.stringify({ type: 'join_queue' }));
    p2.ws.send(JSON.stringify({ type: 'join_queue' }));
    p3.ws.send(JSON.stringify({ type: 'join_queue' }));

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
    // triggers _finalizeRound which enters results phase.
    const p1Result = waitForMessage(p1.ws, 'round_result', 5000);

    p1.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt1 }));
    p2.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt2 }));
    p3.ws.send(JSON.stringify({ type: 'reveal', optionIndex, salt: salt3 }));

    // Wait for round_result to confirm we are in results phase
    const originalResult = await p1Result;
    expect(originalResult.type).toBe('round_result');

    // Disconnect player 1 and reconnect during results phase
    p1.ws.close();

    const p1r = await connectPlayer(10, 'ResultP1', 1000);
    const reconnectResult = waitForMessage(p1r.ws, 'round_result', 5000);

    const replayedResult = await reconnectResult;
    expect(replayedResult.type).toBe('round_result');
    expect(replayedResult.result).toBeDefined();

    const result = replayedResult.result as Record<string, unknown>;
    expect(result.roundNum).toBe(1);
    expect(result.players).toBeDefined();

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });
});

import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createTestSession, createTestWallet, seedAccount } from './helpers';

const BASE = 'https://test.local';

/** Helper: collect WebSocket messages into an array for a short window. */
function collectMessages(
  ws: WebSocket,
  timeoutMs = 500,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    ws.addEventListener('message', (evt) => {
      messages.push(JSON.parse(evt.data as string));
    });
    setTimeout(() => resolve(messages), timeoutMs);
  });
}

/** Helper: wait for a specific message type from a WebSocket. */
function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${type}"`)),
      timeoutMs,
    );
    ws.addEventListener('message', function handler(evt) {
      const msg = JSON.parse(evt.data as string);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    });
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
});

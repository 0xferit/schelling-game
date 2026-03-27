import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/types/worker-env';
import { handleHttpRequest } from '../../src/worker/httpHandler';
import { buildChallengeMessage } from '../../src/worker/session';
import {
  createTestSession,
  createTestWallet,
  must,
  seedAccount,
} from './helpers';

const HTTPS_BASE = 'https://test.local';
const HTTP_BASE = 'http://test.local';

function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`${HTTPS_BASE}${path}`, { headers }),
  );
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(
    new Request(`${HTTPS_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function postWithBase(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(
    new Request(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function patch(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(
    new Request(`${HTTPS_BASE}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('HTTP routes', () => {
  it('GET /api/leaderboard returns empty array on fresh DB', async () => {
    const resp = await get('/api/leaderboard');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toEqual([]);
  });

  it('GET /api/landing-stats returns recent activity and streak aggregates', async () => {
    const accountA = 'landing-stats-a';
    const accountB = 'landing-stats-b';
    const accountC = 'landing-stats-c';

    await seedAccount(env.DB, accountA, 'Alice');
    await seedAccount(env.DB, accountB, 'Bob');
    await seedAccount(env.DB, accountC, 'Carol');

    const recent = new Date().toISOString();
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO matches (match_id, started_at, ended_at, round_count, player_count, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind('match-recent', recent, recent, 10, 3, 'completed'),
      env.DB.prepare(
        'INSERT INTO matches (match_id, started_at, ended_at, round_count, player_count, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind('match-stale', stale, stale, 10, 2, 'completed'),
      env.DB.prepare(
        'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
      ).bind('match-recent', accountA, 'Alice', 0, 'completed'),
      env.DB.prepare(
        'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
      ).bind('match-recent', accountB, 'Bob', 0, 'completed'),
      env.DB.prepare(
        'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
      ).bind('match-stale', accountC, 'Carol', 0, 'completed'),
      env.DB.prepare(
        'UPDATE player_stats SET longest_streak = ? WHERE account_id = ?',
      ).bind(8, accountB),
    ]);

    const resp = await get('/api/landing-stats');
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as {
      playersLast24h: number;
      completedMatches: number;
      longestStreak: number;
    };
    expect(data.playersLast24h).toBe(2);
    expect(data.completedMatches).toBe(2);
    expect(data.longestStreak).toBe(8);
    expect(resp.headers.get('Cache-Control')).toBe(
      'public, max-age=60, s-maxage=60',
    );
  });

  it('POST /api/auth/challenge falls back when auth_challenges lacks issued_at', async () => {
    const queries: string[] = [];
    const fallbackDb = {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind: (..._params: unknown[]) => ({
            run: async () => {
              if (sql.includes('issued_at')) {
                throw new Error(
                  'table auth_challenges has no column named issued_at',
                );
              }
              return {};
            },
          }),
        };
      },
    } as unknown as D1Database;

    const resp = await handleHttpRequest(
      new Request(`${HTTPS_BASE}/api/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: '0x1234567890123456789012345678901234567890',
        }),
      }),
      {
        DB: fallbackDb,
        GAME_ROOM: {} as DurableObjectNamespace,
      } as Env,
    );

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { message: string };
    expect(data.message).toContain('Issued:');
    expect(queries.some((q) => q.includes('issued_at'))).toBe(true);
    expect(
      queries.some(
        (q) =>
          q.includes('INSERT INTO auth_challenges') && !q.includes('issued_at'),
      ),
    ).toBe(true);
  });

  it('POST /api/auth/challenge returns challengeId and message', async () => {
    const wallet = createTestWallet();
    const resp = await post('/api/auth/challenge', {
      walletAddress: wallet.address,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      challengeId: string;
      message: string;
      expiresAt: string;
    };
    expect(data.challengeId).toMatch(/^ch_/);
    expect(data.message).toContain('Sign this message');
    expect(data.expiresAt).toBeTruthy();
  });

  it('POST /api/auth/verify with valid signature sets session cookie', async () => {
    const wallet = createTestWallet(1);
    const normalized = wallet.address.toLowerCase();

    // Step 1: request challenge
    const challengeResp = await post('/api/auth/challenge', {
      walletAddress: wallet.address,
    });
    const { challengeId, message } = (await challengeResp.json()) as {
      challengeId: string;
      message: string;
    };

    // Step 2: sign and verify
    const signature = await wallet.signMessage(message);
    const verifyResp = await post('/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });
    expect(verifyResp.status).toBe(200);

    const setCookie = verifyResp.headers.get('Set-Cookie');
    expect(setCookie).toContain('session=');

    const body = (await verifyResp.json()) as {
      accountId: string;
      requiresDisplayName: boolean;
    };
    expect(body.accountId).toBe(normalized);
    expect(body.requiresDisplayName).toBe(true);
  });

  it('POST /api/auth/verify accepts legacy challenges with NULL issued_at', async () => {
    const wallet = createTestWallet(7);
    const challengeId = 'ch_legacy_issued_at';
    const nonce = crypto.randomUUID();
    const issuedAt = Date.now();
    const message = buildChallengeMessage(
      wallet.address.toLowerCase(),
      nonce,
      issuedAt,
    );
    const expiresAt = new Date(issuedAt + 5 * 60 * 1000).toISOString();

    await env.DB.prepare(
      'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        challengeId,
        wallet.address.toLowerCase(),
        nonce,
        message,
        expiresAt,
      )
      .run();

    const signature = await wallet.signMessage(message);
    const verifyResp = await post('/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });

    expect(verifyResp.status).toBe(200);
    const body = (await verifyResp.json()) as {
      accountId: string;
      requiresDisplayName: boolean;
    };
    expect(body.accountId).toBe(wallet.address.toLowerCase());
    expect(body.requiresDisplayName).toBe(true);
  });

  it('GET /api/me with valid session returns account data', async () => {
    const wallet = createTestWallet(2);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, 'TestPlayer2', 500);

    const resp = await get('/api/me', { Cookie: `session=${cookie}` });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      accountId: string;
      displayName: string;
      tokenBalance: number;
    };
    expect(data.accountId).toBe(accountId);
    expect(data.displayName).toBe('TestPlayer2');
    expect(data.tokenBalance).toBe(500);
  });

  it('GET /api/me without session returns 401', async () => {
    const resp = await get('/api/me');
    expect(resp.status).toBe(401);
  });

  it('PATCH /api/me/profile sets display name', async () => {
    const wallet = createTestWallet(3);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId);

    const resp = await patch(
      '/api/me/profile',
      { displayName: 'NewName' },
      { Cookie: `session=${cookie}` },
    );
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { displayName: string };
    expect(data.displayName).toBe('NewName');

    // Verify it persisted
    const row = (await env.DB.prepare(
      'SELECT display_name FROM accounts WHERE account_id = ?',
    )
      .bind(accountId)
      .first()) as { display_name: string } | null;
    expect(row?.display_name).toBe('NewName');
  });

  it('GET /api/leaderboard/me returns rank: null for account with no display name', async () => {
    const wallet = createTestWallet(4);
    const { accountId, cookie } = await createTestSession(wallet);
    // Seed with display_name = null (default)
    await seedAccount(env.DB, accountId, null, 100);

    const resp = await get('/api/leaderboard/me', {
      Cookie: `session=${cookie}`,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      rank: number | null;
      leaderboardEligible: boolean;
    };
    expect(data.rank).toBeNull();
    expect(data.leaderboardEligible).toBe(false);
  });

  it('GET /api/leaderboard/me returns rank: null for ineligible account', async () => {
    const wallet = createTestWallet(5);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, 'IneligiblePlayer', 100);
    // Mark account as ineligible
    await env.DB.prepare(
      'UPDATE accounts SET leaderboard_eligible = 0 WHERE account_id = ?',
    )
      .bind(accountId)
      .run();

    const resp = await get('/api/leaderboard/me', {
      Cookie: `session=${cookie}`,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      rank: number | null;
      leaderboardEligible: boolean;
    };
    expect(data.rank).toBeNull();
    expect(data.leaderboardEligible).toBe(false);
  });

  it('GET /api/leaderboard/me returns numeric rank for eligible account', async () => {
    const wallet = createTestWallet(6);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, 'EligiblePlayer', 200);

    const resp = await get('/api/leaderboard/me', {
      Cookie: `session=${cookie}`,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      rank: number | null;
      leaderboardEligible: boolean;
    };
    expect(typeof data.rank).toBe('number');
    expect(data.leaderboardEligible).toBe(true);
  });

  it('POST /api/example-vote + GET /api/example-tally round-trips', async () => {
    const voteResp = await post('/api/example-vote', { optionIndex: 8 });
    expect(voteResp.status).toBe(200);

    const tallyResp = await get('/api/example-tally');
    expect(tallyResp.status).toBe(200);
    const tally = (await tallyResp.json()) as {
      total: number;
      votes: Array<{ optionIndex: number; count: number }>;
    };
    expect(tally.total).toBeGreaterThanOrEqual(1);
    const entry = tally.votes.find((v) => v.optionIndex === 8);
    expect(entry).toBeDefined();
    expect(
      must(entry, 'Expected tally entry for option 8').count,
    ).toBeGreaterThanOrEqual(1);
  });

  // ---- Cookie Secure attribute regression tests (issue #83) ----

  it('/api/auth/verify over HTTPS sets Secure cookie attribute', async () => {
    const wallet = createTestWallet(4);
    const challengeResp = await postWithBase(
      HTTPS_BASE,
      '/api/auth/challenge',
      {
        walletAddress: wallet.address,
      },
    );
    const { challengeId, message } = (await challengeResp.json()) as {
      challengeId: string;
      message: string;
    };
    const signature = await wallet.signMessage(message);
    const verifyResp = await postWithBase(HTTPS_BASE, '/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });
    expect(verifyResp.status).toBe(200);
    const setCookie = must(
      verifyResp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on verify response',
    );
    expect(setCookie).toContain('Secure');
  });

  it('/api/auth/verify over HTTP omits Secure cookie attribute', async () => {
    const wallet = createTestWallet(5);
    const challengeResp = await postWithBase(HTTP_BASE, '/api/auth/challenge', {
      walletAddress: wallet.address,
    });
    const { challengeId, message } = (await challengeResp.json()) as {
      challengeId: string;
      message: string;
    };
    const signature = await wallet.signMessage(message);
    const verifyResp = await postWithBase(HTTP_BASE, '/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });
    expect(verifyResp.status).toBe(200);
    const setCookie = must(
      verifyResp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on verify response',
    );
    expect(setCookie).not.toContain('Secure');
  });

  it('/api/logout over HTTPS sets Secure cookie attribute', async () => {
    const resp = await postWithBase(HTTPS_BASE, '/api/logout', {});
    expect(resp.status).toBe(200);
    const setCookie = must(
      resp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on logout response',
    );
    expect(setCookie).toContain('Secure');
  });

  it('/api/logout over HTTP omits Secure cookie attribute', async () => {
    const resp = await postWithBase(HTTP_BASE, '/api/logout', {});
    expect(resp.status).toBe(200);
    const setCookie = must(
      resp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on logout response',
    );
    expect(setCookie).not.toContain('Secure');
  });

  // ---- Admin auth tests (timingSafeEqual fix) ----

  const ADMIN_KEY = 'test-admin-secret-key';
  const adminEnv = {
    DB: env.DB,
    GAME_ROOM: {} as DurableObjectNamespace,
    ADMIN_KEY,
  } satisfies Env;

  function adminGet(path: string, headers: Record<string, string> = {}) {
    return handleHttpRequest(
      new Request(`${HTTPS_BASE}${path}`, { headers }),
      adminEnv,
    );
  }

  it('admin route with valid Bearer token succeeds', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: `Bearer ${ADMIN_KEY}`,
    });
    expect(resp.status).toBe(200);
  });

  it('admin route with wrong key (same length) returns 401', async () => {
    const wrongKey = 'x'.repeat(ADMIN_KEY.length);
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: `Bearer ${wrongKey}`,
    });
    expect(resp.status).toBe(401);
  });

  it('admin route with shorter key returns 401', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: 'Bearer short',
    });
    expect(resp.status).toBe(401);
  });

  it('admin route with longer key returns 401', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: `Bearer ${ADMIN_KEY}-extra-long-suffix`,
    });
    expect(resp.status).toBe(401);
  });

  it('admin route with empty Authorization header returns 401', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: '',
    });
    expect(resp.status).toBe(401);
  });

  it('admin route without ADMIN_KEY configured returns 503', async () => {
    const resp = await handleHttpRequest(
      new Request(`${HTTPS_BASE}/api/export/votes.csv`),
      {
        DB: env.DB,
        GAME_ROOM: {} as DurableObjectNamespace,
      } as Env,
    );
    expect(resp.status).toBe(503);
  });
});

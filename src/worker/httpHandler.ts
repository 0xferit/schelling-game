import { ethers } from 'ethers';
import {
  COMMIT_DURATION,
  LEADERBOARD_LIMIT,
  REVEAL_DURATION,
} from '../domain/constants';
import type { Env } from '../types/worker-env';
import {
  fetchAccountWithStats,
  fetchPlayerDOStatus,
  type LeaderboardEntryInput,
  shapeLeaderboardEntry,
} from './accountRepo';
import {
  buildChallengeMessage,
  createSessionCookie,
  getAuthenticatedAccountId,
  parseCookies,
  verifySessionCookie,
} from './session';

const DISPLAY_NAME_REGEX = /^[A-Za-z0-9_-]{1,20}$/;
const LANDING_STATS_CACHE_TTL_SECONDS = 60;
const LANDING_STATS_CACHE_CONTROL = `public, max-age=${LANDING_STATS_CACHE_TTL_SECONDS}, s-maxage=${LANDING_STATS_CACHE_TTL_SECONDS}`;
const LANDING_STATS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface CacheStorageWithDefault extends CacheStorage {
  default?: Cache;
}

interface AuthChallengeRow {
  challenge_id: string;
  wallet_address: string;
  nonce: string;
  message: string;
  expires_at: string;
  issued_at?: number | null;
}

function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(data, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function cookieAttrs(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r')
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function isMissingIssuedAtColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('no such column: issued_at') ||
    message.includes('no column named issued_at')
  );
}

async function insertAuthChallenge(
  db: D1Database,
  challengeId: string,
  walletAddress: string,
  nonce: string,
  message: string,
  expiresAt: string,
  issuedAt: number,
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(challengeId, walletAddress, nonce, message, expiresAt, issuedAt)
      .run();
  } catch (error) {
    if (!isMissingIssuedAtColumnError(error)) throw error;

    await db
      .prepare(
        'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(challengeId, walletAddress, nonce, message, expiresAt)
      .run();
  }
}

function parseIssuedAtFromChallengeMessage(message: string): number | null {
  const match = /\nIssued: (\d+)$/.exec(message);
  if (!match) return null;

  const issuedAt = Number(match[1]);
  if (!Number.isSafeInteger(issuedAt)) return null;
  return issuedAt;
}

async function ensureAccountWithStats(
  db: D1Database,
  accountId: string,
): Promise<Awaited<ReturnType<typeof fetchAccountWithStats>>> {
  const existing = await fetchAccountWithStats(db, accountId);
  if (existing) return existing;

  const createdAt = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        'INSERT INTO accounts (account_id, token_balance, leaderboard_eligible, created_at) VALUES (?, 0, 1, ?) ' +
          'ON CONFLICT(account_id) DO NOTHING',
      )
      .bind(accountId, createdAt),
    db
      .prepare(
        'INSERT INTO player_stats (account_id, matches_played, games_played, coherent_games, current_streak, longest_streak) ' +
          'VALUES (?, 0, 0, 0, 0, 0) ON CONFLICT(account_id) DO NOTHING',
      )
      .bind(accountId),
  ]);

  return fetchAccountWithStats(db, accountId);
}

export async function handleHttpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  // ---- WebSocket upgrade: /ws ----
  if (url.pathname === '/ws') {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const accountId = verifySessionCookie(cookies.session);
    if (!accountId) return new Response('Unauthorized', { status: 401 });

    const account = await ensureAccountWithStats(env.DB, accountId);

    if (!account) {
      return new Response('Failed to provision account', { status: 500 });
    }

    const displayName =
      account.display_name ||
      `${accountId.slice(0, 6)}..${accountId.slice(-4)}`;

    const id = env.GAME_ROOM.idFromName('lobby');
    const stub = env.GAME_ROOM.get(id);
    const doUrl = new URL(request.url);
    doUrl.searchParams.set('accountId', accountId);
    doUrl.searchParams.set('displayName', displayName);
    doUrl.searchParams.set('tokenBalance', String(account.token_balance ?? 0));
    return stub.fetch(new Request(doUrl.toString(), request));
  }

  // ---- POST /api/logout ----
  if (url.pathname === '/api/logout' && method === 'POST') {
    return jsonResponse({ ok: true }, 200, {
      'Set-Cookie': `session=; ${cookieAttrs(request)}; Max-Age=0`,
    });
  }

  // ---- POST /api/auth/challenge ----
  if (url.pathname === '/api/auth/challenge' && method === 'POST') {
    let body: { walletAddress?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON');
    }
    const walletAddress = body.walletAddress;
    if (!walletAddress || typeof walletAddress !== 'string') {
      return errorResponse('walletAddress required');
    }
    const normalized = walletAddress.toLowerCase();
    const challengeId = `ch_${crypto.randomUUID()}`;
    const nonce = crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + 5 * 60 * 1000).toISOString();
    const message = buildChallengeMessage(normalized, nonce, issuedAt);

    await insertAuthChallenge(
      env.DB,
      challengeId,
      normalized,
      nonce,
      message,
      expiresAt,
      issuedAt,
    );

    return jsonResponse({ challengeId, message, expiresAt });
  }

  // ---- POST /api/auth/verify ----
  if (url.pathname === '/api/auth/verify' && method === 'POST') {
    let body: {
      challengeId?: string;
      walletAddress?: string;
      signature?: string;
    };
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON');
    }
    const { challengeId, walletAddress, signature } = body;
    if (!challengeId || !walletAddress || !signature) {
      return errorResponse(
        'challengeId, walletAddress, and signature required',
      );
    }
    const normalized = walletAddress.toLowerCase();

    const challenge = (await env.DB.prepare(
      'SELECT * FROM auth_challenges WHERE challenge_id = ? AND wallet_address = ?',
    )
      .bind(challengeId, normalized)
      .first()) as AuthChallengeRow | null;

    if (!challenge) return errorResponse('Invalid or expired challenge', 401);
    const challengeIssuedAt =
      challenge.issued_at ??
      parseIssuedAtFromChallengeMessage(challenge.message);
    if (challengeIssuedAt == null) {
      // Pre-migration challenge row; force client to restart auth
      await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?')
        .bind(challengeId)
        .run();
      return errorResponse(
        'Challenge outdated. Please request a new one.',
        401,
      );
    }
    if (new Date(challenge.expires_at) < new Date()) {
      await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?')
        .bind(challengeId)
        .run();
      return errorResponse('Challenge expired', 401);
    }

    // Verify signature
    let recoveredAddress: string;
    try {
      recoveredAddress = ethers
        .verifyMessage(challenge.message, signature)
        .toLowerCase();
    } catch {
      return errorResponse('Invalid signature', 401);
    }
    if (recoveredAddress !== normalized) {
      return errorResponse('Signature does not match wallet address', 401);
    }

    // Delete used challenge
    await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?')
      .bind(challengeId)
      .run();

    const account = await ensureAccountWithStats(env.DB, normalized);
    if (!account) {
      return errorResponse('Failed to fetch account after upsert', 500);
    }

    const token = createSessionCookie(
      normalized,
      challenge.nonce,
      challengeIssuedAt,
      signature,
    );
    const requiresDisplayName = !account.display_name;

    return jsonResponse(
      {
        accountId: normalized,
        displayName: account.display_name || null,
        requiresDisplayName,
        tokenBalance: account.token_balance ?? 0,
        leaderboardEligible: !!account.leaderboard_eligible,
      },
      200,
      {
        'Set-Cookie': `session=${token}; ${cookieAttrs(request)}; Max-Age=86400`,
      },
    );
  }

  // ---- GET /api/me ----
  if (url.pathname === '/api/me' && method === 'GET') {
    const accountId = await getAuthenticatedAccountId(request);
    if (!accountId) return errorResponse('Unauthorized', 401);

    const account = await ensureAccountWithStats(env.DB, accountId);
    if (!account) return errorResponse('Failed to provision account', 500);

    const queueStatus = await fetchPlayerDOStatus(env, request.url, accountId);

    return jsonResponse({
      accountId: account.account_id,
      displayName: account.display_name || null,
      tokenBalance: account.token_balance ?? 0,
      leaderboardEligible: !!account.leaderboard_eligible,
      queueStatus,
    });
  }

  // ---- PATCH /api/me/profile ----
  if (url.pathname === '/api/me/profile' && method === 'PATCH') {
    const accountId = await getAuthenticatedAccountId(request);
    if (!accountId) return errorResponse('Unauthorized', 401);

    let body: { displayName?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON');
    }
    const displayName = body.displayName;
    if (!displayName || !DISPLAY_NAME_REGEX.test(displayName)) {
      return errorResponse('displayName must be 1-20 characters: A-Za-z0-9_-');
    }

    // Check if player is in queue/match via DO
    const playerStatus = await fetchPlayerDOStatus(env, request.url, accountId);
    if (playerStatus !== 'idle') {
      return errorResponse(
        'Cannot change display name while queued, forming, or in a match',
        409,
      );
    }

    // Check uniqueness
    const existing = (await env.DB.prepare(
      'SELECT account_id FROM accounts WHERE display_name = ? COLLATE NOCASE AND account_id != ?',
    )
      .bind(displayName, accountId)
      .first()) as { account_id: string } | null;
    if (existing) return errorResponse('Display name already claimed', 409);

    await env.DB.prepare(
      'UPDATE accounts SET display_name = ? WHERE account_id = ?',
    )
      .bind(displayName, accountId)
      .run();

    return jsonResponse({ displayName });
  }

  // ---- GET /api/leaderboard ----
  if (url.pathname === '/api/leaderboard' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT a.account_id, a.display_name, a.token_balance, a.leaderboard_eligible, ' +
        's.matches_played, s.games_played, s.coherent_games, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
        'WHERE a.leaderboard_eligible = 1 AND a.display_name IS NOT NULL ' +
        'ORDER BY a.token_balance DESC, COALESCE(s.coherent_games, 0) DESC, a.display_name ASC ' +
        `LIMIT ${LEADERBOARD_LIMIT}`,
    ).all();

    const leaderboard = (results || []).map(
      (r: Record<string, unknown>, i: number) => ({
        rank: i + 1,
        ...shapeLeaderboardEntry(r as unknown as LeaderboardEntryInput),
      }),
    );

    return jsonResponse(leaderboard);
  }

  // ---- GET /api/landing-stats ----
  if (url.pathname === '/api/landing-stats' && method === 'GET') {
    const cache = (globalThis.caches as CacheStorageWithDefault | undefined)
      ?.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    const startedAfter = new Date(
      Date.now() - LANDING_STATS_LOOKBACK_MS,
    ).toISOString();

    const [playersLast24hRow, completedMatchesRow, longestStreakRow] =
      await Promise.all([
        env.DB.prepare(
          'SELECT COUNT(DISTINCT mp.account_id) AS players_last_24h ' +
            'FROM matches m ' +
            'JOIN match_players mp ON mp.match_id = m.match_id ' +
            'WHERE m.started_at >= ? AND m.ai_assisted = 0',
        )
          .bind(startedAfter)
          .first<{ players_last_24h: number }>(),
        env.DB.prepare(
          "SELECT COUNT(*) AS completed_matches FROM matches WHERE status = 'completed' AND ai_assisted = 0",
        ).first<{ completed_matches: number }>(),
        env.DB.prepare(
          'SELECT COALESCE(MAX(longest_streak), 0) AS longest_streak FROM player_stats',
        ).first<{ longest_streak: number }>(),
      ]);

    const response = jsonResponse(
      {
        playersLast24h: playersLast24hRow?.players_last_24h ?? 0,
        completedMatches: completedMatchesRow?.completed_matches ?? 0,
        longestStreak: longestStreakRow?.longest_streak ?? 0,
      },
      200,
      { 'Cache-Control': LANDING_STATS_CACHE_CONTROL },
    );

    if (cache) {
      await cache.put(cacheKey, response.clone());
    }

    return response;
  }

  // ---- GET /api/leaderboard/me ----
  if (url.pathname === '/api/leaderboard/me' && method === 'GET') {
    const accountId = await getAuthenticatedAccountId(request);
    if (!accountId) return errorResponse('Unauthorized', 401);

    const account = await fetchAccountWithStats(env.DB, accountId);
    if (!account) return errorResponse('Account not found', 404);

    const cg = account.coherent_games || 0;
    const eligible =
      account.leaderboard_eligible === 1 && account.display_name !== null;

    let rank: number | null = null;
    if (eligible) {
      const rankRow = (await env.DB.prepare(
        'SELECT COUNT(*) as rank FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
          'WHERE a.leaderboard_eligible = 1 AND a.display_name IS NOT NULL AND (' +
          'a.token_balance > ? OR ' +
          '(a.token_balance = ? AND COALESCE(s.coherent_games, 0) > ?) OR ' +
          '(a.token_balance = ? AND COALESCE(s.coherent_games, 0) = ? AND a.display_name < ?)' +
          ')',
      )
        .bind(
          account.token_balance ?? 0,
          account.token_balance ?? 0,
          cg,
          account.token_balance ?? 0,
          cg,
          account.display_name ?? '',
        )
        .first()) as { rank: number } | null;
      rank = (rankRow?.rank ?? 0) + 1;
    }

    return jsonResponse({
      rank,
      ...shapeLeaderboardEntry(account),
    });
  }

  // ---- Admin auth helper ----
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
  };
  const timingSafeEqual = async (a: string, b: string): Promise<boolean> => {
    const enc = new TextEncoder();
    const [digestA, digestB] = await Promise.all([
      crypto.subtle.digest('SHA-256', enc.encode(a)),
      crypto.subtle.digest('SHA-256', enc.encode(b)),
    ]);
    return subtle.timingSafeEqual(digestA, digestB);
  };

  const requireAdmin = async (): Promise<Response | null> => {
    if (!env.ADMIN_KEY) return errorResponse('ADMIN_KEY not configured', 503);
    const auth = request.headers.get('Authorization') ?? '';
    if (!(await timingSafeEqual(auth, `Bearer ${env.ADMIN_KEY}`))) {
      await new Promise((r) => setTimeout(r, 1000));
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return null;
  };

  // ---- GET /api/export/votes.csv ----
  if (url.pathname === '/api/export/votes.csv' && method === 'GET') {
    const denied = await requireAdmin();
    if (denied) return denied;
    const { results } = await env.DB.prepare(
      'SELECT * FROM vote_logs ORDER BY id ASC',
    ).all();
    const columns = [
      'id',
      'match_id',
      'game_number',
      'question_id',
      'account_id',
      'display_name_snapshot',
      'revealed_option_index',
      'revealed_option_label',
      'won_game',
      'earns_coordination_credit',
      'ante_amount',
      'game_payout',
      'net_delta',
      'player_count',
      'valid_reveal_count',
      'top_count',
      'winner_count',
      'winning_option_indexes_json',
      'voided',
      'void_reason',
      'timestamp',
    ];
    const header = columns.join(',');
    const rows = (results || []).map((r: Record<string, unknown>) =>
      columns.map((c) => escapeCsvField(r[c])).join(','),
    );
    const csv = [header, ...rows].join('\n');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="votes.csv"',
      },
    });
  }

  // ---- POST /api/admin/leaderboard-eligible ----
  if (url.pathname === '/api/admin/leaderboard-eligible' && method === 'POST') {
    const denied = await requireAdmin();
    if (denied) return denied;
    let body: { accountId?: string; eligible?: boolean };
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON');
    }
    const { accountId, eligible } = body;
    if (!accountId || typeof eligible !== 'boolean') {
      return errorResponse('accountId and eligible (boolean) required');
    }
    await env.DB.prepare(
      'UPDATE accounts SET leaderboard_eligible = ? WHERE account_id = ?',
    )
      .bind(eligible ? 1 : 0, accountId.toLowerCase())
      .run();

    return jsonResponse({
      accountId: accountId.toLowerCase(),
      leaderboardEligible: eligible,
    });
  }

  // ---- GET /api/game-config ----
  if (url.pathname === '/api/game-config' && method === 'GET') {
    return jsonResponse({
      commitDuration: COMMIT_DURATION,
      revealDuration: REVEAL_DURATION,
    });
  }

  // ---- POST /api/example-vote ----
  if (url.pathname === '/api/example-vote' && method === 'POST') {
    let body: { optionIndex?: number };
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON');
    }
    const idx = body.optionIndex;
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx > 17
    ) {
      return errorResponse('optionIndex must be an integer 0-17', 400);
    }
    await env.DB.prepare('INSERT INTO example_votes (option_index) VALUES (?)')
      .bind(idx)
      .run();
    return jsonResponse({ ok: true });
  }

  // ---- GET /api/example-tally ----
  if (url.pathname === '/api/example-tally' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT option_index, COUNT(*) as count FROM example_votes GROUP BY option_index',
    ).all();
    const votes = (results || []).map((r: Record<string, unknown>) => ({
      optionIndex: r.option_index as number,
      count: r.count as number,
    }));
    const total = votes.reduce(
      (sum: number, v: { count: number }) => sum + v.count,
      0,
    );
    return jsonResponse({ total, votes });
  }

  // All other paths fall through to static asset serving (configured in wrangler.toml).
  return new Response('Not found', { status: 404 });
}

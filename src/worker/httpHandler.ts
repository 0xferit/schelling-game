import { ethers } from 'ethers';
import { MIN_ESTABLISHED_MATCHES } from '../domain/constants';
import type { Env } from '../types/worker-env';
import {
  buildChallengeMessage,
  createSessionCookie,
  getAuthenticatedAccountId,
  parseCookies,
  verifySessionCookie,
} from './session';

const DISPLAY_NAME_REGEX = /^[A-Za-z0-9_-]{1,20}$/;

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

    const account = (await env.DB.prepare(
      'SELECT a.account_id, a.display_name, a.token_balance, a.leaderboard_eligible, a.created_at, ' +
        's.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
        'WHERE a.account_id = ?',
    )
      .bind(accountId)
      .first()) as {
      account_id: string;
      display_name: string | null;
      token_balance: number;
      leaderboard_eligible: number;
      created_at: string;
      games_played: number;
      rounds_played: number;
      coherent_rounds: number;
      current_streak: number;
      longest_streak: number;
    } | null;

    if (!account?.display_name) {
      return new Response('Profile incomplete', { status: 403 });
    }

    const id = env.GAME_ROOM.idFromName('lobby');
    const stub = env.GAME_ROOM.get(id);
    const doUrl = new URL(request.url);
    doUrl.searchParams.set('accountId', accountId);
    doUrl.searchParams.set('displayName', account.display_name);
    doUrl.searchParams.set('tokenBalance', String(account.token_balance ?? 0));
    return stub.fetch(new Request(doUrl.toString(), request));
  }

  // ---- POST /api/logout ----
  if (url.pathname === '/api/logout' && method === 'POST') {
    return jsonResponse({ ok: true }, 200, {
      'Set-Cookie':
        'session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0',
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

    await env.DB.prepare(
      'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(challengeId, normalized, nonce, message, expiresAt, issuedAt)
      .run();

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
      .first()) as {
      challenge_id: string;
      wallet_address: string;
      nonce: string;
      message: string;
      expires_at: string;
      issued_at: number | null;
    } | null;

    if (!challenge) return errorResponse('Invalid or expired challenge', 401);
    if (challenge.issued_at == null) {
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

    // Upsert account
    await env.DB.prepare(
      'INSERT INTO accounts (account_id, token_balance, leaderboard_eligible, created_at) VALUES (?, 0, 1, ?) ' +
        'ON CONFLICT(account_id) DO NOTHING',
    )
      .bind(normalized, new Date().toISOString())
      .run();

    // Upsert player_stats
    await env.DB.prepare(
      'INSERT INTO player_stats (account_id, games_played, rounds_played, coherent_rounds, current_streak, longest_streak) ' +
        'VALUES (?, 0, 0, 0, 0, 0) ON CONFLICT(account_id) DO NOTHING',
    )
      .bind(normalized)
      .run();

    const account = (await env.DB.prepare(
      'SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id WHERE a.account_id = ?',
    )
      .bind(normalized)
      .first()) as {
      account_id: string;
      display_name: string | null;
      token_balance: number;
      leaderboard_eligible: number;
      games_played: number;
      rounds_played: number;
      coherent_rounds: number;
      current_streak: number;
      longest_streak: number;
    } | null;

    const token = createSessionCookie(
      normalized,
      challenge.nonce,
      challenge.issued_at,
      signature,
    );
    const requiresDisplayName = !account!.display_name;

    return jsonResponse(
      {
        accountId: normalized,
        displayName: account!.display_name || null,
        requiresDisplayName,
        tokenBalance: account!.token_balance ?? 0,
        leaderboardEligible: !!account!.leaderboard_eligible,
      },
      200,
      {
        'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400`,
      },
    );
  }

  // ---- GET /api/me ----
  if (url.pathname === '/api/me' && method === 'GET') {
    const accountId = await getAuthenticatedAccountId(request);
    if (!accountId) return errorResponse('Unauthorized', 401);

    const account = (await env.DB.prepare(
      'SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id WHERE a.account_id = ?',
    )
      .bind(accountId)
      .first()) as {
      account_id: string;
      display_name: string | null;
      token_balance: number;
      leaderboard_eligible: number;
      games_played: number;
      rounds_played: number;
      coherent_rounds: number;
      current_streak: number;
      longest_streak: number;
    } | null;
    if (!account) return errorResponse('Account not found', 404);

    // Query queue status from the DO
    let queueStatus = 'idle';
    try {
      const id = env.GAME_ROOM.idFromName('lobby');
      const stub = env.GAME_ROOM.get(id);
      const statusUrl = new URL(request.url);
      statusUrl.pathname = '/status';
      statusUrl.searchParams.set('accountId', accountId);
      const statusResp = await stub.fetch(new Request(statusUrl.toString()));
      const statusData = (await statusResp.json()) as { status?: string };
      queueStatus = statusData.status || 'idle';
    } catch {
      // DO might not be reachable; default to idle
    }

    return jsonResponse({
      accountId: account.account_id,
      displayName: account.display_name || null,
      tokenBalance: account.token_balance ?? 0,
      leaderboardEligible: !!account.leaderboard_eligible,
      autoRequeue: true,
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
    try {
      const id = env.GAME_ROOM.idFromName('lobby');
      const stub = env.GAME_ROOM.get(id);
      const statusUrl = new URL(request.url);
      statusUrl.pathname = '/status';
      statusUrl.searchParams.set('accountId', accountId);
      const statusResp = await stub.fetch(new Request(statusUrl.toString()));
      const statusData = (await statusResp.json()) as { status?: string };
      if (statusData.status !== 'idle') {
        return errorResponse(
          'Cannot change display name while queued, forming, or in a match',
          409,
        );
      }
    } catch {
      // If DO is unreachable, allow the change
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
        's.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
        'WHERE a.leaderboard_eligible = 1 AND a.display_name IS NOT NULL ' +
        'ORDER BY a.token_balance DESC, s.coherent_rounds DESC, a.display_name ASC ' +
        'LIMIT 100',
    ).all();

    const leaderboard = (results || []).map(
      (r: Record<string, unknown>, i: number) => {
        const gp = (r.games_played as number) || 0;
        const rp = (r.rounds_played as number) || 0;
        const cr = (r.coherent_rounds as number) || 0;
        return {
          rank: i + 1,
          displayName: r.display_name,
          tokenBalance: (r.token_balance as number) ?? 0,
          leaderboardEligible: true,
          gamesPlayed: gp,
          avgNetTokensPerGame:
            gp > 0
              ? Math.round((((r.token_balance as number) ?? 0) / gp) * 100) /
                100
              : 0,
          roundsPlayed: rp,
          coherentRounds: cr,
          coherentPct: rp > 0 ? Math.round((cr / rp) * 100) : 0,
          currentStreak: (r.current_streak as number) || 0,
          longestStreak: (r.longest_streak as number) || 0,
          provisional: gp < MIN_ESTABLISHED_MATCHES,
        };
      },
    );

    return jsonResponse(leaderboard);
  }

  // ---- GET /api/leaderboard/me ----
  if (url.pathname === '/api/leaderboard/me' && method === 'GET') {
    const accountId = await getAuthenticatedAccountId(request);
    if (!accountId) return errorResponse('Unauthorized', 401);

    const account = (await env.DB.prepare(
      'SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id WHERE a.account_id = ?',
    )
      .bind(accountId)
      .first()) as {
      account_id: string;
      display_name: string | null;
      token_balance: number;
      leaderboard_eligible: number;
      games_played: number;
      rounds_played: number;
      coherent_rounds: number;
      current_streak: number;
      longest_streak: number;
    } | null;
    if (!account) return errorResponse('Account not found', 404);

    const rankRow = (await env.DB.prepare(
      'SELECT COUNT(*) as rank FROM accounts WHERE leaderboard_eligible = 1 AND token_balance > ? AND display_name IS NOT NULL',
    )
      .bind(account.token_balance ?? 0)
      .first()) as { rank: number } | null;

    const gp = account.games_played || 0;
    const rp = account.rounds_played || 0;
    const cr = account.coherent_rounds || 0;

    return jsonResponse({
      rank: (rankRow?.rank ?? 0) + 1,
      displayName: account.display_name,
      tokenBalance: account.token_balance ?? 0,
      leaderboardEligible: !!account.leaderboard_eligible,
      gamesPlayed: gp,
      avgNetTokensPerGame:
        gp > 0
          ? Math.round(((account.token_balance ?? 0) / gp) * 100) / 100
          : 0,
      roundsPlayed: rp,
      coherentRounds: cr,
      coherentPct: rp > 0 ? Math.round((cr / rp) * 100) : 0,
      currentStreak: account.current_streak || 0,
      longestStreak: account.longest_streak || 0,
      provisional: gp < MIN_ESTABLISHED_MATCHES,
    });
  }

  // ---- Admin auth helper ----
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
  };
  const timingSafeEqual = (a: string, b: string): boolean => {
    const enc = new TextEncoder();
    const bufA = enc.encode(a);
    const bufB = enc.encode(b);
    if (bufA.byteLength !== bufB.byteLength) {
      subtle.timingSafeEqual(
        bufA.buffer as ArrayBuffer,
        bufA.buffer as ArrayBuffer,
      );
      return false;
    }
    return subtle.timingSafeEqual(
      bufA.buffer as ArrayBuffer,
      bufB.buffer as ArrayBuffer,
    );
  };

  const requireAdmin = async (): Promise<Response | null> => {
    if (!env.ADMIN_KEY) return errorResponse('ADMIN_KEY not configured', 503);
    const auth = request.headers.get('Authorization') ?? '';
    if (!timingSafeEqual(auth, `Bearer ${env.ADMIN_KEY}`)) {
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
      'round_number',
      'question_id',
      'account_id',
      'display_name_snapshot',
      'revealed_option_index',
      'revealed_option_label',
      'won_round',
      'earns_coordination_credit',
      'ante_amount',
      'round_payout',
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

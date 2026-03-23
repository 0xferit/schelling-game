import { ethers } from 'ethers';
import { verifyCommit, validateSalt, validateHash, validateOptionIndex } from './domain/commitReveal.js';
import { settleRound, ROUND_ANTE } from './domain/settlement.js';
import { selectQuestionsForMatch } from './domain/questions.js';

// ---------------------------------------------------------------------------
// Session token helpers (HMAC-signed, stateless)
// ---------------------------------------------------------------------------

const SESSION_SECRET = 'schelling-game-session-v1'; // in production, use env.SESSION_SECRET

async function createSessionToken(accountId) {
  const payload = `${accountId}:${Date.now()}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${payload}:${sig}`;
}

async function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length < 3) return null;
  const sig = parts.pop();
  const payload = parts.join(':');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  const sigBuf = new Uint8Array(sig.match(/.{2}/g).map(h => parseInt(h, 16)));
  const valid = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(payload));
  if (!valid) return null;
  return parts[0]; // accountId is always the first segment
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISPLAY_NAME_REGEX = /^[A-Za-z0-9_-]{1,20}$/;
const TOTAL_ROUNDS = 10;
const COMMIT_DURATION = 60;
const REVEAL_DURATION = 15;
const RESULTS_DURATION = 12;
const FILL_TIMER_MS = 20_000;
const GRACE_DURATION_MS = 15_000;
const MAX_CHAT_LENGTH = 300;
const MAX_MATCH_SIZE = 7;
const MIN_MATCH_SIZE = 3;

// ---------------------------------------------------------------------------
// Helper: authenticated account ID from request
// ---------------------------------------------------------------------------

async function getAuthenticatedAccountId(request) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return verifySessionToken(cookies.session);
}

function jsonResponse(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Worker main handler (REST API)
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // ---- WebSocket upgrade: /ws ----
    if (url.pathname === '/ws') {
      const cookies = parseCookies(request.headers.get('Cookie'));
      const accountId = await verifySessionToken(cookies.session);
      if (!accountId) return new Response('Unauthorized', { status: 401 });

      const account = await env.DB.prepare(
        'SELECT a.account_id, a.display_name, a.token_balance, a.leaderboard_eligible, a.created_at, ' +
        's.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
        'WHERE a.account_id = ?'
      ).bind(accountId).first();

      if (!account || !account.display_name) {
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

    // ---- POST /api/auth/challenge ----
    if (url.pathname === '/api/auth/challenge' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return errorResponse('Invalid JSON'); }
      const walletAddress = body.walletAddress;
      if (!walletAddress || typeof walletAddress !== 'string') {
        return errorResponse('walletAddress required');
      }
      const normalized = walletAddress.toLowerCase();
      const challengeId = `ch_${crypto.randomUUID()}`;
      const nonce = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const message = `Sign this message to authenticate with Schelling Game.\n\nWallet: ${normalized}\nNonce: ${nonce}`;

      await env.DB.prepare(
        'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(challengeId, normalized, nonce, message, expiresAt).run();

      return jsonResponse({ challengeId, message, expiresAt });
    }

    // ---- POST /api/auth/verify ----
    if (url.pathname === '/api/auth/verify' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return errorResponse('Invalid JSON'); }
      const { challengeId, walletAddress, signature } = body;
      if (!challengeId || !walletAddress || !signature) {
        return errorResponse('challengeId, walletAddress, and signature required');
      }
      const normalized = walletAddress.toLowerCase();

      const challenge = await env.DB.prepare(
        'SELECT * FROM auth_challenges WHERE challenge_id = ? AND wallet_address = ?'
      ).bind(challengeId, normalized).first();

      if (!challenge) return errorResponse('Invalid or expired challenge', 401);
      if (new Date(challenge.expires_at) < new Date()) {
        await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?').bind(challengeId).run();
        return errorResponse('Challenge expired', 401);
      }

      // Verify signature
      let recoveredAddress;
      try {
        recoveredAddress = ethers.verifyMessage(challenge.message, signature).toLowerCase();
      } catch {
        return errorResponse('Invalid signature', 401);
      }
      if (recoveredAddress !== normalized) {
        return errorResponse('Signature does not match wallet address', 401);
      }

      // Delete used challenge
      await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?').bind(challengeId).run();

      // Upsert account
      await env.DB.prepare(
        'INSERT INTO accounts (account_id, token_balance, leaderboard_eligible, created_at) VALUES (?, 0, 1, ?) ' +
        'ON CONFLICT(account_id) DO NOTHING'
      ).bind(normalized, new Date().toISOString()).run();

      // Upsert player_stats
      await env.DB.prepare(
        'INSERT INTO player_stats (account_id, games_played, rounds_played, coherent_rounds, current_streak, longest_streak) ' +
        'VALUES (?, 0, 0, 0, 0, 0) ON CONFLICT(account_id) DO NOTHING'
      ).bind(normalized).run();

      const account = await env.DB.prepare(
        'SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id WHERE a.account_id = ?'
      ).bind(normalized).first();

      const token = await createSessionToken(normalized);
      const requiresDisplayName = !account.display_name;

      return jsonResponse({
        accountId: normalized,
        displayName: account.display_name || null,
        requiresDisplayName,
        tokenBalance: account.token_balance ?? 0,
        leaderboardEligible: !!account.leaderboard_eligible,
      }, 200, {
        'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400`,
      });
    }

    // ---- GET /api/me ----
    if (url.pathname === '/api/me' && method === 'GET') {
      const accountId = await getAuthenticatedAccountId(request);
      if (!accountId) return errorResponse('Unauthorized', 401);

      const account = await env.DB.prepare(
        'SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id WHERE a.account_id = ?'
      ).bind(accountId).first();
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
        const statusData = await statusResp.json();
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

      let body;
      try { body = await request.json(); } catch { return errorResponse('Invalid JSON'); }
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
        const statusData = await statusResp.json();
        if (statusData.status !== 'idle') {
          return errorResponse('Cannot change display name while queued, forming, or in a match', 409);
        }
      } catch {
        // If DO is unreachable, allow the change
      }

      // Check uniqueness
      const existing = await env.DB.prepare(
        'SELECT account_id FROM accounts WHERE display_name = ? COLLATE NOCASE AND account_id != ?'
      ).bind(displayName, accountId).first();
      if (existing) return errorResponse('Display name already claimed', 409);

      await env.DB.prepare(
        'UPDATE accounts SET display_name = ? WHERE account_id = ?'
      ).bind(displayName, accountId).run();

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
        'LIMIT 100'
      ).all();

      const leaderboard = (results || []).map((r, i) => {
        const gp = r.games_played || 0;
        const rp = r.rounds_played || 0;
        const cr = r.coherent_rounds || 0;
        return {
          rank: i + 1,
          displayName: r.display_name,
          tokenBalance: r.token_balance ?? 0,
          leaderboardEligible: true,
          gamesPlayed: gp,
          avgNetTokensPerGame: gp > 0 ? Math.round(((r.token_balance ?? 0) / gp) * 100) / 100 : 0,
          roundsPlayed: rp,
          coherentRounds: cr,
          coherentPct: rp > 0 ? Math.round((cr / rp) * 100) : 0,
          currentStreak: r.current_streak || 0,
          longestStreak: r.longest_streak || 0,
        };
      });

      return jsonResponse(leaderboard);
    }

    // ---- GET /api/leaderboard/me ----
    if (url.pathname === '/api/leaderboard/me' && method === 'GET') {
      const accountId = await getAuthenticatedAccountId(request);
      if (!accountId) return errorResponse('Unauthorized', 401);

      const account = await env.DB.prepare(
        'SELECT a.*, s.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
        'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id WHERE a.account_id = ?'
      ).bind(accountId).first();
      if (!account) return errorResponse('Account not found', 404);

      const rankRow = await env.DB.prepare(
        'SELECT COUNT(*) as rank FROM accounts WHERE leaderboard_eligible = 1 AND token_balance > ? AND display_name IS NOT NULL'
      ).bind(account.token_balance ?? 0).first();

      const gp = account.games_played || 0;
      const rp = account.rounds_played || 0;
      const cr = account.coherent_rounds || 0;

      return jsonResponse({
        rank: (rankRow?.rank ?? 0) + 1,
        displayName: account.display_name,
        tokenBalance: account.token_balance ?? 0,
        leaderboardEligible: !!account.leaderboard_eligible,
        gamesPlayed: gp,
        avgNetTokensPerGame: gp > 0 ? Math.round(((account.token_balance ?? 0) / gp) * 100) / 100 : 0,
        roundsPlayed: rp,
        coherentRounds: cr,
        coherentPct: rp > 0 ? Math.round((cr / rp) * 100) : 0,
        currentStreak: account.current_streak || 0,
        longestStreak: account.longest_streak || 0,
      });
    }

    // ---- GET /api/export/votes.csv ----
    if (url.pathname === '/api/export/votes.csv' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM vote_logs ORDER BY id ASC').all();
      const columns = [
        'id', 'match_id', 'round_number', 'question_id', 'account_id', 'display_name_snapshot',
        'revealed_option_index', 'revealed_option_label', 'won_round', 'earns_coordination_credit',
        'ante_amount', 'round_payout', 'net_delta', 'player_count', 'valid_reveal_count',
        'top_count', 'winner_count', 'winning_option_indexes_json', 'voided', 'void_reason', 'timestamp',
      ];
      const header = columns.join(',');
      const rows = (results || []).map(r =>
        columns.map(c => {
          const v = r[c];
          if (v === null || v === undefined) return '';
          return String(v).includes(',') ? `"${String(v)}"` : String(v);
        }).join(',')
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
      // Minimal admin endpoint; production should add proper admin auth.
      let body;
      try { body = await request.json(); } catch { return errorResponse('Invalid JSON'); }
      const { accountId, eligible } = body;
      if (!accountId || typeof eligible !== 'boolean') {
        return errorResponse('accountId and eligible (boolean) required');
      }
      await env.DB.prepare(
        'UPDATE accounts SET leaderboard_eligible = ? WHERE account_id = ?'
      ).bind(eligible ? 1 : 0, accountId.toLowerCase()).run();

      return jsonResponse({ accountId: accountId.toLowerCase(), leaderboardEligible: eligible });
    }

    // All other paths fall through to static asset serving (configured in wrangler.toml).
    return new Response('Not found', { status: 404 });
  },
};

// ===========================================================================
// Durable Object: GameRoom (singleton Lobby)
// ===========================================================================

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // accountId -> { ws, displayName, autoRequeue, previousOpponents: Set }
    this.connections = new Map();

    // FIFO waiting queue: array of accountId
    this.waitingQueue = [];

    // Forming match state (one at a time)
    // { players: [accountId], timer: timeoutId, fillDeadlineMs: number } | null
    this.formingMatch = null;

    // Active matches: matchId -> MatchState
    this.activeMatches = new Map();

    // Quick lookup: accountId -> matchId
    this.playerMatchIndex = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Non-WebSocket: return queue/match status for a player
    if (url.pathname === '/status' && request.method === 'GET') {
      const accountId = url.searchParams.get('accountId');
      const status = this._getPlayerStatus(accountId);
      return Response.json(status);
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const accountId = url.searchParams.get('accountId');
      const displayName = url.searchParams.get('displayName');
      const tokenBalance = parseInt(url.searchParams.get('tokenBalance') || '0', 10);

      if (!accountId || !displayName) {
        return new Response('Missing auth params', { status: 400 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      this._handleWebSocket(server, accountId, displayName, tokenBalance);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  _handleWebSocket(ws, accountId, displayName, tokenBalance) {
    ws.accept();

    // Check for reconnect to an active match
    const existingMatchId = this.playerMatchIndex.get(accountId);
    const existingConn = this.connections.get(accountId);

    if (existingConn && existingMatchId) {
      // Reconnecting to an active match
      const match = this.activeMatches.get(existingMatchId);
      if (match) {
        const playerState = match.players.get(accountId);
        if (playerState && playerState.disconnectedAt && !playerState.forfeited) {
          // Clear grace timer and reattach
          if (playerState.graceTimer) {
            clearTimeout(playerState.graceTimer);
            playerState.graceTimer = null;
          }
          playerState.disconnectedAt = null;
          playerState.ws = ws;
          existingConn.ws = ws;
          this._setupWsListeners(ws, accountId);

          // Broadcast reconnection
          this._broadcastToMatch(match, {
            type: 'player_reconnected',
            displayName,
          });

          // Send current match state to reconnected player
          this._sendMatchStateToPlayer(match, accountId);
          return;
        }
      }
    }

    // Close previous connection if any (not a match reconnect)
    if (existingConn) {
      try { existingConn.ws.close(1000, 'Replaced by new connection'); } catch {}
      // Remove from queue if they were queued
      this._removeFromQueue(accountId);
    }

    this.connections.set(accountId, {
      ws,
      displayName,
      autoRequeue: false,
      previousOpponents: existingConn ? existingConn.previousOpponents : new Set(),
    });

    this._setupWsListeners(ws, accountId);

    // Send initial queue state
    this._sendQueueState(accountId);
  }

  _setupWsListeners(ws, accountId) {
    ws.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        await this._handleMessage(accountId, msg);
      } catch (e) {
        this._sendTo(accountId, { type: 'error', message: e.message || 'Internal error' });
      }
    });

    ws.addEventListener('close', () => {
      this._handleDisconnect(accountId);
    });

    ws.addEventListener('error', () => {
      this._handleDisconnect(accountId);
    });
  }

  // -------------------------------------------------------------------------
  // Message router
  // -------------------------------------------------------------------------

  async _handleMessage(accountId, msg) {
    switch (msg.type) {
      case 'join_queue':  return this._handleJoinQueue(accountId);
      case 'leave_queue': return this._handleLeaveQueue(accountId);
      case 'commit':      return this._handleCommit(accountId, msg);
      case 'reveal':      return this._handleReveal(accountId, msg);
      case 'chat':        return this._handleChat(accountId, msg);
      default:
        this._sendTo(accountId, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  _handleJoinQueue(accountId) {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    // Cannot join if already in a match
    if (this.playerMatchIndex.has(accountId)) {
      return this._sendTo(accountId, { type: 'error', message: 'Cannot join queue while in a match' });
    }
    // Cannot join if already queued
    if (this.waitingQueue.includes(accountId)) {
      return this._sendTo(accountId, { type: 'error', message: 'Already in queue' });
    }
    // Cannot join if in forming match
    if (this.formingMatch && this.formingMatch.players.includes(accountId)) {
      return this._sendTo(accountId, { type: 'error', message: 'Already in forming match' });
    }

    conn.autoRequeue = true;
    this.waitingQueue.push(accountId);
    this._tryFormMatch();
    this._broadcastQueueState();
  }

  _handleLeaveQueue(accountId) {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    conn.autoRequeue = false;
    this._removeFromQueue(accountId);
    this._broadcastQueueState();
  }

  _removeFromQueue(accountId) {
    // Remove from waiting queue
    const idx = this.waitingQueue.indexOf(accountId);
    if (idx !== -1) this.waitingQueue.splice(idx, 1);

    // Remove from forming match
    if (this.formingMatch) {
      const fIdx = this.formingMatch.players.indexOf(accountId);
      if (fIdx !== -1) {
        this.formingMatch.players.splice(fIdx, 1);
        // If forming group drops below 3, cancel formation
        if (this.formingMatch.players.length < MIN_MATCH_SIZE) {
          this._cancelFormingMatch();
        }
      }
    }
  }

  _cancelFormingMatch() {
    if (!this.formingMatch) return;
    if (this.formingMatch.timer) clearTimeout(this.formingMatch.timer);

    // Return remaining players to front of queue in their existing order
    const returning = this.formingMatch.players;
    this.waitingQueue.unshift(...returning);
    this.formingMatch = null;
  }

  _tryFormMatch() {
    // If there is already a forming match, try to add from queue
    if (this.formingMatch) {
      while (this.waitingQueue.length > 0 && this.formingMatch.players.length < MAX_MATCH_SIZE) {
        const nextId = this.waitingQueue.shift();
        this.formingMatch.players.push(nextId);
      }
      // If max reached, start immediately
      if (this.formingMatch.players.length >= MAX_MATCH_SIZE) {
        this._startFormingMatch();
      }
      return;
    }

    // No forming match: need at least 3 in queue to begin
    if (this.waitingQueue.length < MIN_MATCH_SIZE) return;

    // Reserve first 3 (or up to 7)
    const reserveCount = Math.min(this.waitingQueue.length, MAX_MATCH_SIZE);
    const reserved = this.waitingQueue.splice(0, reserveCount);

    if (reserved.length >= MAX_MATCH_SIZE) {
      // Full house: start immediately
      this.formingMatch = { players: reserved, timer: null, fillDeadlineMs: null };
      this._startFormingMatch();
      return;
    }

    // Start 20s fill timer
    const fillDeadlineMs = Date.now() + FILL_TIMER_MS;
    const timer = setTimeout(() => this._onFillTimerExpired(), FILL_TIMER_MS);
    this.formingMatch = { players: reserved, timer, fillDeadlineMs };
  }

  _onFillTimerExpired() {
    if (!this.formingMatch) return;
    this._startFormingMatch();
  }

  _startFormingMatch() {
    if (!this.formingMatch) return;
    if (this.formingMatch.timer) {
      clearTimeout(this.formingMatch.timer);
      this.formingMatch.timer = null;
    }

    let players = this.formingMatch.players;

    // Ensure odd count: take largest odd <= current size
    if (players.length % 2 === 0) {
      // Return the most recently reserved extra player(s) to front of queue
      const extras = players.splice(players.length - 1, 1);
      this.waitingQueue.unshift(...extras);
    }

    // Should still have at least 3
    if (players.length < MIN_MATCH_SIZE) {
      this.waitingQueue.unshift(...players);
      this.formingMatch = null;
      this._broadcastQueueState();
      return;
    }

    const matchId = crypto.randomUUID();
    this.formingMatch = null;

    this._startMatch(players, matchId);
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  async _startMatch(playerIds, matchId) {
    const questions = selectQuestionsForMatch(TOTAL_ROUNDS);

    const playersMap = new Map();
    for (const accountId of playerIds) {
      const conn = this.connections.get(accountId);
      if (!conn) continue;

      // Load current balance from D1
      let balance = 0;
      try {
        const row = await this.env.DB.prepare(
          'SELECT token_balance FROM accounts WHERE account_id = ?'
        ).bind(accountId).first();
        if (row) balance = row.token_balance ?? 0;
      } catch {}

      playersMap.set(accountId, {
        accountId,
        displayName: conn.displayName,
        ws: conn.ws,
        startingBalance: balance,
        currentBalance: balance,
        committed: false,
        revealed: false,
        hash: null,
        optionIndex: null,
        salt: null,
        forfeited: false,
        disconnectedAt: null,
        graceTimer: null,
      });

      this.playerMatchIndex.set(accountId, matchId);
    }

    const match = {
      matchId,
      players: playersMap,
      questions,
      currentRound: 0,
      totalRounds: TOTAL_ROUNDS,
      phase: 'starting',
      commitTimer: null,
      revealTimer: null,
      resultsTimer: null,
    };
    this.activeMatches.set(matchId, match);

    // Create match record in D1
    try {
      await this.env.DB.prepare(
        'INSERT INTO matches (match_id, started_at, round_count, status) VALUES (?, ?, ?, ?)'
      ).bind(matchId, new Date().toISOString(), TOTAL_ROUNDS, 'active').run();

      for (const [acctId, p] of playersMap) {
        await this.env.DB.prepare(
          'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)'
        ).bind(matchId, acctId, p.displayName, p.startingBalance, 'active').run();
      }
    } catch {}

    // Broadcast game_started
    const playersInfo = [...playersMap.values()].map(p => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    }));

    this._broadcastToMatch(match, {
      type: 'game_started',
      matchId,
      roundCount: TOTAL_ROUNDS,
      players: playersInfo,
    });

    // Start round 1
    this._startCommitPhase(match);
  }

  _startCommitPhase(match) {
    match.phase = 'commit';
    match.currentRound++;
    const question = match.questions[match.currentRound - 1];

    // Reset per-round player state
    for (const p of match.players.values()) {
      p.committed = false;
      p.revealed = false;
      p.hash = null;
      p.optionIndex = null;
      p.salt = null;
    }

    this._broadcastToMatch(match, {
      type: 'round_start',
      round: match.currentRound,
      question: {
        id: question.id,
        text: question.text,
        type: question.type,
        options: question.options,
      },
      commitDuration: COMMIT_DURATION,
      roundAnte: ROUND_ANTE,
      phase: 'commit',
    });

    match.commitTimer = setTimeout(() => {
      this._startRevealPhase(match);
    }, COMMIT_DURATION * 1000);
  }

  _startRevealPhase(match) {
    if (match.commitTimer) { clearTimeout(match.commitTimer); match.commitTimer = null; }
    match.phase = 'reveal';

    this._broadcastToMatch(match, {
      type: 'phase_change',
      phase: 'reveal',
      revealDuration: REVEAL_DURATION,
    });

    match.revealTimer = setTimeout(() => {
      this._finalizeRound(match);
    }, REVEAL_DURATION * 1000);
  }

  async _finalizeRound(match) {
    if (match.revealTimer) { clearTimeout(match.revealTimer); match.revealTimer = null; }
    match.phase = 'results';

    const question = match.questions[match.currentRound - 1];

    // Build player array for settlement
    const settlementPlayers = [...match.players.values()].map(p => ({
      accountId: p.accountId,
      displayName: p.displayName,
      optionIndex: p.revealed ? p.optionIndex : null,
      validReveal: p.committed && p.revealed && !p.forfeited,
      forfeited: p.forfeited,
      attached: true,
    }));

    const result = settleRound(settlementPlayers, question);

    // Apply balance changes and update match state
    for (const pr of result.players) {
      const playerState = match.players.get(pr.accountId);
      if (!playerState) continue;

      playerState.currentBalance += pr.netDelta;
      pr.newBalance = playerState.currentBalance;

      // Resolve option label for vote log
      pr.revealedOptionLabel = pr.revealedOptionIndex !== null
        ? (question.options[pr.revealedOptionIndex] || null)
        : null;

      // Update D1 balance
      try {
        await this.env.DB.prepare(
          'UPDATE accounts SET token_balance = ? WHERE account_id = ?'
        ).bind(playerState.currentBalance, pr.accountId).run();
      } catch {}

      // Update stats
      if (!result.voided) {
        try {
          // Increment rounds_played
          await this.env.DB.prepare(
            'UPDATE player_stats SET rounds_played = rounds_played + 1 WHERE account_id = ?'
          ).bind(pr.accountId).run();

          if (pr.earnsCoordinationCredit) {
            await this.env.DB.prepare(
              'UPDATE player_stats SET coherent_rounds = coherent_rounds + 1, ' +
              'current_streak = current_streak + 1, ' +
              'longest_streak = MAX(longest_streak, current_streak + 1) ' +
              'WHERE account_id = ?'
            ).bind(pr.accountId).run();
          } else {
            // Lost or no coordination credit: reset streak
            await this.env.DB.prepare(
              'UPDATE player_stats SET current_streak = 0 WHERE account_id = ?'
            ).bind(pr.accountId).run();
          }
        } catch {}
      }

      // Insert vote log
      try {
        await this.env.DB.prepare(
          'INSERT INTO vote_logs (match_id, round_number, question_id, account_id, display_name_snapshot, ' +
          'revealed_option_index, revealed_option_label, won_round, earns_coordination_credit, ' +
          'ante_amount, round_payout, net_delta, player_count, valid_reveal_count, top_count, ' +
          'winner_count, winning_option_indexes_json, voided, void_reason, timestamp) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          match.matchId,
          match.currentRound,
          question.id,
          pr.accountId,
          pr.displayName,
          pr.revealedOptionIndex,
          pr.revealedOptionLabel,
          pr.wonRound ? 1 : 0,
          pr.earnsCoordinationCredit ? 1 : 0,
          pr.antePaid,
          pr.roundPayout,
          pr.netDelta,
          result.playerCount,
          result.validRevealCount,
          result.topCount,
          result.winnerCount,
          JSON.stringify(result.winningOptionIndexes),
          result.voided ? 1 : 0,
          result.voidReason,
          new Date().toISOString(),
        ).run();
      } catch {}
    }

    // Broadcast round_result
    this._broadcastToMatch(match, {
      type: 'round_result',
      result: {
        roundNum: match.currentRound,
        voided: result.voided,
        voidReason: result.voidReason,
        playerCount: result.playerCount,
        pot: result.pot,
        winningOptionIndexes: result.winningOptionIndexes,
        winnerCount: result.winnerCount,
        payoutPerWinner: result.payoutPerWinner,
        players: result.players.map(pr => ({
          displayName: pr.displayName,
          revealedOptionIndex: pr.revealedOptionIndex,
          wonRound: pr.wonRound,
          earnsCoordinationCredit: pr.earnsCoordinationCredit,
          antePaid: pr.antePaid,
          roundPayout: pr.roundPayout,
          netDelta: pr.netDelta,
          newBalance: pr.newBalance,
        })),
      },
    });

    // Check early termination: no non-forfeited players remain
    const nonForfeited = [...match.players.values()].filter(p => !p.forfeited);
    if (nonForfeited.length === 0) {
      // End match immediately after results display
      match.resultsTimer = setTimeout(() => this._endMatch(match), RESULTS_DURATION * 1000);
      return;
    }

    // After results display, advance
    match.resultsTimer = setTimeout(() => {
      if (match.currentRound >= match.totalRounds) {
        this._endMatch(match);
      } else {
        this._startCommitPhase(match);
      }
    }, RESULTS_DURATION * 1000);
  }

  async _endMatch(match) {
    if (match.resultsTimer) { clearTimeout(match.resultsTimer); match.resultsTimer = null; }
    if (match.commitTimer) { clearTimeout(match.commitTimer); match.commitTimer = null; }
    if (match.revealTimer) { clearTimeout(match.revealTimer); match.revealTimer = null; }
    match.phase = 'ended';

    const summary = {
      players: [...match.players.values()].map(p => ({
        displayName: p.displayName,
        startingBalance: p.startingBalance,
        endingBalance: p.currentBalance,
        netDelta: p.currentBalance - p.startingBalance,
        result: p.forfeited ? 'forfeited' : 'completed',
      })),
    };

    this._broadcastToMatch(match, { type: 'game_over', summary });

    // Update D1 match record
    try {
      await this.env.DB.prepare(
        'UPDATE matches SET ended_at = ?, status = ? WHERE match_id = ?'
      ).bind(new Date().toISOString(), 'completed', match.matchId).run();

      // Update match_players
      for (const p of match.players.values()) {
        await this.env.DB.prepare(
          'UPDATE match_players SET ending_balance = ?, net_delta = ?, result = ? WHERE match_id = ? AND account_id = ?'
        ).bind(
          p.currentBalance,
          p.currentBalance - p.startingBalance,
          p.forfeited ? 'forfeited' : 'completed',
          match.matchId,
          p.accountId,
        ).run();

        // Increment games_played
        await this.env.DB.prepare(
          'UPDATE player_stats SET games_played = games_played + 1 WHERE account_id = ?'
        ).bind(p.accountId).run();
      }
    } catch {}

    // Track opponents for anti-repeat
    const matchPlayerIds = [...match.players.keys()];
    for (const accountId of matchPlayerIds) {
      const conn = this.connections.get(accountId);
      if (conn) {
        conn.previousOpponents = new Set(matchPlayerIds.filter(id => id !== accountId));
      }
    }

    // Clean up match
    this.activeMatches.delete(match.matchId);
    for (const accountId of matchPlayerIds) {
      this.playerMatchIndex.delete(accountId);
    }

    // Auto-requeue non-forfeited players with autoRequeue enabled
    for (const p of match.players.values()) {
      if (p.forfeited) continue;
      const conn = this.connections.get(p.accountId);
      if (conn && conn.autoRequeue) {
        // Refresh balance from D1 before requeueing
        try {
          const row = await this.env.DB.prepare(
            'SELECT token_balance FROM accounts WHERE account_id = ?'
          ).bind(p.accountId).first();
          if (row) {
            // balance is already updated in D1, just requeue
          }
        } catch {}
        this.waitingQueue.push(p.accountId);
      }
    }

    this._tryFormMatch();
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Commit / Reveal / Chat handlers
  // -------------------------------------------------------------------------

  async _handleCommit(accountId, msg) {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) return this._sendTo(accountId, { type: 'error', message: 'Not in a match' });
    const match = this.activeMatches.get(matchId);
    if (!match) return this._sendTo(accountId, { type: 'error', message: 'Match not found' });
    if (match.phase !== 'commit') {
      return this._sendTo(accountId, { type: 'error', message: 'Not in commit phase' });
    }
    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, { type: 'error', message: 'You have been forfeited' });
    }
    if (player.committed) {
      return this._sendTo(accountId, { type: 'error', message: 'Already committed' });
    }

    const { hash } = msg;
    if (!validateHash(hash)) {
      return this._sendTo(accountId, { type: 'error', message: 'Invalid hash format (expected 64-char hex)' });
    }

    player.committed = true;
    player.hash = hash;

    // Broadcast commit status
    this._broadcastCommitStatus(match);

    // Auto-advance if all non-forfeited players committed
    if (this._allNonForfeitedCommitted(match)) {
      this._startRevealPhase(match);
    }
  }

  async _handleReveal(accountId, msg) {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) return this._sendTo(accountId, { type: 'error', message: 'Not in a match' });
    const match = this.activeMatches.get(matchId);
    if (!match) return this._sendTo(accountId, { type: 'error', message: 'Match not found' });
    if (match.phase !== 'reveal') {
      return this._sendTo(accountId, { type: 'error', message: 'Not in reveal phase' });
    }
    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, { type: 'error', message: 'You have been forfeited' });
    }
    if (!player.committed) {
      return this._sendTo(accountId, { type: 'error', message: 'Did not commit this round' });
    }
    if (player.revealed) {
      return this._sendTo(accountId, { type: 'error', message: 'Already revealed' });
    }

    const { optionIndex, salt } = msg;
    const question = match.questions[match.currentRound - 1];

    if (!validateOptionIndex(optionIndex, question.options.length)) {
      return this._sendTo(accountId, { type: 'error', message: 'Invalid option index' });
    }
    if (!validateSalt(salt)) {
      return this._sendTo(accountId, { type: 'error', message: 'Salt must be a hex string of at least 32 characters' });
    }

    // Verify hash
    const valid = await verifyCommit(optionIndex, salt, player.hash);
    if (!valid) {
      return this._sendTo(accountId, { type: 'error', message: 'Hash mismatch: reveal does not match commitment' });
    }

    player.revealed = true;
    player.optionIndex = optionIndex;
    player.salt = salt;

    // Broadcast reveal status
    this._broadcastRevealStatus(match);

    // Auto-advance if all committed non-forfeited players revealed
    if (this._allCommittedNonForfeitedRevealed(match)) {
      this._finalizeRound(match);
    }
  }

  _handleChat(accountId, msg) {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) return this._sendTo(accountId, { type: 'error', message: 'Chat only allowed during commit phase' });
    const match = this.activeMatches.get(matchId);
    if (!match || match.phase !== 'commit') {
      return this._sendTo(accountId, { type: 'error', message: 'Chat only allowed during commit phase' });
    }
    const player = match.players.get(accountId);
    if (!player || player.forfeited) return;

    const text = String(msg.text || '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    const messageId = crypto.randomUUID();
    this._broadcastToMatch(match, {
      type: 'chat',
      from: player.displayName,
      text,
      messageId,
    });
  }

  // -------------------------------------------------------------------------
  // Disconnect / Reconnect / Forfeit
  // -------------------------------------------------------------------------

  _handleDisconnect(accountId) {
    const matchId = this.playerMatchIndex.get(accountId);

    if (!matchId) {
      // Not in a match: remove from queue and forming match
      this._removeFromQueue(accountId);
      this.connections.delete(accountId);
      this._broadcastQueueState();
      return;
    }

    // In a match: start grace timer
    const match = this.activeMatches.get(matchId);
    if (!match) {
      this.connections.delete(accountId);
      return;
    }

    const player = match.players.get(accountId);
    if (!player || player.forfeited) {
      this.connections.delete(accountId);
      return;
    }

    player.disconnectedAt = Date.now();

    // Broadcast disconnection
    this._broadcastToMatch(match, {
      type: 'player_disconnected',
      displayName: player.displayName,
      graceSeconds: GRACE_DURATION_MS / 1000,
    });

    // Start 15s grace timer
    player.graceTimer = setTimeout(() => {
      this._forfeitPlayer(match, accountId);
    }, GRACE_DURATION_MS);
  }

  _forfeitPlayer(match, accountId) {
    const player = match.players.get(accountId);
    if (!player || player.forfeited) return;

    player.forfeited = true;
    player.graceTimer = null;

    this._broadcastToMatch(match, {
      type: 'player_forfeited',
      displayName: player.displayName,
      autoLosesRemainingRounds: true,
    });

    // If all players are now forfeited, check for early termination
    // This is handled naturally in _finalizeRound via the non-forfeited check.
    // But we also need to check if this forfeit triggers auto-advance:

    // During commit phase: if all non-forfeited have committed, advance
    if (match.phase === 'commit' && this._allNonForfeitedCommitted(match)) {
      this._startRevealPhase(match);
    }
    // During reveal phase: if all committed non-forfeited have revealed, advance
    if (match.phase === 'reveal' && this._allCommittedNonForfeitedRevealed(match)) {
      this._finalizeRound(match);
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  _sendTo(accountId, msg) {
    const conn = this.connections.get(accountId);
    if (!conn) return;
    try { conn.ws.send(JSON.stringify(msg)); } catch {}
  }

  _broadcastToMatch(match, msg) {
    const data = JSON.stringify(msg);
    for (const p of match.players.values()) {
      if (!p.forfeited || msg.type === 'game_over') {
        try { p.ws.send(data); } catch {}
      }
    }
  }

  _broadcastCommitStatus(match) {
    const committed = [...match.players.values()].map(p => ({
      displayName: p.displayName,
      hasCommitted: p.committed,
    }));
    this._broadcastToMatch(match, { type: 'commit_status', committed });
  }

  _broadcastRevealStatus(match) {
    const revealed = [...match.players.values()].map(p => ({
      displayName: p.displayName,
      hasRevealed: p.revealed,
    }));
    this._broadcastToMatch(match, { type: 'reveal_status', revealed });
  }

  _sendQueueState(accountId) {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    const isQueued = this.waitingQueue.includes(accountId) ||
      (this.formingMatch && this.formingMatch.players.includes(accountId));

    this._sendTo(accountId, this._buildQueueStateMsg(accountId, isQueued, conn.autoRequeue));
  }

  _broadcastQueueState() {
    // Send to all connected players NOT in an active match
    for (const [accountId, conn] of this.connections) {
      if (this.playerMatchIndex.has(accountId)) continue;

      const isQueued = this.waitingQueue.includes(accountId) ||
        (this.formingMatch && this.formingMatch.players.includes(accountId));

      const msg = this._buildQueueStateMsg(accountId, isQueued, conn.autoRequeue);
      try { conn.ws.send(JSON.stringify(msg)); } catch {}
    }
  }

  _buildQueueStateMsg(accountId, isQueued, autoRequeue) {
    // All queued + forming display names
    const allQueuedIds = [...this.waitingQueue];
    if (this.formingMatch) {
      allQueuedIds.unshift(...this.formingMatch.players);
    }
    const queuedPlayers = allQueuedIds.map(id => {
      const c = this.connections.get(id);
      return c ? c.displayName : 'unknown';
    });

    let formingMatch = null;
    if (this.formingMatch) {
      const fmPlayers = this.formingMatch.players.map(id => {
        const c = this.connections.get(id);
        return c ? c.displayName : 'unknown';
      });
      formingMatch = {
        playerCount: this.formingMatch.players.length,
        players: fmPlayers,
        allowedSizes: [3, 5, 7].filter(s => s <= this.formingMatch.players.length + this.waitingQueue.length),
        fillDeadlineMs: this.formingMatch.fillDeadlineMs,
      };
    }

    return {
      type: 'queue_state',
      status: isQueued ? 'queued' : 'idle',
      autoRequeue,
      queuedCount: allQueuedIds.length,
      queuedPlayers,
      formingMatch,
    };
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  _getPlayerStatus(accountId) {
    if (this.playerMatchIndex.has(accountId)) {
      return { status: 'in_match', matchId: this.playerMatchIndex.get(accountId) };
    }
    if (this.formingMatch && this.formingMatch.players.includes(accountId)) {
      return { status: 'forming' };
    }
    if (this.waitingQueue.includes(accountId)) {
      return { status: 'queued' };
    }
    return { status: 'idle' };
  }

  _allNonForfeitedCommitted(match) {
    for (const p of match.players.values()) {
      if (!p.forfeited && !p.committed) return false;
    }
    return true;
  }

  _allCommittedNonForfeitedRevealed(match) {
    for (const p of match.players.values()) {
      if (!p.forfeited && p.committed && !p.revealed) return false;
    }
    return true;
  }

  _sendMatchStateToPlayer(match, accountId) {
    const question = match.questions[match.currentRound - 1];
    const player = match.players.get(accountId);
    if (!player) return;

    // Send game_started so the client knows the match context
    const playersInfo = [...match.players.values()].map(p => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    }));
    this._sendTo(accountId, {
      type: 'game_started',
      matchId: match.matchId,
      roundCount: match.totalRounds,
      players: playersInfo,
    });

    // Send current round info
    if (match.phase === 'commit' || match.phase === 'reveal' || match.phase === 'results') {
      this._sendTo(accountId, {
        type: 'round_start',
        round: match.currentRound,
        question: {
          id: question.id,
          text: question.text,
          type: question.type,
          options: question.options,
        },
        commitDuration: COMMIT_DURATION,
        roundAnte: ROUND_ANTE,
        phase: match.phase,
      });

      if (match.phase === 'reveal' || match.phase === 'results') {
        this._sendTo(accountId, {
          type: 'phase_change',
          phase: match.phase === 'results' ? 'results' : 'reveal',
          revealDuration: REVEAL_DURATION,
        });
      }

      // Send commit status
      this._sendTo(accountId, {
        type: 'commit_status',
        committed: [...match.players.values()].map(p => ({
          displayName: p.displayName,
          hasCommitted: p.committed,
        })),
      });

      // Send reveal status if in reveal or results
      if (match.phase === 'reveal' || match.phase === 'results') {
        this._sendTo(accountId, {
          type: 'reveal_status',
          revealed: [...match.players.values()].map(p => ({
            displayName: p.displayName,
            hasRevealed: p.revealed,
          })),
        });
      }
    }
  }
}

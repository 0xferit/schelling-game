import { verifyCommit, computeRoundResult, applyBalanceChanges } from './gameLogic.js';
import QUESTIONS from './questions.js';

const STARTING_BALANCE = 1000;
const ROUND_STAKE = 100;
const COMMIT_DURATION_NORMAL = 30;
const COMMIT_DURATION_ESTIMATION = 60;
const REVEAL_DURATION = 15;
const RESULTS_DURATION = 12;
const MAX_CHAT_LENGTH = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const roomCode = url.searchParams.get('room');
      if (!roomCode) return new Response('missing room', { status: 400 });
      const id = env.GAME_ROOM.idFromName(roomCode.toUpperCase());
      return env.GAME_ROOM.get(id).fetch(request);
    }
    if (url.pathname === '/api/leaderboard') {
      const { results } = await env.DB.prepare('SELECT * FROM players ORDER BY global_score DESC, coherent_rounds DESC LIMIT 50').all();
      return Response.json(results);
    }
    if (url.pathname === '/api/leaderboard/me') {
      const username = url.searchParams.get('username');
      if (!username) return Response.json({ error: 'username required' }, { status: 400 });
      const player = await env.DB.prepare('SELECT * FROM players WHERE username = ?').bind(username).first();
      if (!player) return Response.json({ error: 'Player not found' }, { status: 404 });
      const rankRow = await env.DB.prepare('SELECT COUNT(*) as rank FROM players WHERE global_score > ?').bind(player.global_score).first();
      return Response.json({ ...player, rank: (rankRow?.rank ?? 0) + 1 });
    }
    if (url.pathname === '/api/export/votes.csv') {
      const { results } = await env.DB.prepare('SELECT * FROM vote_logs ORDER BY id ASC').all();
      const headers = ['id','session_id','round_number','question_id','username','revealed_score','mu','sigma','is_coherent','created_at'];
      const csv = [headers.join(','), ...results.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
      return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="votes.csv"' } });
    }
    return new Response('Not found', { status: 404 });
  }
};

function selectQuestions(totalRounds) {
  const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, totalRounds);
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // sessionKey -> { ws, username, balance, committed, revealed, score, hash, salt, isConnected, coherentRoundsThisGame }
    this.roomCode = null;
    this.host = null;
    this.phase = 'lobby';
    this.currentRound = 0;
    this.totalRounds = 10;
    this.questions = [];
    this.chatMessages = [];
    this.leakReports = [];
    this.roundTimer = null;
    this.sessionId = null;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Extract room code from the request URL
    const url = new URL(request.url);
    const roomCode = url.searchParams.get('room');
    if (roomCode && !this.roomCode) {
      this.roomCode = roomCode.toUpperCase();
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws) {
    ws.accept();
    const sessionKey = crypto.randomUUID();
    this.sessions.set(sessionKey, {
      ws,
      username: null,
      balance: STARTING_BALANCE,
      committed: false,
      revealed: false,
      score: null,
      hash: null,
      salt: null,
      isConnected: true,
      coherentRoundsThisGame: 0,
    });

    ws.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        await this.handleMessage(sessionKey, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    });

    ws.addEventListener('close', () => {
      const session = this.sessions.get(sessionKey);
      if (session && session.username) {
        session.isConnected = false;
        this.broadcastRoomState();
      }
      if (session && !session.username) {
        this.sessions.delete(sessionKey);
      }
    });
  }

  async handleMessage(sessionKey, msg) {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    switch (msg.type) {
      case 'join':        return this.handleJoin(sessionKey, msg);
      case 'start_game':  return this.handleStartGame(sessionKey);
      case 'commit':      return this.handleCommit(sessionKey, msg);
      case 'reveal':      return this.handleReveal(sessionKey, msg);
      case 'chat':        return this.handleChat(sessionKey, msg);
      case 'report_leak': return this.handleReportLeak(sessionKey, msg);
      default:
        session.ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  }

  handleJoin(sessionKey, msg) {
    const session = this.sessions.get(sessionKey);
    const username = msg.username?.trim().slice(0, 20);
    if (!username) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'username required' }));
    }

    const roundCount = msg.roundCount;
    const code = (msg.roomCode || this.roomCode || '').toUpperCase();

    // Check if this username is already taken by another connected session
    for (const [key, s] of this.sessions) {
      if (key !== sessionKey && s.username === username && s.isConnected) {
        return session.ws.send(JSON.stringify({ type: 'error', message: 'Username already taken' }));
      }
    }

    // Reconnect: find existing disconnected session for this username
    let activeSession = session;
    for (const [key, s] of this.sessions) {
      if (key !== sessionKey && s.username === username && !s.isConnected) {
        // Transfer ws to existing session, remove new session entry
        s.ws = session.ws;
        s.isConnected = true;
        this.sessions.delete(sessionKey);
        activeSession = s;
        break;
      }
    }

    if (activeSession === session) {
      // New player (not reconnecting)
      if (this.phase !== 'lobby') {
        return session.ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' }));
      }
      session.username = username;
      session.isConnected = true;
    }

    // Set host (first player to join)
    if (!this.host) {
      this.host = username;
    }

    // Set room code and total rounds from first joiner
    if (!this.roomCode) {
      this.roomCode = code;
    }
    if (roundCount && [5, 7, 10].includes(roundCount) && this.phase === 'lobby') {
      this.totalRounds = roundCount;
    }

    // Send room_state to the joining player (with myBalance)
    activeSession.ws.send(JSON.stringify({
      type: 'room_state',
      room: this.getRoomInfo(),
      players: this.getPublicPlayers(),
      myBalance: activeSession.balance,
    }));

    // Broadcast room_state to all other players
    this.broadcastRoomState(username);
  }

  handleStartGame(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.username) return;

    if (session.username !== this.host) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Only the host can start the game' }));
    }
    if (this.phase !== 'lobby') {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Game already started' }));
    }

    const playerCount = [...this.sessions.values()].filter(s => s.username && s.isConnected).length;
    if (playerCount < 1) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Need at least 1 player' }));
    }

    // Initialize game
    if (!this.sessionId) {
      this.sessionId = crypto.randomUUID();
    }
    this.questions = selectQuestions(this.totalRounds);
    this.currentRound = 0;

    // Reset balances
    for (const s of this.sessions.values()) {
      if (s.username) {
        s.balance = STARTING_BALANCE;
        s.coherentRoundsThisGame = 0;
      }
    }

    // Broadcast game_started
    this.broadcast({
      type: 'game_started',
      roundCount: this.totalRounds,
      firstRound: {
        round: 1,
        question: this.questions[0],
      },
    });

    // Start first commit phase
    this.startCommitPhase();
  }

  handleCommit(sessionKey, msg) {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.username) return;
    if (this.phase !== 'commit') {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Not in commit phase' }));
    }

    const { hash } = msg;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Invalid hash format (expected 64-char hex)' }));
    }
    if (session.committed) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Already committed' }));
    }

    session.committed = true;
    session.hash = hash;

    // Broadcast commit_status
    this.broadcastCommitStatus();

    // Auto-advance if all committed
    if (this.allCommitted()) {
      this.clearTimers();
      this.startRevealPhase();
    }
  }

  handleReveal(sessionKey, msg) {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.username) return;
    if (this.phase !== 'reveal') {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Not in reveal phase' }));
    }

    const { score, salt } = msg;
    if (typeof score !== 'number' || score < 0 || score > 1) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'score must be a number in [0,1]' }));
    }
    if (typeof salt !== 'string' || !/^[0-9a-f]+$/.test(salt)) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'salt must be a hex string' }));
    }
    if (!session.committed) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Did not commit' }));
    }
    if (session.revealed) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Already revealed' }));
    }

    // Verify hash
    if (!verifyCommit(score, salt, session.hash)) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Hash mismatch — reveal does not match commitment' }));
    }

    session.revealed = true;
    session.score = Math.round(score * 100) / 100;
    session.salt = salt;

    // Broadcast reveal_status
    this.broadcastRevealStatus();

    // Auto-advance if all committed players revealed
    if (this.allRevealed()) {
      this.clearTimers();
      this.finaliseRound();
    }
  }

  handleChat(sessionKey, msg) {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.username) return;
    if (this.phase !== 'commit' && this.phase !== 'lobby') {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Chat only allowed in lobby or commit phase' }));
    }

    const text = String(msg.text || '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    const messageId = crypto.randomUUID();
    this.chatMessages.push({ id: messageId, username: session.username, text, timestamp: Date.now() });

    this.broadcast({
      type: 'chat',
      from: session.username,
      text,
      messageId,
    });
  }

  handleReportLeak(sessionKey, msg) {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.username) return;

    const { messageId, suspectUsername } = msg;
    if (!messageId || !suspectUsername) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'messageId and suspectUsername required' }));
    }
    if (suspectUsername === session.username) {
      return session.ws.send(JSON.stringify({ type: 'error', message: 'Cannot report yourself' }));
    }

    // Deduplicate
    const alreadyReported = this.leakReports.some(
      r => r.messageId === messageId && r.reporterUsername === session.username
    );
    if (!alreadyReported) {
      this.leakReports.push({
        messageId,
        reporterUsername: session.username,
        suspectUsername,
      });
    }

    session.ws.send(JSON.stringify({ type: 'report_ack', messageId }));
  }

  // ---------------------------------------------------------------------------
  // Phase management
  // ---------------------------------------------------------------------------

  startCommitPhase() {
    this.phase = 'commit';
    this.clearTimers();

    const question = this.questions[this.currentRound];
    const isEstimation = question.category === 'estimation';
    const commitDuration = isEstimation ? COMMIT_DURATION_ESTIMATION : COMMIT_DURATION_NORMAL;

    // Reset per-round player state
    for (const s of this.sessions.values()) {
      if (s.username) {
        s.committed = false;
        s.revealed = false;
        s.score = null;
        s.hash = null;
        s.salt = null;
      }
    }
    this.leakReports = [];

    this.broadcast({
      type: 'round_start',
      round: this.currentRound + 1,
      question,
      commitDuration,
      phase: 'commit',
    });

    this.roundTimer = setTimeout(() => this.startRevealPhase(), commitDuration * 1000);
  }

  startRevealPhase() {
    this.clearTimers();
    this.phase = 'reveal';

    this.broadcast({
      type: 'phase_change',
      phase: 'reveal',
      revealDuration: REVEAL_DURATION,
    });

    this.roundTimer = setTimeout(() => this.finaliseRound(), REVEAL_DURATION * 1000);
  }

  async finaliseRound() {
    this.clearTimers();
    this.phase = 'results';

    const question = this.questions[this.currentRound];
    const activePlayers = [...this.sessions.values()].filter(s => s.username);
    const playerDataForLogic = activePlayers.map(s => ({
      username: s.username,
      score: s.score,
      balance: s.balance,
      stake: Math.min(ROUND_STAKE, s.balance > 0 ? s.balance : 0),
      hash: s.hash,
      committed: s.committed,
      revealed: s.revealed,
    }));

    const result = computeRoundResult(
      playerDataForLogic,
      this.leakReports,
      this.chatMessages,
      this.currentRound,
    );

    // Apply balance changes
    if (!result.cancelled) {
      const changes = applyBalanceChanges(
        activePlayers.map(s => ({ username: s.username, balance: s.balance })),
        result,
      );
      for (const { username, newBalance } of changes) {
        const s = this.findSessionByUsername(username);
        if (s) s.balance = newBalance;
      }
      for (const pr of result.players) {
        const s = this.findSessionByUsername(pr.username);
        if (s) pr.newBalance = s.balance;
      }
    } else {
      for (const pr of result.players) {
        const s = this.findSessionByUsername(pr.username);
        if (s) pr.newBalance = s.balance;
      }
    }

    result.roundNum = this.currentRound + 1;

    // Log to DB
    const playerCount = activePlayers.length;
    for (const pr of result.players) {
      try {
        await this.env.DB.prepare(`
          INSERT INTO players (username, global_score, coherent_rounds)
          VALUES (?, ?, ?)
          ON CONFLICT(username) DO UPDATE SET
            global_score = global_score + excluded.global_score,
            coherent_rounds = coherent_rounds + excluded.coherent_rounds
        `).bind(pr.username, pr.reward - pr.slash, pr.coherent ? 1 : 0).run();

        await this.env.DB.prepare(`
          INSERT INTO vote_logs (session_id, round_number, question_id, username, revealed_score, mu, sigma, is_coherent, slash_amount, reward_amount, is_leaker, player_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          this.sessionId,
          this.currentRound + 1,
          question.id,
          pr.username,
          pr.score,
          result.mu,
          result.sigma,
          pr.coherent ? 1 : 0,
          pr.slash,
          pr.reward,
          pr.isLeaker ? 1 : 0,
          playerCount,
        ).run();
      } catch (_) {
        // DB errors should not break the game
      }
    }

    this.broadcast({ type: 'round_result', result });

    // Advance after results display
    this.roundTimer = setTimeout(() => {
      this.currentRound++;
      if (this.currentRound >= this.totalRounds) {
        this.endGame();
      } else {
        this.startCommitPhase();
      }
    }, RESULTS_DURATION * 1000);
  }

  endGame() {
    this.clearTimers();
    this.phase = 'lobby';

    const activePlayers = [...this.sessions.values()].filter(s => s.username);
    const summary = {
      players: activePlayers.map(s => ({
        username: s.username,
        finalBalance: s.balance,
        profit: s.balance - STARTING_BALANCE,
      })).sort((a, b) => b.finalBalance - a.finalBalance),
    };

    this.broadcast({ type: 'game_over', summary });

    // Reset room for potential replay
    this.currentRound = 0;
    this.questions = [];
    this.chatMessages = [];
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  allCommitted() {
    const players = [...this.sessions.values()].filter(s => s.username && s.isConnected);
    return players.length > 0 && players.every(s => s.committed);
  }

  allRevealed() {
    const committed = [...this.sessions.values()].filter(s => s.username && s.committed);
    return committed.length > 0 && committed.every(s => s.revealed);
  }

  clearTimers() {
    if (this.roundTimer) {
      clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
  }

  findSessionByUsername(username) {
    for (const s of this.sessions.values()) {
      if (s.username === username) return s;
    }
    return null;
  }

  getRoomInfo() {
    return {
      code: this.roomCode,
      host: this.host,
      phase: this.phase,
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
    };
  }

  getPublicPlayers() {
    return [...this.sessions.values()]
      .filter(s => s.username)
      .map(s => ({
        username: s.username,
        balance: s.balance,
        isConnected: s.isConnected,
        isHost: s.username === this.host,
        hasCommitted: !!s.committed,
        hasRevealed: !!s.revealed,
      }));
  }

  broadcastRoomState(excludeUsername = null) {
    const msg = {
      type: 'room_state',
      room: this.getRoomInfo(),
      players: this.getPublicPlayers(),
    };
    const data = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      if (s.username && s.username !== excludeUsername && s.isConnected) {
        try { s.ws.send(data); } catch (_) {}
      }
    }
  }

  broadcastCommitStatus() {
    this.broadcast({
      type: 'commit_status',
      committed: [...this.sessions.values()]
        .filter(s => s.username)
        .map(s => ({ username: s.username, hasCommitted: s.committed })),
    });
  }

  broadcastRevealStatus() {
    this.broadcast({
      type: 'reveal_status',
      revealed: [...this.sessions.values()]
        .filter(s => s.username)
        .map(s => ({ username: s.username, hasRevealed: s.revealed })),
    });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const session of this.sessions.values()) {
      if (session.isConnected) {
        try { session.ws.send(data); } catch (_) {}
      }
    }
  }
}

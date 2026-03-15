import { verifyCommit, computeRoundResult, applyBalanceChanges } from './gameLogic.js';
import QUESTIONS from './questions.js';

const STARTING_BALANCE = 1000;
const ROUND_STAKE = 100;
const COMMIT_DURATION_NORMAL = 30;
const COMMIT_DURATION_ESTIMATION = 60;
const REVEAL_DURATION = 15;
const RESULTS_DURATION = 12;
const MAX_CHAT_LENGTH = 300;

// ── Alarm tags ──
const ALARM_COMMIT = 'commit';
const ALARM_REVEAL = 'reveal';
const ALARM_RESULTS = 'results';

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
      const { results } = await env.DB.prepare(
        'SELECT * FROM players ORDER BY global_score DESC, coherent_rounds DESC LIMIT 50'
      ).all();
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
      const headers = ['id','session_id','round_number','question_id','username','revealed_score','mu','sigma','is_coherent','slash_amount','reward_amount','is_leaker','player_count','timestamp'];
      const csv = [headers.join(','), ...results.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
      return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="votes.csv"' } });
    }

    return new Response('Not found', { status: 404 });
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
    this.phase = 'lobby';
    this.host = null;
    this.currentRound = 0;
    this.totalRounds = 10;
    this.questions = [];
    this.chatMessages = [];
    this.leakReports = [];
    this.sessionId = crypto.randomUUID();
    this.roomCode = '';
    this.pendingAlarm = null;
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch(_) {}
  }

  broadcast(obj, excludeUsername = null) {
    for (const ws of this.ctx.getWebSockets()) {
      const tag = this.ctx.getTags(ws);
      const username = tag.length > 0 ? tag[0] : null;
      if (username !== excludeUsername) this.send(ws, obj);
    }
  }

  getPublicPlayers() {
    return Array.from(this.players.values()).map(p => ({
      username: p.username, balance: p.balance,
      isConnected: p.isConnected, isHost: p.username === this.host,
      hasCommitted: !!p.committed, hasRevealed: !!p.revealed,
    }));
  }

  selectQuestions(n) {
    const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    this.roomCode = (url.searchParams.get('room') || '').toUpperCase();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return this.send(ws, { type: 'error', message: 'Invalid JSON' }); }
    switch (msg.type) {
      case 'join': return this.handleJoin(ws, msg);
      case 'start_game': return this.handleStartGame(ws);
      case 'commit': return this.handleCommit(ws, msg);
      case 'reveal': return this.handleReveal(ws, msg);
      case 'chat': return this.handleChat(ws, msg);
      case 'report_leak': return this.handleReportLeak(ws, msg);
      default: this.send(ws, { type: 'error', message: 'Unknown type: ' + msg.type });
    }
  }

  async webSocketClose(ws) {
    const tags = this.ctx.getTags(ws);
    const username = tags.length > 0 ? tags[0] : null;
    if (!username) return;
    const player = this.players.get(username);
    if (player) {
      player.isConnected = false;
      this.broadcast({
        type: 'room_state',
        room: { code: this.roomCode, host: this.host, phase: this.phase, currentRound: this.currentRound, totalRounds: this.totalRounds },
        players: this.getPublicPlayers(),
      });
    }
  }

  getWsUsername(ws) {
    const tags = this.ctx.getTags(ws);
    return tags.length > 0 ? tags[0] : null;
  }

  findWsForUsername(username) {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.getWsUsername(ws) === username) return ws;
    }
    return null;
  }

  async handleJoin(ws, msg) {
    const { username, roomCode, roundCount } = msg;
    if (!username || !roomCode) return this.send(ws, { type: 'error', message: 'username and roomCode required' });
    if (!/^[A-Za-z0-9_\-]{1,20}$/.test(username)) return this.send(ws, { type: 'error', message: 'Invalid username' });
    const code = roomCode.toUpperCase();
    this.roomCode = code;

    await this.env.DB.prepare('INSERT INTO players (username) VALUES (?) ON CONFLICT(username) DO NOTHING').bind(username).run();

    if (this.players.size === 0) {
      this.host = username;
      this.totalRounds = [5, 7, 10].includes(roundCount) ? roundCount : 10;
    }

    let player = this.players.get(username);
    if (player) {
      player.isConnected = true;
    } else {
      if (this.phase !== 'lobby') return this.send(ws, { type: 'error', message: 'Game already in progress' });
      player = { username, balance: STARTING_BALANCE, committed: false, revealed: false, score: null, hash: null, salt: null, stake: 0, isConnected: true, coherentRoundsThisGame: 0 };
      this.players.set(username, player);
    }

    // Re-tag this websocket with the username
    // Close old ws for this user if any
    for (const existingWs of this.ctx.getWebSockets()) {
      if (existingWs !== ws && this.getWsUsername(existingWs) === username) {
        try { existingWs.close(1000, 'reconnected'); } catch(_) {}
      }
    }
    // We need to close and re-accept to set tags. Since we can't re-tag, we store username via serializeAttachment.
    ws.serializeAttachment({ username });

    this.send(ws, {
      type: 'room_state',
      room: { code, host: this.host, phase: this.phase, currentRound: this.currentRound, totalRounds: this.totalRounds },
      players: this.getPublicPlayers(),
      myBalance: player.balance,
    });
    this.broadcast({
      type: 'room_state',
      room: { code, host: this.host, phase: this.phase, currentRound: this.currentRound, totalRounds: this.totalRounds },
      players: this.getPublicPlayers(),
    }, username);
  }

  handleStartGame(ws) {
    const username = this.getWsUsername(ws);
    if (username !== this.host) return this.send(ws, { type: 'error', message: 'Only host can start' });
    if (this.phase !== 'lobby') return this.send(ws, { type: 'error', message: 'Game already started' });
    if (this.players.size < 1) return this.send(ws, { type: 'error', message: 'Need at least 1 player' });
    this.questions = this.selectQuestions(this.totalRounds);
    this.currentRound = 0;
    this.sessionId = crypto.randomUUID();
    for (const p of this.players.values()) { p.balance = STARTING_BALANCE; p.coherentRoundsThisGame = 0; }
    this.broadcast({ type: 'game_started', roundCount: this.totalRounds, firstRound: { round: 1, question: this.questions[0] } });
    this.startCommitPhase();
  }

  startCommitPhase() {
    this.phase = 'commit';
    const question = this.questions[this.currentRound];
    const isEstimation = question.category === 'estimation';
    const commitDuration = isEstimation ? COMMIT_DURATION_ESTIMATION : COMMIT_DURATION_NORMAL;
    for (const p of this.players.values()) { p.committed = false; p.revealed = false; p.score = null; p.hash = null; p.salt = null; }
    this.leakReports = [];
    this.broadcast({ type: 'round_start', round: this.currentRound + 1, question, commitDuration, phase: 'commit' });
    this.pendingAlarm = ALARM_REVEAL;
    this.ctx.storage.setAlarm(Date.now() + commitDuration * 1000);
  }

  startRevealPhase() {
    this.phase = 'reveal';
    this.broadcast({ type: 'phase_change', phase: 'reveal', revealDuration: REVEAL_DURATION });
    this.pendingAlarm = ALARM_RESULTS;
    this.ctx.storage.setAlarm(Date.now() + REVEAL_DURATION * 1000);
  }

  async finaliseRound() {
    this.phase = 'results';
    const question = this.questions[this.currentRound];
    const playerData = Array.from(this.players.values()).map(p => ({ username: p.username, score: p.score, balance: p.balance, stake: Math.min(ROUND_STAKE, p.balance > 0 ? p.balance : 0), hash: p.hash, committed: p.committed, revealed: p.revealed }));
    const result = computeRoundResult(playerData, this.leakReports, this.chatMessages, this.currentRound);
    if (!result.cancelled) {
      const changes = applyBalanceChanges(Array.from(this.players.values()), result);
      for (const { username, newBalance } of changes) { const p = this.players.get(username); if (p) p.balance = newBalance; }
      for (const pr of result.players) { const p = this.players.get(pr.username); if (p) pr.newBalance = p.balance; }
    } else {
      for (const pr of result.players) { const p = this.players.get(pr.username); if (p) pr.newBalance = p.balance; }
    }
    result.roundNum = this.currentRound + 1;
    const playerCount = this.players.size;
    for (const pr of result.players) {
      await this.env.DB.prepare('INSERT INTO vote_logs (session_id, round_number, question_id, username, revealed_score, mu, sigma, is_coherent, slash_amount, reward_amount, is_leaker, player_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(this.sessionId, this.currentRound + 1, question.id, pr.username, pr.score ?? null, result.mu ?? null, result.sigma ?? null, pr.coherent ? 1 : 0, pr.slash, pr.reward, pr.isLeaker ? 1 : 0, playerCount).run();
    }
    this.broadcast({ type: 'round_result', result });
    this.pendingAlarm = ALARM_RESULTS;
    this.ctx.storage.setAlarm(Date.now() + RESULTS_DURATION * 1000);
  }

  async endGame() {
    this.phase = 'lobby';
    const summary = { players: Array.from(this.players.values()).map(p => ({ username: p.username, finalBalance: p.balance, profit: p.balance - STARTING_BALANCE })).sort((a, b) => b.finalBalance - a.finalBalance) };
    for (const p of this.players.values()) {
      const stats = { roundsPlayed: this.totalRounds, coherentRounds: p.coherentRoundsThisGame || 0, scoreChange: p.balance - STARTING_BALANCE };
      const existing = await this.env.DB.prepare('SELECT * FROM players WHERE username = ?').bind(p.username).first();
      if (existing) {
        const hadIncoherence = stats.roundsPlayed > 0 && stats.coherentRounds === 0;
        const newStreak = hadIncoherence ? 0 : (existing.current_streak + stats.coherentRounds);
        const longestStreak = Math.max(existing.longest_streak, newStreak);
        await this.env.DB.prepare('UPDATE players SET global_score = global_score + ?, games_played = games_played + 1, rounds_played = rounds_played + ?, coherent_rounds = coherent_rounds + ?, current_streak = ?, longest_streak = ? WHERE username = ?').bind(Math.round(stats.scoreChange), stats.roundsPlayed, stats.coherentRounds, newStreak, longestStreak, p.username).run();
      }
      p.coherentRoundsThisGame = 0;
    }
    this.broadcast({ type: 'game_over', summary });
    this.currentRound = 0;
    this.questions = [];
  }

  async alarm() {
    if (this.pendingAlarm === ALARM_REVEAL) {
      this.startRevealPhase();
    } else if (this.pendingAlarm === ALARM_RESULTS && this.phase === 'reveal') {
      await this.finaliseRound();
    } else if (this.pendingAlarm === ALARM_RESULTS && this.phase === 'results') {
      this.currentRound++;
      if (this.currentRound >= this.totalRounds) {
        await this.endGame();
      } else {
        this.startCommitPhase();
      }
    }
  }

  handleCommit(ws, msg) {
    const username = this.getWsUsername(ws);
    if (this.phase !== 'commit') return this.send(ws, { type: 'error', message: 'Not in commit phase' });
    const { hash } = msg;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return this.send(ws, { type: 'error', message: 'Invalid hash' });
    const player = this.players.get(username);
    if (!player) return this.send(ws, { type: 'error', message: 'Player not found' });
    if (player.committed) return this.send(ws, { type: 'error', message: 'Already committed' });
    player.committed = true;
    player.hash = hash;
    this.broadcast({ type: 'commit_status', committed: Array.from(this.players.values()).map(p => ({ username: p.username, hasCommitted: p.committed })) });
    const allCommitted = Array.from(this.players.values()).every(p => p.committed);
    if (allCommitted) { this.startRevealPhase(); }
  }

  handleReveal(ws, msg) {
    const username = this.getWsUsername(ws);
    if (this.phase !== 'reveal') return this.send(ws, { type: 'error', message: 'Not in reveal phase' });
    const { score, salt } = msg;
    if (typeof score !== 'number' || score < 0 || score > 1) return this.send(ws, { type: 'error', message: 'Invalid score' });
    if (typeof salt !== 'string' || !/^[0-9a-f]+$/.test(salt)) return this.send(ws, { type: 'error', message: 'Invalid salt' });
    const player = this.players.get(username);
    if (!player) return;
    if (!player.committed) return this.send(ws, { type: 'error', message: 'Did not commit' });
    if (player.revealed) return this.send(ws, { type: 'error', message: 'Already revealed' });
    if (!verifyCommit(score, salt, player.hash)) return this.send(ws, { type: 'error', message: 'Hash mismatch' });
    player.revealed = true;
    player.score = Math.round(score * 100) / 100;
    player.salt = salt;
    this.broadcast({ type: 'reveal_status', revealed: Array.from(this.players.values()).map(p => ({ username: p.username, hasRevealed: p.revealed })) });
    const committed = Array.from(this.players.values()).filter(p => p.committed);
    if (committed.length > 0 && committed.every(p => p.revealed)) { this.finaliseRound(); }
  }

  handleChat(ws, msg) {
    const username = this.getWsUsername(ws);
    if (this.phase !== 'commit' && this.phase !== 'lobby') return this.send(ws, { type: 'error', message: 'Chat only in lobby/commit' });
    const text = String(msg.text || '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;
    const messageId = crypto.randomUUID();
    this.chatMessages.push({ id: messageId, username, text, timestamp: Date.now() });
    this.broadcast({ type: 'chat', from: username, text, messageId });
  }

  handleReportLeak(ws, msg) {
    const username = this.getWsUsername(ws);
    const { messageId, suspectUsername } = msg;
    if (!messageId || !suspectUsername) return this.send(ws, { type: 'error', message: 'messageId and suspectUsername required' });
    if (suspectUsername === username) return this.send(ws, { type: 'error', message: 'Cannot report yourself' });
    const already = this.leakReports.some(r => r.messageId === messageId && r.reporterUsername === username);
    if (!already) this.leakReports.push({ messageId, reporterUsername: username, suspectUsername });
    this.send(ws, { type: 'report_ack', messageId });
  }
}

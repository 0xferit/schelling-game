import { v4 as uuidv4 } from 'uuid';
import type WebSocket from 'ws';
import queue from './matchmaking';
import { verifyCommit, validateSalt, validateHash, validateOptionIndex } from './domain/commitReveal';
import { settleRound, ROUND_ANTE } from './domain/settlement';
import { selectQuestionsForMatch } from './domain/questions';
import db from './db';
import type { Question } from './types/domain';
import type { ClientMessage } from './types/messages';

const COMMIT_DURATION = 30;    // seconds
const REVEAL_DURATION = 15;    // seconds
const RESULTS_DURATION = 12;   // seconds
const RECONNECT_GRACE = 15;    // seconds
const TOTAL_ROUNDS = 10;
const MAX_CHAT_LENGTH = 300;

// ---------------------------------------------------------------------------
// Type definitions for in-memory state
// ---------------------------------------------------------------------------

interface SessionEntry {
  ws: WebSocket;
  autoRequeue: boolean;
  previousOpponents: Set<string>;
}

interface PlayerState {
  accountId: string;
  displayName: string;
  ws: WebSocket | null;
  startingBalance: number;
  committed: boolean;
  revealed: boolean;
  hash: string | null;
  optionIndex: number | null;
  salt: string | null;
  forfeited: boolean;
  disconnectedAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface MatchState {
  matchId: string;
  players: Map<string, PlayerState>;
  questions: Question[];
  currentRound: number;
  totalRounds: number;
  phase: 'commit' | 'reveal' | 'results';
  commitTimer: ReturnType<typeof setTimeout> | null;
  revealTimer: ReturnType<typeof setTimeout> | null;
  resultsTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const sessionState = new Map<string, SessionEntry>();
const activeMatches = new Map<string, MatchState>();
const playerMatchIndex = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket | null, obj: object): void {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastMatch(match: MatchState, obj: object, excludeId: string | null = null): void {
  for (const [id, p] of match.players) {
    if (id !== excludeId && p.ws) send(p.ws, obj);
  }
}

function broadcastQueueState(): void {
  for (const ws of queue.getAllQueuedWs()) {
    const accountId = (ws as WebSocket)._accountId;
    if (!accountId) continue;
    const session = sessionState.get(accountId);
    const state = queue.getQueueState(accountId) as Record<string, unknown>;
    state.autoRequeue = session?.autoRequeue ?? false;
    send(ws as WebSocket, state);
  }
}

function getMatchForAccount(accountId: string): MatchState | null {
  const matchId = playerMatchIndex.get(accountId);
  if (!matchId) return null;
  return activeMatches.get(matchId) || null;
}

function clearTimers(match: MatchState): void {
  clearTimeout(match.commitTimer!);
  clearTimeout(match.revealTimer!);
  clearTimeout(match.resultsTimer!);
  match.commitTimer = null;
  match.revealTimer = null;
  match.resultsTimer = null;
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

function handleMessage(ws: WebSocket, rawData: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return send(ws, { type: 'error', message: 'Invalid JSON' });
  }

  switch (msg.type) {
    case 'join_queue':  return handleJoinQueue(ws);
    case 'leave_queue': return handleLeaveQueue(ws);
    case 'commit':      return handleCommit(ws, msg);
    case 'reveal':      return handleReveal(ws, msg);
    case 'chat':        return handleChat(ws, msg);
    default:
      send(ws, { type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
  }
}

// ---------------------------------------------------------------------------
// Queue handlers
// ---------------------------------------------------------------------------

function handleJoinQueue(ws: WebSocket): void {
  const accountId = ws._accountId;
  if (!accountId) {
    return send(ws, { type: 'error', message: 'Not authenticated' });
  }

  const account = db.getAccount(accountId);
  if (!account?.display_name) {
    return send(ws, { type: 'error', message: 'Display name required before queueing' });
  }

  let session = sessionState.get(accountId);
  if (!session) {
    session = { ws, autoRequeue: true, previousOpponents: new Set() };
    sessionState.set(accountId, session);
  } else {
    session.ws = ws;
    session.autoRequeue = true;
  }

  const result = queue.enqueue({
    accountId,
    displayName: account.display_name,
    ws,
    previousOpponents: session.previousOpponents,
  });

  if (!result.success) {
    return send(ws, { type: 'error', message: result.error! });
  }

  broadcastQueueState();
}

function handleLeaveQueue(ws: WebSocket): void {
  const accountId = ws._accountId;
  if (!accountId) return;

  queue.dequeue(accountId);

  const session = sessionState.get(accountId);
  if (session) {
    session.autoRequeue = false;
  }

  broadcastQueueState();
}

// ---------------------------------------------------------------------------
// Commit handler
// ---------------------------------------------------------------------------

function handleCommit(ws: WebSocket, msg: { type: 'commit'; hash: string }): void {
  const accountId = ws._accountId;
  if (!accountId) return send(ws, { type: 'error', message: 'Not authenticated' });

  const match = getMatchForAccount(accountId);
  if (!match) return send(ws, { type: 'error', message: 'Not in a match' });
  if (match.phase !== 'commit') return send(ws, { type: 'error', message: 'Not in commit phase' });

  const player = match.players.get(accountId);
  if (!player) return send(ws, { type: 'error', message: 'Player not found in match' });
  if (player.forfeited) return send(ws, { type: 'error', message: 'Forfeited players cannot act' });
  if (player.committed) return send(ws, { type: 'error', message: 'Already committed' });

  const { hash } = msg;
  if (!validateHash(hash)) {
    return send(ws, { type: 'error', message: 'Invalid hash format (expected 64-char lowercase hex)' });
  }

  player.committed = true;
  player.hash = hash;

  broadcastMatch(match, {
    type: 'commit_status',
    committed: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      hasCommitted: p.committed,
    })),
  });

  const eligible = Array.from(match.players.values()).filter(
    p => !p.forfeited && p.disconnectedAt === null
  );
  if (eligible.length > 0 && eligible.every(p => p.committed)) {
    clearTimeout(match.commitTimer!);
    match.commitTimer = null;
    startRevealPhase(match);
  }
}

// ---------------------------------------------------------------------------
// Reveal handler
// ---------------------------------------------------------------------------

function handleReveal(ws: WebSocket, msg: { type: 'reveal'; optionIndex: number; salt: string }): void {
  const accountId = ws._accountId;
  if (!accountId) return send(ws, { type: 'error', message: 'Not authenticated' });

  const match = getMatchForAccount(accountId);
  if (!match) return send(ws, { type: 'error', message: 'Not in a match' });
  if (match.phase !== 'reveal') return send(ws, { type: 'error', message: 'Not in reveal phase' });

  const player = match.players.get(accountId);
  if (!player) return send(ws, { type: 'error', message: 'Player not found in match' });
  if (player.forfeited) return send(ws, { type: 'error', message: 'Forfeited players cannot act' });
  if (!player.committed) return send(ws, { type: 'error', message: 'Did not commit this round' });
  if (player.revealed) return send(ws, { type: 'error', message: 'Already revealed' });

  const { optionIndex, salt } = msg;

  const question = match.questions[match.currentRound];
  if (!validateOptionIndex(optionIndex, question.options.length)) {
    return send(ws, { type: 'error', message: 'Invalid optionIndex: must be an integer within question options range' });
  }

  if (!validateSalt(salt)) {
    return send(ws, { type: 'error', message: 'Invalid salt: must be hex string of at least 32 characters' });
  }

  if (!verifyCommit(optionIndex, salt, player.hash!)) {
    return send(ws, { type: 'error', message: 'Hash mismatch: reveal does not match commitment' });
  }

  player.revealed = true;
  player.optionIndex = optionIndex;
  player.salt = salt;

  broadcastMatch(match, {
    type: 'reveal_status',
    revealed: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      hasRevealed: p.revealed,
    })),
  });

  const mustReveal = Array.from(match.players.values()).filter(
    p => p.committed && !p.forfeited
  );
  if (mustReveal.length > 0 && mustReveal.every(p => p.revealed)) {
    clearTimeout(match.revealTimer!);
    match.revealTimer = null;
    finalizeRound(match);
  }
}

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------

function handleChat(ws: WebSocket, msg: { type: 'chat'; text: string }): void {
  const accountId = ws._accountId;
  if (!accountId) return send(ws, { type: 'error', message: 'Not authenticated' });

  const match = getMatchForAccount(accountId);
  if (!match) return send(ws, { type: 'error', message: 'Not in a match' });
  if (match.phase !== 'results') {
    return send(ws, { type: 'error', message: 'Chat only allowed during results phase' });
  }

  const player = match.players.get(accountId);
  if (!player) return;
  if (player.forfeited) return send(ws, { type: 'error', message: 'Forfeited players cannot chat' });

  const text = String(msg.text || '').trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return;

  const messageId = `msg_${uuidv4()}`;
  broadcastMatch(match, {
    type: 'chat',
    from: player.displayName,
    text,
    messageId,
  });
}

// ---------------------------------------------------------------------------
// Disconnect and reconnect
// ---------------------------------------------------------------------------

function handleDisconnect(ws: WebSocket): void {
  const accountId = ws._accountId;
  if (!accountId) return;

  if (queue.isQueued(accountId)) {
    queue.dequeue(accountId);
    broadcastQueueState();
  }

  const match = getMatchForAccount(accountId);
  if (match) {
    const player = match.players.get(accountId);
    if (player && !player.forfeited) {
      player.disconnectedAt = Date.now();
      player.ws = null;

      broadcastMatch(match, {
        type: 'player_disconnected',
        displayName: player.displayName,
        graceSeconds: RECONNECT_GRACE,
      });

      player.graceTimer = setTimeout(() => {
        if (player.disconnectedAt !== null) {
          player.forfeited = true;

          broadcastMatch(match, {
            type: 'player_forfeited',
            displayName: player.displayName,
            autoLosesRemainingRounds: true,
          });

          checkAutoAdvance(match);
        }
      }, RECONNECT_GRACE * 1000);
    }
  }
}

function handleReconnect(ws: WebSocket, accountId: string): void {
  const session = sessionState.get(accountId);
  if (session) {
    session.ws = ws;
  }

  queue.updatePlayerWs(accountId, ws);

  const match = getMatchForAccount(accountId);
  if (match) {
    const player = match.players.get(accountId);
    if (player) {
      player.ws = ws;
      player.disconnectedAt = null;

      if (player.graceTimer) {
        clearTimeout(player.graceTimer);
        player.graceTimer = null;
      }

      broadcastMatch(match, {
        type: 'player_reconnected',
        displayName: player.displayName,
      }, accountId);

      sendMatchStateCatchup(ws, match, accountId);
    }
  }
}

function sendMatchStateCatchup(ws: WebSocket, match: MatchState, accountId: string): void {
  const question = match.questions[match.currentRound];

  send(ws, {
    type: 'game_started',
    matchId: match.matchId,
    roundCount: match.totalRounds,
    players: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    })),
  });

  send(ws, {
    type: 'round_start',
    round: match.currentRound + 1,
    question,
    commitDuration: COMMIT_DURATION,
    roundAnte: ROUND_ANTE,
    phase: 'commit',
  });

  if (match.phase === 'reveal') {
    send(ws, {
      type: 'phase_change',
      phase: 'reveal',
      revealDuration: REVEAL_DURATION,
    });
  }

  send(ws, {
    type: 'commit_status',
    committed: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      hasCommitted: p.committed,
    })),
  });

  if (match.phase === 'reveal' || match.phase === 'results') {
    send(ws, {
      type: 'reveal_status',
      revealed: Array.from(match.players.values()).map(p => ({
        displayName: p.displayName,
        hasRevealed: p.revealed,
      })),
    });
  }
}

function checkAutoAdvance(match: MatchState): void {
  if (match.phase === 'commit') {
    const eligible = Array.from(match.players.values()).filter(
      p => !p.forfeited && p.disconnectedAt === null
    );
    if (eligible.length > 0 && eligible.every(p => p.committed)) {
      clearTimeout(match.commitTimer!);
      match.commitTimer = null;
      startRevealPhase(match);
    }
  } else if (match.phase === 'reveal') {
    const mustReveal = Array.from(match.players.values()).filter(
      p => p.committed && !p.forfeited
    );
    if (mustReveal.length > 0 && mustReveal.every(p => p.revealed)) {
      clearTimeout(match.revealTimer!);
      match.revealTimer = null;
      finalizeRound(match);
    }
  }
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

interface QueuePlayer {
  accountId: string;
  displayName: string;
  ws: WebSocket;
  previousOpponents: Set<string>;
}

function onMatchReady(players: QueuePlayer[], matchId: string): void {
  db.createMatch({ matchId, playerCount: players.length });

  const questions = selectQuestionsForMatch(TOTAL_ROUNDS);

  const playerMap = new Map<string, PlayerState>();
  for (const p of players) {
    const account = db.getAccount(p.accountId);
    const startingBalance = account?.token_balance ?? 0;

    db.addMatchPlayer({
      matchId,
      accountId: p.accountId,
      displayNameSnapshot: p.displayName,
      startingBalance,
    });

    playerMap.set(p.accountId, {
      accountId: p.accountId,
      displayName: p.displayName,
      ws: p.ws,
      startingBalance,
      committed: false,
      revealed: false,
      hash: null,
      optionIndex: null,
      salt: null,
      forfeited: false,
      disconnectedAt: null,
      graceTimer: null,
    });

    playerMatchIndex.set(p.accountId, matchId);

    const session = sessionState.get(p.accountId);
    if (session) {
      session.previousOpponents = new Set(
        players.filter(x => x.accountId !== p.accountId).map(x => x.accountId)
      );
    }
  }

  const match: MatchState = {
    matchId,
    players: playerMap,
    questions,
    currentRound: 0,
    totalRounds: TOTAL_ROUNDS,
    phase: 'commit',
    commitTimer: null,
    revealTimer: null,
    resultsTimer: null,
  };

  activeMatches.set(matchId, match);
  queue.registerActiveMatch(matchId, match);

  broadcastMatch(match, {
    type: 'game_started',
    matchId,
    roundCount: TOTAL_ROUNDS,
    players: Array.from(playerMap.values()).map(p => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    })),
  });

  startCommitPhase(match);
}

function startCommitPhase(match: MatchState): void {
  match.phase = 'commit';

  const question = match.questions[match.currentRound];

  for (const p of match.players.values()) {
    p.committed = false;
    p.revealed = false;
    p.hash = null;
    p.optionIndex = null;
    p.salt = null;
  }

  broadcastMatch(match, {
    type: 'round_start',
    round: match.currentRound + 1,
    question,
    commitDuration: COMMIT_DURATION,
    roundAnte: ROUND_ANTE,
    phase: 'commit',
  });

  match.commitTimer = setTimeout(() => {
    match.commitTimer = null;
    startRevealPhase(match);
  }, COMMIT_DURATION * 1000);
}

function startRevealPhase(match: MatchState): void {
  match.phase = 'reveal';

  broadcastMatch(match, {
    type: 'phase_change',
    phase: 'reveal',
    revealDuration: REVEAL_DURATION,
  });

  match.revealTimer = setTimeout(() => {
    match.revealTimer = null;
    finalizeRound(match);
  }, REVEAL_DURATION * 1000);
}

function finalizeRound(match: MatchState): void {
  clearTimers(match);
  match.phase = 'results';

  const question = match.questions[match.currentRound];

  const settleInput = Array.from(match.players.values()).map(p => ({
    accountId: p.accountId,
    displayName: p.displayName,
    optionIndex: p.optionIndex,
    validReveal: p.committed && p.revealed && !p.forfeited,
    forfeited: p.forfeited,
    attached: true,
  }));

  const result = settleRound(settleInput, question);
  const resultWithNum = { ...result, roundNum: match.currentRound + 1 };

  // Apply balance deltas and annotate with newBalance
  const enrichedPlayers = resultWithNum.players.map(pr => {
    if (pr.netDelta !== 0) {
      db.updateBalance(pr.accountId, pr.netDelta);
    }
    const updatedAccount = db.getAccount(pr.accountId);
    return { ...pr, newBalance: updatedAccount?.token_balance ?? 0 };
  });

  // Log vote records
  for (const pr of enrichedPlayers) {
    db.insertVoteLog({
      matchId: match.matchId,
      roundNumber: match.currentRound + 1,
      questionId: question.id,
      accountId: pr.accountId,
      displayNameSnapshot: pr.displayName,
      revealedOptionIndex: pr.revealedOptionIndex,
      revealedOptionLabel: pr.revealedOptionLabel,
      wonRound: pr.wonRound,
      earnsCoordinationCredit: pr.earnsCoordinationCredit,
      anteAmount: pr.antePaid,
      roundPayout: pr.roundPayout,
      netDelta: pr.netDelta,
      playerCount: result.playerCount,
      validRevealCount: result.validRevealCount,
      topCount: result.topCount,
      winnerCount: result.winnerCount,
      winningOptionIndexesJson: JSON.stringify(result.winningOptionIndexes),
      voided: result.voided,
      voidReason: result.voidReason,
    });
  }

  // Update per-round player stats
  for (const pr of enrichedPlayers) {
    if (!result.voided) {
      db.updatePlayerStats(pr.accountId, {
        roundsPlayed: 1,
        coherentRounds: pr.earnsCoordinationCredit ? 1 : 0,
        isGameEnd: false,
        wonRound: pr.wonRound,
        earnsCoordinationCredit: pr.earnsCoordinationCredit,
      });
    }
  }

  broadcastMatch(match, {
    type: 'round_result',
    result: { ...resultWithNum, players: enrichedPlayers },
  });

  match.resultsTimer = setTimeout(() => {
    match.resultsTimer = null;
    match.currentRound++;
    if (match.currentRound >= match.totalRounds || !hasNonForfeitedPlayers(match)) {
      endMatch(match);
    } else {
      startCommitPhase(match);
    }
  }, RESULTS_DURATION * 1000);
}

function hasNonForfeitedPlayers(match: MatchState): boolean {
  for (const p of match.players.values()) {
    if (!p.forfeited) return true;
  }
  return false;
}

function endMatch(match: MatchState): void {
  clearTimers(match);

  const summary = {
    players: Array.from(match.players.values()).map(p => {
      const account = db.getAccount(p.accountId);
      const endingBalance = account?.token_balance ?? 0;
      const netDelta = endingBalance - p.startingBalance;
      const result = p.forfeited ? 'forfeited' as const : 'completed' as const;

      db.updateMatchPlayer({
        matchId: match.matchId,
        accountId: p.accountId,
        endingBalance,
        netDelta,
        result,
      });

      db.updatePlayerStats(p.accountId, {
        roundsPlayed: 0,
        coherentRounds: 0,
        isGameEnd: true,
        wonRound: false,
        earnsCoordinationCredit: false,
      });

      return {
        displayName: p.displayName,
        startingBalance: p.startingBalance,
        endingBalance,
        netDelta,
        result,
      };
    }).sort((a, b) => b.endingBalance - a.endingBalance),
  };

  db.endMatch(match.matchId);

  broadcastMatch(match, { type: 'game_over', summary });

  queue.unregisterActiveMatch(match.matchId);
  for (const [accountId, p] of match.players) {
    playerMatchIndex.delete(accountId);

    if (p.graceTimer) {
      clearTimeout(p.graceTimer);
      p.graceTimer = null;
    }
  }
  activeMatches.delete(match.matchId);

  // Auto-requeue eligible players
  for (const [accountId, p] of match.players) {
    if (p.forfeited) continue;
    const session = sessionState.get(accountId);
    if (!session || !session.autoRequeue) continue;
    if (!session.ws || session.ws.readyState !== 1) continue;

    const account = db.getAccount(accountId);
    if (!account?.display_name) continue;

    queue.enqueue({
      accountId,
      displayName: account.display_name,
      ws: session.ws,
      previousOpponents: session.previousOpponents,
    });
  }

  broadcastQueueState();
}

// ---------------------------------------------------------------------------
// Account state for /api/me
// ---------------------------------------------------------------------------

function getAccountState(accountId: string): { autoRequeue: boolean; queueStatus: string } {
  const session = sessionState.get(accountId);
  const isQueued = queue.isQueued(accountId);
  const inMatch = playerMatchIndex.has(accountId);

  let queueStatus = 'idle';
  if (inMatch) {
    queueStatus = 'in_match';
  } else if (isQueued) {
    queueStatus = 'queued';
  }

  return {
    autoRequeue: session?.autoRequeue ?? false,
    queueStatus,
  };
}

// ---------------------------------------------------------------------------
// Wire up the matchmaking callback
// ---------------------------------------------------------------------------

queue.onMatchReady = (players, matchId) => onMatchReady(players as unknown as QueuePlayer[], matchId);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  handleMessage,
  handleDisconnect,
  handleReconnect,
  getAccountState,
  sessionState,
  activeMatches,
};

import { v4 as uuidv4 } from 'uuid';
import queue from './matchmaking.js';
import { verifyCommit, validateSalt, validateHash, validateOptionIndex } from './domain/commitReveal.js';
import { settleRound, ROUND_ANTE } from './domain/settlement.js';
import { selectQuestionsForMatch } from './domain/questions.js';
import db from './db.js';

const COMMIT_DURATION = 30;    // seconds
const REVEAL_DURATION = 15;    // seconds
const RESULTS_DURATION = 12;   // seconds
const RECONNECT_GRACE = 15;    // seconds
const TOTAL_ROUNDS = 10;
const MAX_CHAT_LENGTH = 300;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

// Per-session state keyed by accountId.
// Tracks the WebSocket, autoRequeue toggle, and opponent history.
const sessionState = new Map(); // accountId -> { ws, autoRequeue, previousOpponents }

// Active matches keyed by matchId.
const activeMatches = new Map(); // matchId -> MatchState

// Reverse lookup: accountId -> matchId for fast match retrieval.
const playerMatchIndex = new Map(); // accountId -> matchId

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws, obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastMatch(match, obj, excludeId = null) {
  for (const [id, p] of match.players) {
    if (id !== excludeId && p.ws) send(p.ws, obj);
  }
}

function broadcastQueueState() {
  for (const ws of queue.getAllQueuedWs()) {
    const accountId = ws._accountId;
    const session = sessionState.get(accountId);
    const state = queue.getQueueState(accountId);
    state.autoRequeue = session?.autoRequeue ?? false;
    send(ws, state);
  }
}

function getMatchForAccount(accountId) {
  const matchId = playerMatchIndex.get(accountId);
  if (!matchId) return null;
  return activeMatches.get(matchId) || null;
}

function clearTimers(match) {
  clearTimeout(match.commitTimer);
  clearTimeout(match.revealTimer);
  clearTimeout(match.resultsTimer);
  match.commitTimer = null;
  match.revealTimer = null;
  match.resultsTimer = null;
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

function handleMessage(ws, rawData) {
  let msg;
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
      send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

// ---------------------------------------------------------------------------
// Queue handlers
// ---------------------------------------------------------------------------

function handleJoinQueue(ws) {
  const accountId = ws._accountId;
  if (!accountId) {
    return send(ws, { type: 'error', message: 'Not authenticated' });
  }

  const account = db.getAccount(accountId);
  if (!account?.display_name) {
    return send(ws, { type: 'error', message: 'Display name required before queueing' });
  }

  // Ensure session state exists
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
    return send(ws, { type: 'error', message: result.error });
  }

  broadcastQueueState();
}

function handleLeaveQueue(ws) {
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

function handleCommit(ws, msg) {
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

  // Broadcast commit status using displayName per spec
  broadcastMatch(match, {
    type: 'commit_status',
    committed: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      hasCommitted: p.committed,
    })),
  });

  // Auto-advance: check if all non-forfeited, connected players have committed
  const eligible = Array.from(match.players.values()).filter(
    p => !p.forfeited && p.disconnectedAt === null
  );
  if (eligible.length > 0 && eligible.every(p => p.committed)) {
    clearTimeout(match.commitTimer);
    match.commitTimer = null;
    startRevealPhase(match);
  }
}

// ---------------------------------------------------------------------------
// Reveal handler
// ---------------------------------------------------------------------------

function handleReveal(ws, msg) {
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

  // Validate optionIndex
  const question = match.questions[match.currentRound];
  if (!validateOptionIndex(optionIndex, question.options.length)) {
    return send(ws, { type: 'error', message: 'Invalid optionIndex: must be an integer within question options range' });
  }

  // Validate salt
  if (!validateSalt(salt)) {
    return send(ws, { type: 'error', message: 'Invalid salt: must be hex string of at least 32 characters' });
  }

  // Verify commitment hash
  if (!verifyCommit(optionIndex, salt, player.hash)) {
    return send(ws, { type: 'error', message: 'Hash mismatch: reveal does not match commitment' });
  }

  player.revealed = true;
  player.optionIndex = optionIndex;
  player.salt = salt;

  // Broadcast reveal status
  broadcastMatch(match, {
    type: 'reveal_status',
    revealed: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      hasRevealed: p.revealed,
    })),
  });

  // Auto-advance: check if all committed, non-forfeited players have revealed
  const mustReveal = Array.from(match.players.values()).filter(
    p => p.committed && !p.forfeited
  );
  if (mustReveal.length > 0 && mustReveal.every(p => p.revealed)) {
    clearTimeout(match.revealTimer);
    match.revealTimer = null;
    finalizeRound(match);
  }
}

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------

function handleChat(ws, msg) {
  const accountId = ws._accountId;
  if (!accountId) return send(ws, { type: 'error', message: 'Not authenticated' });

  const match = getMatchForAccount(accountId);
  if (!match) return send(ws, { type: 'error', message: 'Not in a match' });
  if (match.phase !== 'commit') {
    return send(ws, { type: 'error', message: 'Chat only allowed during commit phase' });
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

function handleDisconnect(ws) {
  const accountId = ws._accountId;
  if (!accountId) return;

  // If in queue, remove immediately
  if (queue.isQueued(accountId)) {
    queue.dequeue(accountId);
    broadcastQueueState();
  }

  // If in active match, start grace timer
  const match = getMatchForAccount(accountId);
  if (match) {
    const player = match.players.get(accountId);
    if (player && !player.forfeited) {
      player.disconnectedAt = Date.now();
      player.ws = null;

      // Notify other players
      broadcastMatch(match, {
        type: 'player_disconnected',
        displayName: player.displayName,
        graceSeconds: RECONNECT_GRACE,
      });

      // Start grace timer
      player.graceTimer = setTimeout(() => {
        // Still disconnected after grace period: forfeit
        if (player.disconnectedAt !== null) {
          player.forfeited = true;

          broadcastMatch(match, {
            type: 'player_forfeited',
            displayName: player.displayName,
            autoLosesRemainingRounds: true,
          });

          // Check if this forfeit triggers phase advancement
          checkAutoAdvance(match);
        }
      }, RECONNECT_GRACE * 1000);
    }
  }
}

function handleReconnect(ws, accountId) {
  // Update session state ws reference
  const session = sessionState.get(accountId);
  if (session) {
    session.ws = ws;
  }

  // Update queue ws reference if still queued
  queue.updatePlayerWs(accountId, ws);

  // If in active match, reattach
  const match = getMatchForAccount(accountId);
  if (match) {
    const player = match.players.get(accountId);
    if (player) {
      player.ws = ws;
      player.disconnectedAt = null;

      // Clear grace timer
      if (player.graceTimer) {
        clearTimeout(player.graceTimer);
        player.graceTimer = null;
      }

      // Notify other players
      broadcastMatch(match, {
        type: 'player_reconnected',
        displayName: player.displayName,
      }, accountId);

      // Send current match state to the reconnecting player
      sendMatchStateCatchup(ws, match, accountId);
    }
  }
}

function sendMatchStateCatchup(ws, match, accountId) {
  const question = match.questions[match.currentRound];
  const player = match.players.get(accountId);

  // Send game_started so client knows match context
  send(ws, {
    type: 'game_started',
    matchId: match.matchId,
    roundCount: match.totalRounds,
    players: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    })),
  });

  // Send current round info
  send(ws, {
    type: 'round_start',
    round: match.currentRound + 1,
    question,
    commitDuration: COMMIT_DURATION,
    roundAnte: ROUND_ANTE,
    phase: match.phase,
  });

  // Send phase info if in reveal or results
  if (match.phase === 'reveal') {
    send(ws, {
      type: 'phase_change',
      phase: 'reveal',
      revealDuration: REVEAL_DURATION,
    });
  }

  // Send commit status
  send(ws, {
    type: 'commit_status',
    committed: Array.from(match.players.values()).map(p => ({
      displayName: p.displayName,
      hasCommitted: p.committed,
    })),
  });

  // Send reveal status if in reveal phase
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

/**
 * After a forfeit or disconnect, check whether the current phase
 * can auto-advance because all remaining eligible players have acted.
 */
function checkAutoAdvance(match) {
  if (match.phase === 'commit') {
    const eligible = Array.from(match.players.values()).filter(
      p => !p.forfeited && p.disconnectedAt === null
    );
    if (eligible.length > 0 && eligible.every(p => p.committed)) {
      clearTimeout(match.commitTimer);
      match.commitTimer = null;
      startRevealPhase(match);
    }
  } else if (match.phase === 'reveal') {
    const mustReveal = Array.from(match.players.values()).filter(
      p => p.committed && !p.forfeited
    );
    if (mustReveal.length > 0 && mustReveal.every(p => p.revealed)) {
      clearTimeout(match.revealTimer);
      match.revealTimer = null;
      finalizeRound(match);
    }
  }
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

/**
 * Called by the matchmaking queue when a match is ready.
 * players: array of { accountId, displayName, ws, previousOpponents }
 */
function onMatchReady(players, matchId) {
  // Load balances and create DB records
  db.createMatch({ matchId, playerCount: players.length });

  const questions = selectQuestionsForMatch(TOTAL_ROUNDS);

  const playerMap = new Map();
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

    // Register the reverse lookup
    playerMatchIndex.set(p.accountId, matchId);

    // Update previous opponents for anti-repeat matchmaking
    const session = sessionState.get(p.accountId);
    if (session) {
      session.previousOpponents = new Set(
        players.filter(x => x.accountId !== p.accountId).map(x => x.accountId)
      );
    }
  }

  const match = {
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

  // Broadcast game_started
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

function startCommitPhase(match) {
  match.phase = 'commit';

  const question = match.questions[match.currentRound];

  // Reset per-round player state
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

function startRevealPhase(match) {
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

function finalizeRound(match) {
  clearTimers(match);
  match.phase = 'results';

  const question = match.questions[match.currentRound];

  // Build the player input array for settleRound.
  // "attached" means the player is still part of the match for accounting.
  // All players remain attached; forfeited players simply have no valid reveal.
  const settleInput = Array.from(match.players.values()).map(p => ({
    accountId: p.accountId,
    displayName: p.displayName,
    optionIndex: p.optionIndex,
    validReveal: p.committed && p.revealed && !p.forfeited,
    forfeited: p.forfeited,
    attached: true, // all players remain attached for pot calculation
  }));

  const result = settleRound(settleInput, question);
  result.roundNum = match.currentRound + 1;

  // Apply balance deltas to DB and annotate results with newBalance
  for (const pr of result.players) {
    if (pr.netDelta !== 0) {
      db.updateBalance(pr.accountId, pr.netDelta);
    }
    const updatedAccount = db.getAccount(pr.accountId);
    pr.newBalance = updatedAccount?.token_balance ?? 0;
  }

  // Log vote records
  for (const pr of result.players) {
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
  for (const pr of result.players) {
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

  broadcastMatch(match, { type: 'round_result', result });

  // Advance after results display
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

function hasNonForfeitedPlayers(match) {
  for (const p of match.players.values()) {
    if (!p.forfeited) return true;
  }
  return false;
}

function endMatch(match) {
  clearTimers(match);

  // Compute summary
  const summary = {
    players: Array.from(match.players.values()).map(p => {
      const account = db.getAccount(p.accountId);
      const endingBalance = account?.token_balance ?? 0;
      const netDelta = endingBalance - p.startingBalance;
      const result = p.forfeited ? 'forfeited' : 'completed';

      // Update match_players in DB
      db.updateMatchPlayer({
        matchId: match.matchId,
        accountId: p.accountId,
        endingBalance,
        netDelta,
        result,
      });

      // Update games_played stat for game end
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

  // Cleanup: remove match from indexes
  queue.unregisterActiveMatch(match.matchId);
  for (const [accountId, p] of match.players) {
    playerMatchIndex.delete(accountId);

    // Clear any lingering grace timers
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

function getAccountState(accountId) {
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

queue.onMatchReady = (players, matchId) => onMatchReady(players, matchId);

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

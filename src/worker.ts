import {
  validateHash,
  validateOptionIndex,
  validateSalt,
  verifyCommit,
} from './domain/commitReveal';
import {
  COMMIT_DURATION,
  RESULTS_DURATION,
  REVEAL_DURATION,
} from './domain/constants';
import { selectQuestionsForMatch } from './domain/questions';
import { ROUND_ANTE, settleRound } from './domain/settlement';
import type {
  PlayerResultWithBalance,
  PlayerSettlementInput,
  Question,
  RoundResult,
} from './types/domain';
import type { RoundResultMessage } from './types/messages';
import type { Env } from './types/worker-env';
import { handleHttpRequest } from './worker/httpHandler';
import type { PlayerActionFields } from './worker/persistence';
import {
  checkpointMatch,
  checkpointPlayerAction,
  deleteMatchCheckpoint,
  initCheckpointTables,
  restoreMatchesFromStorage,
} from './worker/persistence';

// ---------------------------------------------------------------------------
// Local interfaces for worker-internal state
// ---------------------------------------------------------------------------

interface ConnectionState {
  ws: WebSocket;
  displayName: string;
  autoRequeue: boolean;
  previousOpponents: Set<string>;
}

interface WorkerPlayerState {
  accountId: string;
  displayName: string;
  ws: WebSocket | null;
  startingBalance: number;
  currentBalance: number;
  committed: boolean;
  revealed: boolean;
  hash: string | null;
  optionIndex: number | null;
  salt: string | null;
  forfeited: boolean;
  disconnectedAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface WorkerMatchState {
  matchId: string;
  players: Map<string, WorkerPlayerState>;
  questions: Question[];
  currentRound: number;
  totalRounds: number;
  phase: string;
  phaseEnteredAt: number;
  lastSettledRound: number;
  commitTimer: ReturnType<typeof setTimeout> | null;
  revealTimer: ReturnType<typeof setTimeout> | null;
  resultsTimer: ReturnType<typeof setTimeout> | null;
  /** Cached last round_result payload for reconnect replay during results phase. Checkpointed. */
  lastRoundResult: RoundResultMessage['result'] | null;
}

interface FormingMatchState {
  players: string[];
  timer: ReturnType<typeof setTimeout> | null;
  fillDeadlineMs: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TOTAL_ROUNDS = 10;
const FILL_TIMER_MS = 20_000;
const GRACE_DURATION_MS = 15_000;
const MAX_CHAT_LENGTH = 300;
const MAX_MATCH_SIZE = 7;
const MIN_MATCH_SIZE = 3;
const STALE_MATCH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Worker main handler (delegates to httpHandler module)
// ---------------------------------------------------------------------------

export default {
  fetch: handleHttpRequest,
};

// ===========================================================================
// Durable Object: GameRoom (singleton Lobby)
// ===========================================================================

export class GameRoom {
  state: DurableObjectState;
  env: Env;

  // accountId -> ConnectionState
  connections: Map<string, ConnectionState>;

  // FIFO waiting queue: array of accountId
  waitingQueue: string[];

  // Forming match state (one at a time)
  formingMatch: FormingMatchState | null;

  // Active matches: matchId -> WorkerMatchState
  activeMatches: Map<string, WorkerMatchState>;

  // Quick lookup: accountId -> matchId
  playerMatchIndex: Map<string, string>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.connections = new Map();
    this.waitingQueue = [];
    this.formingMatch = null;
    this.activeMatches = new Map();
    this.playerMatchIndex = new Map();

    initCheckpointTables(this.state.storage.sql);
    this._restoreMatchesFromStorage();
  }

  async fetch(request: Request): Promise<Response> {
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
      const tokenBalance = parseInt(
        url.searchParams.get('tokenBalance') || '0',
        10,
      );

      if (!accountId || !displayName) {
        return new Response('Missing auth params', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this._handleWebSocket(server, accountId, displayName, tokenBalance);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  _handleWebSocket(
    ws: WebSocket,
    accountId: string,
    displayName: string,
    _tokenBalance: number,
  ): void {
    ws.accept();

    // Check for reconnect to an active match
    const existingMatchId = this.playerMatchIndex.get(accountId);
    const existingConn = this.connections.get(accountId);

    if (existingConn && existingMatchId) {
      // Reconnecting to an active match
      const match = this.activeMatches.get(existingMatchId);
      if (match) {
        const playerState = match.players.get(accountId);
        if (playerState?.disconnectedAt && !playerState.forfeited) {
          // Clear grace timer and reattach
          if (playerState.graceTimer) {
            clearTimeout(playerState.graceTimer);
            playerState.graceTimer = null;
          }
          playerState.disconnectedAt = null;
          playerState.ws = ws;
          existingConn.ws = ws;
          this._checkpointPlayerAction(existingMatchId, accountId, {
            disconnectedAt: null,
          });
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

    // Post-eviction reconnect: player has a restored match but no connection entry
    if (!existingConn && existingMatchId) {
      const match = this.activeMatches.get(existingMatchId);
      if (match) {
        const playerState = match.players.get(accountId);
        if (playerState && !playerState.forfeited) {
          // Create connection entry and reattach
          this.connections.set(accountId, {
            ws,
            displayName,
            autoRequeue: false,
            previousOpponents: new Set(),
          });
          if (playerState.graceTimer) {
            clearTimeout(playerState.graceTimer);
            playerState.graceTimer = null;
          }
          playerState.disconnectedAt = null;
          playerState.ws = ws;
          this._checkpointPlayerAction(existingMatchId, accountId, {
            disconnectedAt: null,
          });
          this._setupWsListeners(ws, accountId);

          this._ensureMatchTimerRunning(match);

          this._broadcastToMatch(match, {
            type: 'player_reconnected',
            displayName,
          });

          this._sendMatchStateToPlayer(match, accountId);
          return;
        }
      }
    }

    // Close previous connection if any (not a match reconnect)
    if (existingConn) {
      try {
        existingConn.ws.close(1000, 'Replaced by new connection');
      } catch {}
      // Remove from queue if they were queued
      this._removeFromQueue(accountId);
    }

    this.connections.set(accountId, {
      ws,
      displayName,
      autoRequeue: false,
      previousOpponents: existingConn
        ? existingConn.previousOpponents
        : new Set(),
    });

    this._setupWsListeners(ws, accountId);

    // Send initial queue state
    this._sendQueueState(accountId);
  }

  _setupWsListeners(ws: WebSocket, accountId: string): void {
    ws.addEventListener('message', (evt: MessageEvent) => {
      this._waitUntil(
        (async () => {
          try {
            const msg = JSON.parse(evt.data as string) as {
              type: string;
              [key: string]: unknown;
            };
            await this._handleMessage(accountId, msg);
          } catch (e) {
            this._sendTo(accountId, {
              type: 'error',
              message: (e as Error).message || 'Internal error',
            });
          }
        })(),
        `websocket message for ${accountId}`,
      );
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

  async _handleMessage(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): Promise<void> {
    switch (msg.type) {
      case 'join_queue':
        return this._handleJoinQueue(accountId);
      case 'leave_queue':
        return this._handleLeaveQueue(accountId);
      case 'commit':
        return this._handleCommit(accountId, msg);
      case 'reveal':
        return this._handleReveal(accountId, msg);
      case 'chat':
        return this._handleChat(accountId, msg);
      case 'question_rating':
        return this._handleQuestionRating(accountId, msg);
      default:
        this._sendTo(accountId, {
          type: 'error',
          message: `Unknown message type: ${msg.type}`,
        });
    }
  }

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  _handleJoinQueue(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    // Cannot join if already in a match
    if (this.playerMatchIndex.has(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Cannot join queue while in a match',
      });
    }
    // Cannot join if already queued
    if (this.waitingQueue.includes(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already in queue',
      });
    }
    // Cannot join if in forming match
    if (this.formingMatch?.players.includes(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already in forming match',
      });
    }

    conn.autoRequeue = true;
    this.waitingQueue.push(accountId);
    this._tryFormMatch();
    this._broadcastQueueState();
  }

  _handleLeaveQueue(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    conn.autoRequeue = false;
    this._removeFromQueue(accountId);
    this._broadcastQueueState();
  }

  _removeFromQueue(accountId: string): void {
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

  _cancelFormingMatch(): void {
    if (!this.formingMatch) return;
    if (this.formingMatch.timer) clearTimeout(this.formingMatch.timer);

    // Return remaining players to front of queue in their existing order
    const returning = this.formingMatch.players;
    this.waitingQueue.unshift(...returning);
    this.formingMatch = null;
  }

  _tryFormMatch(): void {
    // If there is already a forming match, try to add from queue
    if (this.formingMatch) {
      while (
        this.waitingQueue.length > 0 &&
        this.formingMatch.players.length < MAX_MATCH_SIZE
      ) {
        const nextId = this.waitingQueue.shift()!;
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
      this.formingMatch = {
        players: reserved,
        timer: null,
        fillDeadlineMs: null,
      };
      this._startFormingMatch();
      return;
    }

    // Start 20s fill timer
    const fillDeadlineMs = Date.now() + FILL_TIMER_MS;
    const timer = setTimeout(() => this._onFillTimerExpired(), FILL_TIMER_MS);
    this.formingMatch = { players: reserved, timer, fillDeadlineMs };
  }

  _onFillTimerExpired(): void {
    if (!this.formingMatch) return;
    this._startFormingMatch();
  }

  _startFormingMatch(): void {
    if (!this.formingMatch) return;
    if (this.formingMatch.timer) {
      clearTimeout(this.formingMatch.timer);
      this.formingMatch.timer = null;
    }

    const players = this.formingMatch.players;

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

    this._waitUntil(
      this._startMatch(players, matchId),
      `start match ${matchId}`,
    );
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  async _startMatch(playerIds: string[], matchId: string): Promise<void> {
    const questions = selectQuestionsForMatch(TOTAL_ROUNDS);

    const playersMap = new Map<string, WorkerPlayerState>();
    for (const accountId of playerIds) {
      const conn = this.connections.get(accountId);
      if (!conn) continue;

      // Load current balance from D1
      let balance = 0;
      try {
        const row = (await this.env.DB.prepare(
          'SELECT token_balance FROM accounts WHERE account_id = ?',
        )
          .bind(accountId)
          .first()) as { token_balance: number } | null;
        if (row) balance = row.token_balance ?? 0;
      } catch (e) {
        console.error('D1: fetch balance for', accountId, e);
      }

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

    const match: WorkerMatchState = {
      matchId,
      players: playersMap,
      questions,
      currentRound: 0,
      totalRounds: TOTAL_ROUNDS,
      phase: 'starting',
      phaseEnteredAt: Date.now(),
      lastSettledRound: 0,
      commitTimer: null,
      revealTimer: null,
      resultsTimer: null,
      lastRoundResult: null,
    };
    this.activeMatches.set(matchId, match);

    // Batch create match + match_players in D1
    try {
      const createStmts: D1PreparedStatement[] = [
        this.env.DB.prepare(
          'INSERT INTO matches (match_id, started_at, round_count, status) VALUES (?, ?, ?, ?)',
        ).bind(matchId, new Date().toISOString(), TOTAL_ROUNDS, 'active'),
      ];
      for (const [acctId, p] of playersMap) {
        createStmts.push(
          this.env.DB.prepare(
            'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
          ).bind(matchId, acctId, p.displayName, p.startingBalance, 'active'),
        );
      }
      await this.env.DB.batch(createStmts);
    } catch (e) {
      console.error('D1: insert match/match_players for', matchId, e);
    }

    // Broadcast game_started
    const playersInfo = [...playersMap.values()].map((p) => ({
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

  _startCommitPhase(match: WorkerMatchState): void {
    match.phase = 'commit';
    match.currentRound++;
    match.phaseEnteredAt = Date.now();
    match.lastRoundResult = null;
    const question = match.questions[match.currentRound - 1]!;

    // Reset per-round player state
    for (const p of match.players.values()) {
      p.committed = false;
      p.revealed = false;
      p.hash = null;
      p.optionIndex = null;
      p.salt = null;
    }

    this._checkpointMatch(match);

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
      match.commitTimer = null;
      this._startRevealPhase(match);
    }, COMMIT_DURATION * 1000);
  }

  _startRevealPhase(match: WorkerMatchState): void {
    if (match.commitTimer) {
      clearTimeout(match.commitTimer);
      match.commitTimer = null;
    }
    match.phase = 'reveal';
    match.phaseEnteredAt = Date.now();

    this._checkpointMatch(match);

    this._broadcastToMatch(match, {
      type: 'phase_change',
      phase: 'reveal',
      revealDuration: REVEAL_DURATION,
    });

    match.revealTimer = setTimeout(() => {
      match.revealTimer = null;
      this._waitUntil(
        this._finalizeRound(match),
        `finalize round ${match.currentRound} for ${match.matchId}`,
      );
    }, REVEAL_DURATION * 1000);
  }

  async _finalizeRound(match: WorkerMatchState): Promise<void> {
    if (match.revealTimer) {
      clearTimeout(match.revealTimer);
      match.revealTimer = null;
    }
    match.phase = 'results';
    match.phaseEnteredAt = Date.now();

    const question = match.questions[match.currentRound - 1]!;
    const alreadySettled = match.currentRound <= match.lastSettledRound;

    // Build player array for settlement
    const settlementPlayers: PlayerSettlementInput[] = [
      ...match.players.values(),
    ].map((p) => ({
      accountId: p.accountId,
      displayName: p.displayName,
      optionIndex: p.revealed ? p.optionIndex : null,
      validReveal: p.committed && p.revealed && !p.forfeited,
      forfeited: p.forfeited,
      attached: true,
    }));

    const result: RoundResult = settleRound(settlementPlayers, question);

    // Apply balance changes to in-memory state (always needed for correct broadcast)
    for (const pr of result.players) {
      const playerState = match.players.get(pr.accountId);
      if (!playerState) continue;
      if (!alreadySettled) {
        playerState.currentBalance += pr.netDelta;
      }
      (pr as PlayerResultWithBalance).newBalance = playerState.currentBalance;
      pr.revealedOptionLabel =
        pr.revealedOptionIndex !== null
          ? question.options[pr.revealedOptionIndex] || null
          : null;
    }

    // Write to D1 only if this round hasn't been settled before (prevents duplicates after restore)
    if (!alreadySettled) {
      match.lastSettledRound = match.currentRound;
      // Checkpoint before D1 batch so lastSettledRound survives eviction between
      // the D1 writes and the post-settlement checkpoint below
      this._checkpointMatch(match);

      const stmts: D1PreparedStatement[] = [];
      const now = new Date().toISOString();

      for (const pr of result.players) {
        const playerState = match.players.get(pr.accountId);
        if (!playerState) continue;

        stmts.push(
          this.env.DB.prepare(
            'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
          ).bind(playerState.currentBalance, pr.accountId),
        );

        if (!result.voided) {
          stmts.push(
            this.env.DB.prepare(
              'UPDATE player_stats SET rounds_played = rounds_played + 1 WHERE account_id = ?',
            ).bind(pr.accountId),
          );
          if (pr.earnsCoordinationCredit) {
            stmts.push(
              this.env.DB.prepare(
                'UPDATE player_stats SET coherent_rounds = coherent_rounds + 1, ' +
                  'current_streak = current_streak + 1, ' +
                  'longest_streak = MAX(longest_streak, current_streak + 1) ' +
                  'WHERE account_id = ?',
              ).bind(pr.accountId),
            );
          } else {
            stmts.push(
              this.env.DB.prepare(
                'UPDATE player_stats SET current_streak = 0 WHERE account_id = ?',
              ).bind(pr.accountId),
            );
          }
        }

        stmts.push(
          this.env.DB.prepare(
            'INSERT INTO vote_logs (match_id, round_number, question_id, account_id, display_name_snapshot, ' +
              'revealed_option_index, revealed_option_label, won_round, earns_coordination_credit, ' +
              'ante_amount, round_payout, net_delta, player_count, valid_reveal_count, top_count, ' +
              'winner_count, winning_option_indexes_json, voided, void_reason, timestamp) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
            now,
          ),
        );
      }

      if (stmts.length > 0) {
        try {
          await this.env.DB.batch(stmts);
        } catch (e) {
          console.error('D1: batch finalizeRound for', match.matchId, e);
        }
      }
    }

    // Build round result payload for broadcast and reconnect replay
    const roundResultPayload: RoundResultMessage['result'] = {
      roundNum: match.currentRound,
      voided: result.voided,
      voidReason: result.voidReason,
      playerCount: result.playerCount,
      pot: result.pot,
      validRevealCount: result.validRevealCount,
      topCount: result.topCount,
      winningOptionIndexes: result.winningOptionIndexes,
      winnerCount: result.winnerCount,
      payoutPerWinner: result.payoutPerWinner,
      players: result.players.map((pr) => ({
        accountId: pr.accountId,
        displayName: pr.displayName,
        revealedOptionIndex: pr.revealedOptionIndex,
        revealedOptionLabel: pr.revealedOptionLabel,
        wonRound: pr.wonRound,
        earnsCoordinationCredit: pr.earnsCoordinationCredit,
        antePaid: pr.antePaid,
        roundPayout: pr.roundPayout,
        netDelta: pr.netDelta,
        newBalance: (pr as PlayerResultWithBalance).newBalance,
      })),
    };
    match.lastRoundResult = roundResultPayload;

    // Checkpoint after setting lastRoundResult so it survives DO eviction
    this._checkpointMatch(match);

    // Broadcast round_result
    this._broadcastToMatch(match, {
      type: 'round_result',
      resultsDuration: RESULTS_DURATION,
      result: roundResultPayload,
    });

    // Check early termination: no non-forfeited players remain
    if (!this._hasNonForfeitedPlayers(match)) {
      match.resultsTimer = setTimeout(() => {
        match.resultsTimer = null;
        this._waitUntil(this._endMatch(match), `end match ${match.matchId}`);
      }, RESULTS_DURATION * 1000);
      return;
    }

    // After results display, advance
    match.resultsTimer = setTimeout(() => {
      match.resultsTimer = null;
      this._advanceAfterResults(match);
    }, RESULTS_DURATION * 1000);
  }

  async _endMatch(match: WorkerMatchState): Promise<void> {
    match.lastRoundResult = null;
    if (match.resultsTimer) {
      clearTimeout(match.resultsTimer);
      match.resultsTimer = null;
    }
    if (match.commitTimer) {
      clearTimeout(match.commitTimer);
      match.commitTimer = null;
    }
    if (match.revealTimer) {
      clearTimeout(match.revealTimer);
      match.revealTimer = null;
    }
    match.phase = 'ended';
    // Delete checkpoint immediately so a mid-_endMatch eviction won't resurrect this match
    this._deleteMatchCheckpoint(match.matchId);

    const summary = {
      players: [...match.players.values()].map((p) => ({
        displayName: p.displayName,
        startingBalance: p.startingBalance,
        endingBalance: p.currentBalance,
        netDelta: p.currentBalance - p.startingBalance,
        result: p.forfeited ? ('forfeited' as const) : ('completed' as const),
      })),
    };

    this._broadcastToMatch(match, { type: 'game_over', summary });

    // Batch all endMatch D1 writes
    try {
      const endStmts: D1PreparedStatement[] = [
        this.env.DB.prepare(
          'UPDATE matches SET ended_at = ?, status = ? WHERE match_id = ?',
        ).bind(new Date().toISOString(), 'completed', match.matchId),
      ];

      for (const p of match.players.values()) {
        endStmts.push(
          this.env.DB.prepare(
            'UPDATE match_players SET ending_balance = ?, net_delta = ?, result = ? WHERE match_id = ? AND account_id = ?',
          ).bind(
            p.currentBalance,
            p.currentBalance - p.startingBalance,
            p.forfeited ? 'forfeited' : 'completed',
            match.matchId,
            p.accountId,
          ),
        );

        endStmts.push(
          this.env.DB.prepare(
            'UPDATE player_stats SET games_played = games_played + 1 WHERE account_id = ?',
          ).bind(p.accountId),
        );
      }

      await this.env.DB.batch(endStmts);
    } catch (e) {
      console.error('D1: endMatch writes for', match.matchId, e);
    }

    // Track opponents for anti-repeat
    const matchPlayerIds = [...match.players.keys()];
    for (const accountId of matchPlayerIds) {
      const conn = this.connections.get(accountId);
      if (conn) {
        conn.previousOpponents = new Set(
          matchPlayerIds.filter((id) => id !== accountId),
        );
      }
    }

    // Clean up match (checkpoint already deleted at top of _endMatch)
    this.activeMatches.delete(match.matchId);
    for (const accountId of matchPlayerIds) {
      this.playerMatchIndex.delete(accountId);
    }

    // Auto-requeue non-forfeited players with autoRequeue enabled
    for (const p of match.players.values()) {
      if (p.forfeited) continue;
      const conn = this.connections.get(p.accountId);
      if (conn?.autoRequeue) {
        // Refresh balance from D1 before requeueing
        try {
          const row = (await this.env.DB.prepare(
            'SELECT token_balance FROM accounts WHERE account_id = ?',
          )
            .bind(p.accountId)
            .first()) as { token_balance: number } | null;
          if (row) {
            // balance is already updated in D1, just requeue
          }
        } catch (e) {
          console.error('D1: refresh balance for requeue', p.accountId, e);
        }
        this.waitingQueue.push(p.accountId);
      }
    }

    this._tryFormMatch();
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Commit / Reveal / Chat handlers
  // -------------------------------------------------------------------------

  _handleCommit(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): void {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in a match',
      });
    const match = this.activeMatches.get(matchId);
    if (!match)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Match not found',
      });
    if (match.phase !== 'commit') {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in commit phase',
      });
    }
    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'You have been forfeited',
      });
    }
    if (player.committed) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already committed',
      });
    }

    const { hash } = msg as { hash: unknown; type: string };
    if (!validateHash(hash)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Invalid hash format (expected 64-char hex)',
      });
    }

    player.committed = true;
    player.hash = hash;
    this._checkpointPlayerAction(match.matchId, accountId, {
      committed: true,
      hash,
    });

    // Broadcast commit status
    this._broadcastCommitStatus(match);

    // Auto-advance if all non-forfeited players committed
    if (this._allNonForfeitedCommitted(match)) {
      this._startRevealPhase(match);
    }
  }

  _handleReveal(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): void {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in a match',
      });
    const match = this.activeMatches.get(matchId);
    if (!match)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Match not found',
      });
    if (match.phase !== 'reveal') {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in reveal phase',
      });
    }
    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'You have been forfeited',
      });
    }
    if (!player.committed) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Did not commit this round',
      });
    }
    if (player.revealed) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already revealed',
      });
    }

    const { optionIndex, salt } = msg as {
      optionIndex: unknown;
      salt: unknown;
      type: string;
    };
    const question = match.questions[match.currentRound - 1]!;

    if (!validateOptionIndex(optionIndex, question.options.length)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Invalid option index',
      });
    }
    if (!validateSalt(salt)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Salt must be a hex string of at least 32 characters',
      });
    }

    // Verify hash (verifyCommit is synchronous)
    const valid = verifyCommit(optionIndex, salt, player.hash!);
    if (!valid) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Hash mismatch: reveal does not match commitment',
      });
    }

    player.revealed = true;
    player.optionIndex = optionIndex;
    player.salt = salt;
    this._checkpointPlayerAction(match.matchId, accountId, {
      revealed: true,
      optionIndex,
      salt,
    });

    // Broadcast reveal status
    this._broadcastRevealStatus(match);

    // Auto-advance if all committed non-forfeited players revealed
    if (this._allCommittedNonForfeitedRevealed(match)) {
      this._waitUntil(
        this._finalizeRound(match),
        `finalize round ${match.currentRound} for ${match.matchId}`,
      );
    }
  }

  _handleChat(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): void {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) return;
    const match = this.activeMatches.get(matchId);
    if (!match) return;
    if (match.phase !== 'results') {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Chat only allowed during results phase',
      });
    }
    const player = match.players.get(accountId);
    if (!player || player.forfeited) return;

    const text = String(msg.text || '')
      .trim()
      .slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    const messageId = crypto.randomUUID();
    this._broadcastToMatch(match, {
      type: 'chat',
      from: player.displayName,
      text,
      messageId,
    });
  }

  async _handleQuestionRating(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): Promise<void> {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) return;
    const match = this.activeMatches.get(matchId);
    if (!match || match.phase !== 'results') return;
    const player = match.players.get(accountId);
    if (!player || player.forfeited) return;

    const rating =
      msg.rating === 'like'
        ? 'like'
        : msg.rating === 'dislike'
          ? 'dislike'
          : null;
    if (!rating) return;
    const questionId = match.questions[match.currentRound - 1]?.id;
    if (!questionId) return;

    try {
      await this.env.DB.prepare(`
        INSERT INTO question_ratings (question_id, account_id, match_id, round_number, rating)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(question_id, account_id, match_id) DO UPDATE SET rating = excluded.rating
      `)
        .bind(questionId, accountId, matchId, match.currentRound, rating)
        .run();
    } catch {
      return;
    }

    // Broadcast updated tally to match
    const rows = await this.env.DB.prepare(`
      SELECT rating, COUNT(*) as cnt FROM question_ratings
      WHERE question_id = ? AND match_id = ?
      GROUP BY rating
    `)
      .bind(questionId, matchId)
      .all();

    const tally = { likes: 0, dislikes: 0 };
    for (const r of rows.results as Array<{ rating: string; cnt: number }>) {
      if (r.rating === 'like') tally.likes = r.cnt;
      else if (r.rating === 'dislike') tally.dislikes = r.cnt;
    }

    this._broadcastToMatch(match, {
      type: 'question_rating_tally',
      questionId,
      ...tally,
    });
  }

  // -------------------------------------------------------------------------
  // Disconnect / Reconnect / Forfeit
  // -------------------------------------------------------------------------

  _handleDisconnect(accountId: string): void {
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
    this._checkpointPlayerAction(matchId, accountId, {
      disconnectedAt: player.disconnectedAt,
    });

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

  _forfeitPlayer(match: WorkerMatchState, accountId: string): void {
    const player = match.players.get(accountId);
    if (!player || player.forfeited) return;

    player.forfeited = true;
    player.graceTimer = null;
    this._checkpointPlayerAction(match.matchId, accountId, { forfeited: true });

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
    if (
      match.phase === 'reveal' &&
      this._allCommittedNonForfeitedRevealed(match)
    ) {
      this._waitUntil(
        this._finalizeRound(match),
        `finalize round ${match.currentRound} for ${match.matchId}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  _sendTo(accountId: string, msg: Record<string, unknown>): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {}
  }

  _broadcastToMatch(
    match: WorkerMatchState,
    msg: Record<string, unknown>,
  ): void {
    const data = JSON.stringify(msg);
    for (const p of match.players.values()) {
      if (!p.forfeited || msg.type === 'game_over') {
        if (p.ws)
          try {
            p.ws.send(data);
          } catch {}
      }
    }
  }

  _broadcastCommitStatus(match: WorkerMatchState): void {
    const committed = [...match.players.values()].map((p) => ({
      displayName: p.displayName,
      hasCommitted: p.committed,
    }));
    this._broadcastToMatch(match, { type: 'commit_status', committed });
  }

  _broadcastRevealStatus(match: WorkerMatchState): void {
    const revealed = [...match.players.values()].map((p) => ({
      displayName: p.displayName,
      hasRevealed: p.revealed,
    }));
    this._broadcastToMatch(match, { type: 'reveal_status', revealed });
  }

  _sendQueueState(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    const isQueued =
      this.waitingQueue.includes(accountId) ||
      this.formingMatch?.players.includes(accountId);

    this._sendTo(
      accountId,
      this._buildQueueStateMsg(accountId, !!isQueued, conn.autoRequeue),
    );
  }

  _broadcastQueueState(): void {
    // Send to all connected players NOT in an active match
    for (const [accountId, conn] of this.connections) {
      if (this.playerMatchIndex.has(accountId)) continue;

      const isQueued =
        this.waitingQueue.includes(accountId) ||
        this.formingMatch?.players.includes(accountId);

      const msg = this._buildQueueStateMsg(
        accountId,
        !!isQueued,
        conn.autoRequeue,
      );
      try {
        conn.ws.send(JSON.stringify(msg));
      } catch {}
    }
  }

  _buildQueueStateMsg(
    _accountId: string,
    isQueued: boolean,
    autoRequeue: boolean,
  ): Record<string, unknown> {
    // All queued + forming display names
    const allQueuedIds = [...this.waitingQueue];
    if (this.formingMatch) {
      allQueuedIds.unshift(...this.formingMatch.players);
    }
    const queuedPlayers = allQueuedIds.map((id) => {
      const c = this.connections.get(id);
      return c ? c.displayName : 'unknown';
    });

    let formingMatch: {
      playerCount: number;
      players: string[];
      allowedSizes: number[];
      fillDeadlineMs: number | null;
    } | null = null;
    if (this.formingMatch) {
      const fmPlayers = this.formingMatch.players.map((id) => {
        const c = this.connections.get(id);
        return c ? c.displayName : 'unknown';
      });
      formingMatch = {
        playerCount: this.formingMatch.players.length,
        players: fmPlayers,
        allowedSizes: [3, 5, 7].filter(
          (s) =>
            s <= this.formingMatch!.players.length + this.waitingQueue.length,
        ),
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

  _getPlayerStatus(accountId: string | null): {
    status: string;
    matchId?: string;
  } {
    if (!accountId) return { status: 'idle' };
    if (this.playerMatchIndex.has(accountId)) {
      return {
        status: 'in_match',
        matchId: this.playerMatchIndex.get(accountId)!,
      };
    }
    if (this.formingMatch?.players.includes(accountId)) {
      return { status: 'forming' };
    }
    if (this.waitingQueue.includes(accountId)) {
      return { status: 'queued' };
    }
    return { status: 'idle' };
  }

  _allNonForfeitedCommitted(match: WorkerMatchState): boolean {
    for (const p of match.players.values()) {
      if (!p.forfeited && !p.committed) return false;
    }
    return true;
  }

  _allCommittedNonForfeitedRevealed(match: WorkerMatchState): boolean {
    for (const p of match.players.values()) {
      if (!p.forfeited && p.committed && !p.revealed) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // DO SQLite persistence (delegates to src/worker/persistence.ts)
  // -------------------------------------------------------------------------

  _checkpointMatch(match: WorkerMatchState): void {
    checkpointMatch(this.state.storage.sql, match);
  }

  _checkpointPlayerAction(
    matchId: string,
    accountId: string,
    fields: PlayerActionFields,
  ): void {
    checkpointPlayerAction(this.state.storage.sql, matchId, accountId, fields);
  }

  _deleteMatchCheckpoint(matchId: string): void {
    deleteMatchCheckpoint(this.state.storage.sql, matchId);
  }

  _restoreMatchesFromStorage(): void {
    const restored = restoreMatchesFromStorage(
      this.state.storage.sql,
      STALE_MATCH_THRESHOLD_MS,
    );
    for (const rm of restored) {
      const players = new Map<string, WorkerPlayerState>();
      for (const [id, rp] of rm.players) {
        players.set(id, { ...rp, ws: null, graceTimer: null });
        this.playerMatchIndex.set(id, rm.matchId);
      }
      this.activeMatches.set(rm.matchId, {
        ...rm,
        players,
        commitTimer: null,
        revealTimer: null,
        resultsTimer: null,
        lastRoundResult: rm.lastRoundResult,
      });
    }
  }

  _waitUntil(task: Promise<void>, description: string): void {
    this.state.waitUntil(
      task.catch((error) => {
        console.error(`GameRoom async task failed: ${description}`, error);
      }),
    );
  }

  _ensureMatchTimerRunning(match: WorkerMatchState): void {
    const elapsed = Date.now() - match.phaseEnteredAt;

    if (match.phase === 'commit' && !match.commitTimer) {
      const remaining = Math.max(0, COMMIT_DURATION * 1000 - elapsed);
      if (remaining <= 0) {
        this._startRevealPhase(match);
      } else {
        match.commitTimer = setTimeout(() => {
          match.commitTimer = null;
          this._startRevealPhase(match);
        }, remaining);
      }
    } else if (match.phase === 'reveal' && !match.revealTimer) {
      const remaining = Math.max(0, REVEAL_DURATION * 1000 - elapsed);
      if (remaining <= 0) {
        this._waitUntil(
          this._finalizeRound(match),
          `finalize round ${match.currentRound} for ${match.matchId}`,
        );
      } else {
        match.revealTimer = setTimeout(() => {
          match.revealTimer = null;
          this._waitUntil(
            this._finalizeRound(match),
            `finalize round ${match.currentRound} for ${match.matchId}`,
          );
        }, remaining);
      }
    } else if (match.phase === 'results' && !match.resultsTimer) {
      const remaining = Math.max(0, RESULTS_DURATION * 1000 - elapsed);
      if (remaining <= 0) {
        this._advanceAfterResults(match);
      } else {
        match.resultsTimer = setTimeout(() => {
          match.resultsTimer = null;
          this._advanceAfterResults(match);
        }, remaining);
      }
    }

    // Start grace timers for still-disconnected, non-forfeited players
    const now = Date.now();
    for (const p of match.players.values()) {
      if (p.disconnectedAt !== null && !p.forfeited && !p.graceTimer) {
        const elapsedGrace = now - p.disconnectedAt;
        const remainingGrace = GRACE_DURATION_MS - elapsedGrace;
        if (remainingGrace <= 0) {
          this._forfeitPlayer(match, p.accountId);
        } else {
          p.graceTimer = setTimeout(() => {
            this._forfeitPlayer(match, p.accountId);
          }, remainingGrace);
        }
      }
    }
  }

  _advanceAfterResults(match: WorkerMatchState): void {
    if (
      match.currentRound >= match.totalRounds ||
      !this._hasNonForfeitedPlayers(match)
    ) {
      this._waitUntil(this._endMatch(match), `end match ${match.matchId}`);
    } else {
      this._startCommitPhase(match);
    }
  }

  _hasNonForfeitedPlayers(match: WorkerMatchState): boolean {
    for (const p of match.players.values()) {
      if (!p.forfeited) return true;
    }
    return false;
  }

  _sendMatchStateToPlayer(match: WorkerMatchState, accountId: string): void {
    const question = match.questions[match.currentRound - 1]!;
    const player = match.players.get(accountId);
    if (!player) return;

    // Send game_started so the client knows the match context
    const playersInfo = [...match.players.values()].map((p) => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    }));
    this._sendTo(accountId, {
      type: 'game_started',
      matchId: match.matchId,
      roundCount: match.totalRounds,
      players: playersInfo,
    });

    // Send current round info with remaining time (not full duration)
    if (
      match.phase === 'commit' ||
      match.phase === 'reveal' ||
      match.phase === 'results'
    ) {
      const elapsed = Date.now() - match.phaseEnteredAt;
      const commitRemaining = Math.max(
        0,
        Math.ceil((COMMIT_DURATION * 1000 - elapsed) / 1000),
      );
      const revealRemaining = Math.max(
        0,
        Math.ceil((REVEAL_DURATION * 1000 - elapsed) / 1000),
      );

      this._sendTo(accountId, {
        type: 'round_start',
        round: match.currentRound,
        question: {
          id: question.id,
          text: question.text,
          type: question.type,
          options: question.options,
        },
        commitDuration:
          match.phase === 'commit' ? commitRemaining : COMMIT_DURATION,
        roundAnte: ROUND_ANTE,
        phase: match.phase,
        yourCommitted: player.committed,
        yourRevealed: player.revealed,
      });

      if (match.phase === 'reveal') {
        this._sendTo(accountId, {
          type: 'phase_change',
          phase: 'reveal',
          revealDuration: revealRemaining,
        });
      }

      // Send commit status
      this._sendTo(accountId, {
        type: 'commit_status',
        committed: [...match.players.values()].map((p) => ({
          displayName: p.displayName,
          hasCommitted: p.committed,
        })),
      });

      // Send reveal status if in reveal or results
      if (match.phase === 'reveal' || match.phase === 'results') {
        this._sendTo(accountId, {
          type: 'reveal_status',
          revealed: [...match.players.values()].map((p) => ({
            displayName: p.displayName,
            hasRevealed: p.revealed,
          })),
        });
      }

      // Replay cached round result so the reconnecting client renders the results screen
      if (match.phase === 'results' && match.lastRoundResult) {
        this._sendTo(accountId, {
          type: 'round_result',
          resultsDuration: RESULTS_DURATION,
          result: match.lastRoundResult,
        });
      }
    }
  }
}

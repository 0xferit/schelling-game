import {
  createCommitHash,
  normalizeRevealText,
  validateAnswerText,
  validateHash,
  validateOptionIndex,
  validateSalt,
  verifyCommit,
  verifyOpenTextCommit,
} from './domain/commitReveal';
import {
  COMMIT_DURATION,
  GAME_ANTE,
  RESULTS_DURATION,
  REVEAL_DURATION,
} from './domain/constants';
import { selectPromptsForMatch } from './domain/prompts';
import { settleGame } from './domain/settlement';
import type {
  GameResult,
  NormalizationMode,
  PlayerResultWithBalance,
  PlayerSettlementInput,
  SchellingPrompt,
} from './types/domain';
import type {
  ClientMessage,
  GameResultMessage,
  QueueStateMessage,
  ServerMessage,
} from './types/messages';
import type { Env } from './types/worker-env';
import { handleHttpRequest } from './worker/httpHandler';
import type {
  PersistedMatchFields,
  PersistedPlayerState,
  PlayerActionFields,
} from './worker/persistence';
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
  startNow: boolean;
  previousOpponents: Set<string>;
  lastActivityAt: number;
  livenessTimer: ReturnType<typeof setInterval> | null;
}

interface WorkerPlayerState extends PersistedPlayerState {
  ws: WebSocket | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  pendingAiCommit: boolean;
}

interface WorkerMatchState extends PersistedMatchFields {
  players: Map<string, WorkerPlayerState>;
  commitTimer: ReturnType<typeof setTimeout> | null;
  revealTimer: ReturnType<typeof setTimeout> | null;
  resultsTimer: ReturnType<typeof setTimeout> | null;
}

interface FormingMatchState {
  players: string[];
  timer: ReturnType<typeof setTimeout> | null;
  fillDeadlineMs: number | null;
}

interface NormalizationVerdict {
  normalizedInputText: string;
  bucketKey: string;
  bucketLabel: string;
}

interface NormalizationRun {
  runId: string | null;
  mode: NormalizationMode;
  verdicts: Map<string, NormalizationVerdict>;
  model: string | null;
  normalizerPrompt: string | null;
  requestJson: string | null;
  responseJson: string | null;
}

function neutralizeAiAssistedResult(result: GameResult): GameResult {
  return {
    ...result,
    pot: 0,
    dustBurned: 0,
    payoutPerWinner: 0,
    players: result.players.map((player) => ({
      ...player,
      antePaid: 0,
      gamePayout: 0,
      netDelta: 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TOTAL_GAMES = 10;
const FILL_TIMER_MS = 30_000;
const GRACE_DURATION_MS = 15_000;
const MAX_MATCH_SIZE = 21;
const MIN_MATCH_SIZE = 3;
const MIN_ALLOWED_BALANCE = -TOTAL_GAMES * GAME_ANTE;
const STALE_MATCH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const AI_BOT_ACCOUNT_PREFIX = 'ai-bot:';
const DEFAULT_AI_BOT_MODELS = [
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const DEFAULT_AI_BOT_TIMEOUT_MS = 5_000;
const AI_BOT_COMMIT_BUFFER_MS = 1_500;
const DEFAULT_OPEN_TEXT_NORMALIZER_MODEL =
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_OPEN_TEXT_NORMALIZER_TIMEOUT_MS = 3_000;
const WS_LIVENESS_CHECK_INTERVAL_MS = 10_000;
const WS_IDLE_TIMEOUT_MS = 35_000;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildAllowedMatchSizes(availablePlayers: number): number[] {
  const sizes: number[] = [];
  const maxAllowed = Math.min(availablePlayers, MAX_MATCH_SIZE);
  for (let size = MIN_MATCH_SIZE; size <= maxAllowed; size += 1) {
    sizes.push(size);
  }
  return sizes;
}

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
          this._clearConnectionLivenessMonitor(accountId);
          existingConn.ws = ws;
          existingConn.lastActivityAt = Date.now();
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
            startNow: false,
            previousOpponents: new Set(),
            lastActivityAt: Date.now(),
            livenessTimer: null,
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

    // Clean up the stale index entry so the player can re-queue, but only if
    // the match is actually gone or the player is no longer an active
    // participant in it.
    if (existingMatchId) {
      const match = this.activeMatches.get(existingMatchId);
      const playerState = match?.players.get(accountId);
      if (!match || !playerState || playerState.forfeited) {
        this.playerMatchIndex.delete(accountId);
      }
    }

    // Close previous connection if any (not a match reconnect)
    if (existingConn) {
      this._clearConnectionLivenessMonitor(accountId);
      try {
        existingConn.ws.close(1000, 'Replaced by new connection');
      } catch {}
      // Remove from queue if they were queued
      this._removeFromQueue(accountId);
      this._ensureAiBotBackfill();
      this._tryFormMatch();
    }

    this.connections.set(accountId, {
      ws,
      displayName,
      startNow: false,
      previousOpponents: existingConn
        ? existingConn.previousOpponents
        : new Set(),
      lastActivityAt: Date.now(),
      livenessTimer: null,
    });

    this._setupWsListeners(ws, accountId);

    // Send initial queue state
    this._sendQueueState(accountId);
  }

  _noteConnectionActivity(accountId: string, ws: WebSocket): void {
    const conn = this.connections.get(accountId);
    if (!conn || conn.ws !== ws) return;
    conn.lastActivityAt = Date.now();
  }

  _clearConnectionLivenessMonitor(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn?.livenessTimer) return;
    clearInterval(conn.livenessTimer);
    conn.livenessTimer = null;
  }

  _startConnectionLivenessMonitor(accountId: string, ws: WebSocket): void {
    this._clearConnectionLivenessMonitor(accountId);
    const conn = this.connections.get(accountId);
    if (!conn || conn.ws !== ws) return;
    conn.lastActivityAt = Date.now();
    conn.livenessTimer = setInterval(() => {
      const current = this.connections.get(accountId);
      if (!current || current.ws !== ws) {
        this._clearConnectionLivenessMonitor(accountId);
        return;
      }
      if (Date.now() - current.lastActivityAt < WS_IDLE_TIMEOUT_MS) return;

      this._clearConnectionLivenessMonitor(accountId);
      try {
        ws.close(4000, 'Heartbeat timeout');
      } catch {}
    }, WS_LIVENESS_CHECK_INTERVAL_MS);
  }

  _setupWsListeners(ws: WebSocket, accountId: string): void {
    this._startConnectionLivenessMonitor(accountId, ws);
    const isCurrentConnection = (): boolean =>
      this.connections.get(accountId)?.ws === ws;

    ws.addEventListener('message', (evt: MessageEvent) => {
      if (!isCurrentConnection()) return;
      this._noteConnectionActivity(accountId, ws);
      this._waitUntil(
        (async () => {
          const raw = evt.data;
          if (typeof raw !== 'string') {
            this._sendTo(accountId, {
              type: 'error',
              message: 'Invalid message payload.',
            });
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            this._sendTo(accountId, {
              type: 'error',
              message: 'Invalid message payload.',
            });
            return;
          }

          if (
            !parsed ||
            typeof parsed !== 'object' ||
            typeof (parsed as { type?: unknown }).type !== 'string'
          ) {
            this._sendTo(accountId, {
              type: 'error',
              message: 'Invalid message payload.',
            });
            return;
          }

          try {
            await this._handleMessage(accountId, parsed as ClientMessage);
          } catch (error) {
            console.error('WebSocket message handling failed', {
              accountId,
              error,
            });
            this._sendTo(accountId, {
              type: 'error',
              message: 'Unable to process message.',
            });
          }
        })(),
        `websocket message for ${accountId}`,
      );
    });

    ws.addEventListener('close', () => {
      if (!isCurrentConnection()) return;
      this._clearConnectionLivenessMonitor(accountId);
      this._handleDisconnect(accountId);
    });

    ws.addEventListener('error', () => {
      if (!isCurrentConnection()) return;
      this._clearConnectionLivenessMonitor(accountId);
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
      case 'forfeit_match':
        return this._handleForfeitMatch(accountId);
      case 'set_start_now':
        return this._handleSetStartNow(accountId, msg);
      case 'commit':
        return this._handleCommit(accountId, msg);
      case 'reveal':
        return this._handleReveal(accountId, msg);
      case 'prompt_rating':
        return this._handlePromptRating(accountId, msg);
      case 'ping':
        this._sendTo(accountId, {
          type: 'pong',
          serverTime: Date.now(),
          ...(typeof msg.sentAt === 'number' ? { sentAt: msg.sentAt } : {}),
        });
        return;
      default:
        this._sendTo(accountId, {
          type: 'error',
          message: `Unknown message type: ${msg.type}`,
        });
    }
  }

  _aiBotEnabled(): boolean {
    return (
      this.env.AI_BOT_ENABLED === 'true' || this.env.AI_BOT_ENABLED === '1'
    );
  }

  _isAiBot(accountId: string): boolean {
    return accountId.startsWith(AI_BOT_ACCOUNT_PREFIX);
  }

  _createAiBotId(modelIndex: number): string {
    return `${AI_BOT_ACCOUNT_PREFIX}${modelIndex}:${crypto.randomUUID()}`;
  }

  _getBotModelIndex(accountId: string): number {
    const afterPrefix = accountId.slice(AI_BOT_ACCOUNT_PREFIX.length);
    const colonPos = afterPrefix.indexOf(':');
    if (colonPos === -1) return 0;
    return Number.parseInt(afterPrefix.slice(0, colonPos), 10) || 0;
  }

  _getAiBotModels(): string[] {
    const raw = this.env.AI_BOT_MODELS?.trim();
    if (raw) {
      const models = raw
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      if (models.length > 0) return models;
    }
    return DEFAULT_AI_BOT_MODELS;
  }

  _getAiBotModel(accountId: string): string {
    const models = this._getAiBotModels();
    const index = this._getBotModelIndex(accountId);
    // models is guaranteed non-empty by _getAiBotModels
    return models[index % models.length] as string;
  }

  _openTextPromptsEnabled(): boolean {
    return (
      this.env.OPEN_TEXT_PROMPTS_ENABLED === 'true' ||
      this.env.OPEN_TEXT_PROMPTS_ENABLED === '1'
    );
  }

  _getOpenTextNormalizerModel(): string {
    const configured = this.env.OPEN_TEXT_NORMALIZER_MODEL?.trim();
    if (configured) return configured;
    return DEFAULT_OPEN_TEXT_NORMALIZER_MODEL;
  }

  _getOpenTextNormalizerTimeoutMs(): number {
    const parsed = Number.parseInt(
      this.env.OPEN_TEXT_NORMALIZER_TIMEOUT_MS || '',
      10,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_OPEN_TEXT_NORMALIZER_TIMEOUT_MS;
    }
    return parsed;
  }

  _getDisplayName(accountId: string): string {
    if (this._isAiBot(accountId)) {
      const model = this._getAiBotModel(accountId);
      return model.split('/').pop() || model;
    }
    return this.connections.get(accountId)?.displayName || 'unknown';
  }

  _getMatchGameAnte(match: Pick<PersistedMatchFields, 'aiAssisted'>): number {
    return match.aiAssisted ? 0 : GAME_ANTE;
  }

  _isMatchEntryBalanceAllowed(balance: number): boolean {
    return balance >= MIN_ALLOWED_BALANCE;
  }

  _matchEntryBalanceError(balance: number): string {
    return (
      `Balance too low to enter queue. Minimum allowed balance is ${MIN_ALLOWED_BALANCE}, ` +
      `current balance is ${balance}.`
    );
  }

  _getAiBotTimeoutMs(): number {
    const parsed = Number.parseInt(this.env.AI_BOT_TIMEOUT_MS || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_AI_BOT_TIMEOUT_MS;
    }
    return parsed;
  }

  _countQueuedHumans(): number {
    let count = 0;
    for (const accountId of this.waitingQueue) {
      if (!this._isAiBot(accountId)) {
        count += 1;
      }
    }
    if (this.formingMatch) {
      for (const accountId of this.formingMatch.players) {
        if (!this._isAiBot(accountId)) {
          count += 1;
        }
      }
    }
    return count;
  }

  _getFormingHumanIds(): string[] {
    if (!this.formingMatch) return [];
    return this.formingMatch.players.filter(
      (accountId) => !this._isAiBot(accountId),
    );
  }

  _clearStartNowFlags(accountIds: string[]): void {
    for (const accountId of accountIds) {
      if (this._isAiBot(accountId)) continue;
      const conn = this.connections.get(accountId);
      if (conn) conn.startNow = false;
    }
  }

  _allFormingHumansWantStartNow(): boolean {
    const humanIds = this._getFormingHumanIds();
    if (humanIds.length === 0) return false;

    return humanIds.every(
      (accountId) => this.connections.get(accountId)?.startNow,
    );
  }

  _tryStartReadyMatch(): boolean {
    if (!this.formingMatch) return false;
    if (this.formingMatch.players.length < MIN_MATCH_SIZE) return false;
    if (!this._allFormingHumansWantStartNow()) return false;

    this._startFormingMatch();
    return true;
  }

  _getQueuedAiBotIds(): string[] {
    const botIds = this.waitingQueue.filter((accountId) =>
      this._isAiBot(accountId),
    );
    if (this.formingMatch) {
      botIds.push(
        ...this.formingMatch.players.filter((accountId) =>
          this._isAiBot(accountId),
        ),
      );
    }
    return botIds;
  }

  // Must be called BEFORE _tryFormMatch at every call site. It reads
  // both waitingQueue and formingMatch to count humans, so the caller
  // must not move players between those structures between the two calls.
  _ensureAiBotBackfill(): void {
    const queuedBotIds = this._getQueuedAiBotIds();

    if (!this._aiBotEnabled()) {
      for (const botId of queuedBotIds) {
        this._removeFromQueue(botId);
      }
      return;
    }

    const humanCount = this._countQueuedHumans();
    const botsNeeded =
      humanCount >= 1 && humanCount < MIN_MATCH_SIZE
        ? MIN_MATCH_SIZE - humanCount
        : 0;

    if (botsNeeded > 0) {
      // Remove excess bots
      while (queuedBotIds.length > botsNeeded) {
        const excess = queuedBotIds.pop();
        if (excess) this._removeFromQueue(excess);
      }
      // Add missing bots, each with a distinct model index
      const usedIndices = new Set(
        queuedBotIds.map((id) => this._getBotModelIndex(id)),
      );
      let nextIndex = 0;
      while (queuedBotIds.length < botsNeeded) {
        while (usedIndices.has(nextIndex)) nextIndex++;
        this.waitingQueue.push(this._createAiBotId(nextIndex));
        usedIndices.add(nextIndex);
        queuedBotIds.push(''); // track count
        nextIndex++;
      }
      return;
    }

    for (const botId of queuedBotIds) {
      this._removeFromQueue(botId);
    }
  }

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  async _handleJoinQueue(accountId: string): Promise<void> {
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

    const balance = await this._fetchAccountBalance(accountId);
    if (balance === null) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Unable to verify balance. Please try joining again.',
      });
    }
    if (!this._isMatchEntryBalanceAllowed(balance)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: this._matchEntryBalanceError(balance),
      });
    }

    conn.startNow = false;
    this.waitingQueue.push(accountId);
    this._ensureAiBotBackfill();
    this._tryFormMatch();
    this._broadcastQueueState();
  }

  _handleLeaveQueue(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    conn.startNow = false;
    this._removeFromQueue(accountId);
    this._ensureAiBotBackfill();
    this._tryFormMatch();
    this._broadcastQueueState();
  }

  _handleSetStartNow(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    if (typeof msg.value !== 'boolean') {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'start_now vote must be true or false',
      });
    }

    if (!this.formingMatch?.players.includes(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Start now is only available while your match is forming',
      });
    }

    conn.startNow = msg.value;
    if (this._tryStartReadyMatch()) return;
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
    this._clearStartNowFlags(returning);
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
        const nextId = this.waitingQueue.shift();
        if (nextId === undefined) break;
        this.formingMatch.players.push(nextId);
      }
      // If max reached, start immediately
      if (this.formingMatch.players.length >= MAX_MATCH_SIZE) {
        this._startFormingMatch();
      } else {
        this._tryStartReadyMatch();
      }
      return;
    }

    // No forming match: need at least 3 in queue to begin
    if (this.waitingQueue.length < MIN_MATCH_SIZE) return;

    // Reserve up to MAX_MATCH_SIZE players from the queue
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

    // Start 30s fill timer
    const fillDeadlineMs = Date.now() + FILL_TIMER_MS;
    const timer = setTimeout(() => this._onFillTimerExpired(), FILL_TIMER_MS);
    this.formingMatch = { players: reserved, timer, fillDeadlineMs };
    this._tryStartReadyMatch();
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

    // Should still have at least 3
    if (players.length < MIN_MATCH_SIZE) {
      this._clearStartNowFlags(players);
      this.waitingQueue.unshift(...players);
      this.formingMatch = null;
      this._tryFormMatch();
      this._broadcastQueueState();
      return;
    }

    this._clearStartNowFlags(players);

    const matchId = crypto.randomUUID();
    this.formingMatch = null;

    this._waitUntil(
      this._startMatch(players, matchId),
      `start match ${matchId}`,
    );
    this._tryFormMatch();
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  async _startMatch(playerIds: string[], matchId: string): Promise<void> {
    const aiAssisted = playerIds.some((id) => this._isAiBot(id));
    const includeOpenText =
      !aiAssisted && this._openTextPromptsEnabled() && !!this.env.AI;
    const prompts = selectPromptsForMatch(TOTAL_GAMES, { includeOpenText });

    const playersMap = new Map<string, WorkerPlayerState>();
    for (const accountId of playerIds) {
      let balance = 0;
      let displayName = this._getDisplayName(accountId);
      let ws: WebSocket | null = null;

      if (!this._isAiBot(accountId)) {
        const conn = this.connections.get(accountId);
        if (!conn) continue;
        displayName = conn.displayName;
        ws = conn.ws;

        // Load current balance from D1
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

        if (!aiAssisted && !this._isMatchEntryBalanceAllowed(balance)) {
          conn.startNow = false;
          this._sendTo(accountId, {
            type: 'error',
            message: this._matchEntryBalanceError(balance),
          });
          continue;
        }
      }

      playersMap.set(accountId, {
        accountId,
        displayName,
        ws,
        startingBalance: balance,
        currentBalance: balance,
        committed: false,
        revealed: false,
        hash: null,
        optionIndex: null,
        answerText: null,
        normalizedRevealText: null,
        salt: null,
        forfeited: false,
        forfeitedAtGame: null,
        disconnectedAt: null,
        graceTimer: null,
        pendingAiCommit: false,
      });

      this.playerMatchIndex.set(accountId, matchId);
    }

    if (playersMap.size < MIN_MATCH_SIZE) {
      const eligibleIds = [...playersMap.keys()];
      this._clearStartNowFlags(eligibleIds);
      for (const accountId of eligibleIds) {
        if (!this.waitingQueue.includes(accountId)) {
          this.waitingQueue.push(accountId);
        }
        this.playerMatchIndex.delete(accountId);
      }
      this._ensureAiBotBackfill();
      this._tryFormMatch();
      this._broadcastQueueState();
      return;
    }

    const match: WorkerMatchState = {
      matchId,
      players: playersMap,
      prompts,
      currentGame: 0,
      totalGames: TOTAL_GAMES,
      phase: 'starting',
      phaseEnteredAt: Date.now(),
      lastSettledGame: 0,
      commitTimer: null,
      revealTimer: null,
      resultsTimer: null,
      lastGameResult: null,
      aiAssisted,
    };
    this.activeMatches.set(matchId, match);

    // Batch create match + match_players in D1
    try {
      const createStmts: D1PreparedStatement[] = [
        this.env.DB.prepare(
          'INSERT INTO matches (match_id, started_at, game_count, player_count, status, ai_assisted) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(
          matchId,
          new Date().toISOString(),
          TOTAL_GAMES,
          playersMap.size,
          'active',
          match.aiAssisted ? 1 : 0,
        ),
      ];
      for (const [acctId, p] of playersMap) {
        if (this._isAiBot(acctId)) continue;
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

    // Broadcast match_started
    const playersInfo = [...playersMap.values()].map((p) => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    }));

    this._broadcastToMatch(match, {
      type: 'match_started',
      matchId,
      gameCount: TOTAL_GAMES,
      aiAssisted: match.aiAssisted,
      players: playersInfo,
    });

    // Start game 1
    this._startCommitPhase(match);
  }

  _startCommitPhase(match: WorkerMatchState): void {
    const nextGame = match.currentGame + 1;
    const prompt = this._getPromptForGame(match, nextGame);

    match.phase = 'commit';
    match.currentGame = nextGame;
    match.phaseEnteredAt = Date.now();
    match.lastGameResult = null;

    // Reset per-game player state
    for (const p of match.players.values()) {
      p.committed = false;
      p.revealed = false;
      p.hash = null;
      p.optionIndex = null;
      p.answerText = null;
      p.normalizedRevealText = null;
      p.salt = null;
      p.pendingAiCommit = false;
    }

    this._checkpointMatch(match);

    this._broadcastToMatch(match, {
      type: 'game_started',
      game: match.currentGame,
      prompt: cloneJson(prompt),
      commitDuration: COMMIT_DURATION,
      gameAnte: this._getMatchGameAnte(match),
      aiAssisted: match.aiAssisted,
      phase: 'commit',
    });

    this._maybeScheduleAiBotCommit(match);

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
        this._finalizeGame(match),
        `finalize game ${match.currentGame} for ${match.matchId}`,
      );
    }, REVEAL_DURATION * 1000);

    this._autoRevealAiBots(match);
  }

  async _finalizeGame(match: WorkerMatchState): Promise<void> {
    if (match.revealTimer) {
      clearTimeout(match.revealTimer);
      match.revealTimer = null;
    }
    const prompt = this._getPromptForGame(match, match.currentGame);

    match.phase = 'results';
    match.phaseEnteredAt = Date.now();
    const alreadySettled = match.currentGame <= match.lastSettledGame;

    // Build player array for settlement
    const settlementPlayers: PlayerSettlementInput[] = [
      ...match.players.values(),
    ].map((p) => {
      const validReveal = p.committed && p.revealed && !p.forfeited;
      const revealedOptionLabel =
        validReveal &&
        prompt.type === 'select' &&
        p.optionIndex !== null &&
        p.optionIndex >= 0 &&
        p.optionIndex < prompt.options.length
          ? (prompt.options[p.optionIndex] ?? null)
          : null;

      return {
        accountId: p.accountId,
        displayName: p.displayName,
        optionIndex: validReveal ? p.optionIndex : null,
        inputText: validReveal ? p.answerText : null,
        normalizedRevealText: validReveal ? p.normalizedRevealText : null,
        bucketKey:
          validReveal &&
          prompt.type === 'select' &&
          p.optionIndex !== null &&
          revealedOptionLabel
            ? `option:${p.optionIndex}`
            : null,
        bucketLabel:
          validReveal && prompt.type === 'select' ? revealedOptionLabel : null,
        validReveal,
        forfeited: p.forfeited,
        attached: !p.forfeited || p.forfeitedAtGame === match.currentGame,
      };
    });

    let normalizationRun: NormalizationRun = {
      runId: null,
      mode: null,
      verdicts: new Map(),
      model: null,
      normalizerPrompt: null,
      requestJson: null,
      responseJson: null,
    };

    if (prompt.type === 'open_text') {
      const normalizedInputs = [
        ...new Set(
          settlementPlayers
            .filter((player) => player.validReveal)
            .map((player) => player.normalizedRevealText)
            .filter((value): value is string => !!value),
        ),
      ].sort();

      normalizationRun = await this._normalizeOpenTextReveals(
        prompt,
        normalizedInputs,
      );

      for (const player of settlementPlayers) {
        if (!player.validReveal || !player.normalizedRevealText) continue;
        const verdict =
          normalizationRun.verdicts.get(player.normalizedRevealText) || null;
        if (verdict) {
          player.bucketKey = verdict.bucketKey;
          player.bucketLabel = verdict.bucketLabel;
        } else {
          player.bucketKey = player.normalizedRevealText;
          player.bucketLabel = player.normalizedRevealText;
        }
      }
    }

    const settledResult = settleGame(
      settlementPlayers,
      prompt,
      prompt.type === 'open_text' ? normalizationRun.mode : null,
    );
    const result: GameResult = match.aiAssisted
      ? neutralizeAiAssistedResult(settledResult)
      : settledResult;

    // Apply balance changes to in-memory state (always needed for correct broadcast)
    for (const pr of result.players) {
      const playerState = match.players.get(pr.accountId);
      if (!playerState) continue;
      if (!alreadySettled) {
        playerState.currentBalance += pr.netDelta;
        if (
          !match.aiAssisted &&
          playerState.currentBalance < MIN_ALLOWED_BALANCE
        ) {
          playerState.currentBalance = MIN_ALLOWED_BALANCE;
        }
      }
      (pr as PlayerResultWithBalance).newBalance = playerState.currentBalance;
    }

    // Write to D1 only if this game hasn't been settled before (prevents duplicates after restore)
    if (!alreadySettled) {
      match.lastSettledGame = match.currentGame;
      // Checkpoint before D1 batch so lastSettledGame survives eviction between
      // the D1 writes and the post-settlement checkpoint below
      this._checkpointMatch(match);

      const stmts: D1PreparedStatement[] = [];
      const now = new Date().toISOString();

      if (prompt.type === 'open_text' && normalizationRun.runId) {
        stmts.push(
          this.env.DB.prepare(
            'INSERT INTO normalization_runs (run_id, match_id, game_number, prompt_id, mode, model, normalizer_prompt, request_json, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).bind(
            normalizationRun.runId,
            match.matchId,
            match.currentGame,
            prompt.id,
            normalizationRun.mode,
            normalizationRun.model,
            normalizationRun.normalizerPrompt,
            normalizationRun.requestJson,
            normalizationRun.responseJson,
            now,
          ),
        );

        for (const verdict of normalizationRun.verdicts.values()) {
          stmts.push(
            this.env.DB.prepare(
              'INSERT INTO normalization_verdicts (run_id, match_id, game_number, prompt_id, normalized_input_text, bucket_key, bucket_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ).bind(
              normalizationRun.runId,
              match.matchId,
              match.currentGame,
              prompt.id,
              verdict.normalizedInputText,
              verdict.bucketKey,
              verdict.bucketLabel,
              now,
            ),
          );
        }
      }

      for (const pr of result.players) {
        const playerState = match.players.get(pr.accountId);
        if (!playerState) continue;

        if (!this._isAiBot(pr.accountId)) {
          if (!match.aiAssisted) {
            stmts.push(
              this.env.DB.prepare(
                'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
              ).bind(playerState.currentBalance, pr.accountId),
            );
          }

          if (!result.voided && !match.aiAssisted) {
            stmts.push(
              this.env.DB.prepare(
                'UPDATE player_stats SET games_played = games_played + 1 WHERE account_id = ?',
              ).bind(pr.accountId),
            );
            if (pr.earnsCoordinationCredit) {
              stmts.push(
                this.env.DB.prepare(
                  'UPDATE player_stats SET coherent_games = coherent_games + 1, ' +
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
        }

        if (!this._isAiBot(pr.accountId)) {
          stmts.push(
            this.env.DB.prepare(
              'INSERT INTO vote_logs (match_id, game_number, prompt_id, account_id, display_name_snapshot, ' +
                'prompt_type, revealed_option_index, revealed_option_label, revealed_input_text, ' +
                'revealed_bucket_key, revealed_bucket_label, normalization_mode, normalization_run_id, ' +
                'won_game, earns_coordination_credit, ante_amount, game_payout, net_delta, player_count, ' +
                'valid_reveal_count, top_count, winner_count, winning_option_indexes_json, ' +
                'winning_bucket_keys_json, voided, void_reason, timestamp) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).bind(
              match.matchId,
              match.currentGame,
              prompt.id,
              pr.accountId,
              pr.displayName,
              prompt.type,
              pr.revealedOptionIndex,
              pr.revealedOptionLabel,
              pr.revealedInputText,
              pr.revealedBucketKey,
              pr.revealedBucketLabel,
              result.normalizationMode,
              normalizationRun.runId,
              pr.wonGame ? 1 : 0,
              pr.earnsCoordinationCredit ? 1 : 0,
              pr.antePaid,
              pr.gamePayout,
              pr.netDelta,
              result.playerCount,
              result.validRevealCount,
              result.topCount,
              result.winnerCount,
              JSON.stringify(result.winningOptionIndexes),
              JSON.stringify(result.winningBucketKeys),
              result.voided ? 1 : 0,
              result.voidReason,
              now,
            ),
          );
        }
      }

      if (stmts.length > 0) {
        try {
          await this.env.DB.batch(stmts);
        } catch (e) {
          console.error('D1: batch finalizeGame for', match.matchId, e);
        }
      }
    }

    // Build game result payload for broadcast and reconnect replay.
    // Read newBalance from live player state rather than the snapshot
    // captured before the D1 await: a grace-timer forfeit could have
    // burned future-game antes during the batch, making the snapshot
    // stale.
    const gameResultPayload: GameResultMessage['result'] = {
      gameNum: match.currentGame,
      voided: result.voided,
      voidReason: result.voidReason,
      playerCount: result.playerCount,
      pot: result.pot,
      dustBurned: result.dustBurned,
      validRevealCount: result.validRevealCount,
      topCount: result.topCount,
      winningOptionIndexes: result.winningOptionIndexes,
      winningBucketKeys: result.winningBucketKeys,
      winnerCount: result.winnerCount,
      payoutPerWinner: result.payoutPerWinner,
      normalizationMode: result.normalizationMode,
      players: result.players.map((pr) => ({
        accountId: pr.accountId,
        displayName: pr.displayName,
        revealedOptionIndex: pr.revealedOptionIndex,
        revealedOptionLabel: pr.revealedOptionLabel,
        revealedInputText: pr.revealedInputText,
        revealedBucketKey: pr.revealedBucketKey,
        revealedBucketLabel: pr.revealedBucketLabel,
        wonGame: pr.wonGame,
        earnsCoordinationCredit: pr.earnsCoordinationCredit,
        antePaid: pr.antePaid,
        gamePayout: pr.gamePayout,
        netDelta: pr.netDelta,
        newBalance:
          match.players.get(pr.accountId)?.currentBalance ??
          (pr as PlayerResultWithBalance).newBalance,
      })),
    };
    match.lastGameResult = gameResultPayload;

    // Checkpoint after setting lastGameResult so it survives DO eviction
    this._checkpointMatch(match);

    // Broadcast game_result
    this._broadcastToMatch(match, {
      type: 'game_result',
      resultsDuration: RESULTS_DURATION,
      result: gameResultPayload,
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
    match.lastGameResult = null;
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

    this._broadcastToMatch(match, {
      type: 'match_over',
      aiAssisted: match.aiAssisted,
      summary,
    });

    // Batch all endMatch D1 writes
    try {
      const endStmts: D1PreparedStatement[] = [
        this.env.DB.prepare(
          'UPDATE matches SET ended_at = ?, status = ? WHERE match_id = ?',
        ).bind(new Date().toISOString(), 'completed', match.matchId),
      ];

      for (const p of match.players.values()) {
        if (this._isAiBot(p.accountId)) continue;

        if (!match.aiAssisted) {
          endStmts.push(
            this.env.DB.prepare(
              'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
            ).bind(p.currentBalance, p.accountId),
          );
        }

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

        if (!match.aiAssisted) {
          endStmts.push(
            this.env.DB.prepare(
              'UPDATE player_stats SET matches_played = matches_played + 1 WHERE account_id = ?',
            ).bind(p.accountId),
          );
        }
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
          matchPlayerIds.filter((id) => id !== accountId && !this._isAiBot(id)),
        );
      }
    }

    // Clean up match (checkpoint already deleted at top of _endMatch)
    this.activeMatches.delete(match.matchId);
    for (const accountId of matchPlayerIds) {
      if (this.playerMatchIndex.get(accountId) === match.matchId) {
        this.playerMatchIndex.delete(accountId);
      }
    }

    this._ensureAiBotBackfill();
    this._tryFormMatch();
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Commit / Reveal handlers
  // -------------------------------------------------------------------------

  _maybeScheduleAiBotCommit(match: WorkerMatchState): void {
    for (const player of match.players.values()) {
      if (
        !this._isAiBot(player.accountId) ||
        player.forfeited ||
        player.committed ||
        player.pendingAiCommit
      ) {
        continue;
      }
      this._waitUntil(
        this._commitAiBotChoice(match, player.accountId),
        `AI bot commit for ${player.accountId} in ${match.matchId}`,
      );
    }
  }

  async _commitAiBotChoice(
    match: WorkerMatchState,
    accountId: string,
  ): Promise<void> {
    const player = match.players.get(accountId);
    if (
      !player ||
      !this._isAiBot(accountId) ||
      player.forfeited ||
      player.committed ||
      player.pendingAiCommit ||
      match.phase !== 'commit'
    ) {
      return;
    }

    const prompt = this._getPromptForGame(match, match.currentGame);
    if (prompt.type !== 'select') {
      player.pendingAiCommit = false;
      return;
    }
    const gameAtDispatch = match.currentGame;

    player.pendingAiCommit = true;
    try {
      const optionIndex = await this._selectAiBotOption(
        match,
        prompt,
        accountId,
      );
      if (
        match.phase !== 'commit' ||
        match.currentGame !== gameAtDispatch ||
        player.forfeited ||
        player.committed
      ) {
        return;
      }

      const safeOptionIndex = validateOptionIndex(
        optionIndex,
        prompt.options.length,
      )
        ? optionIndex
        : this._pickAiBotFallbackOption(prompt);
      const salt = this._createAiBotSalt();
      const hash = createCommitHash(safeOptionIndex, salt);

      player.committed = true;
      player.hash = hash;
      player.optionIndex = safeOptionIndex;
      player.salt = salt;
      this._checkpointPlayerAction(match.matchId, accountId, {
        committed: true,
        hash,
        optionIndex: safeOptionIndex,
        salt,
      });

      this._broadcastCommitStatus(match);

      if (this._allNonForfeitedCommitted(match)) {
        this._startRevealPhase(match);
      }
    } finally {
      if (
        match.currentGame === gameAtDispatch &&
        match.players.get(accountId) === player
      ) {
        player.pendingAiCommit = false;
      }
    }
  }

  async _selectAiBotOption(
    match: WorkerMatchState,
    prompt: SchellingPrompt,
    accountId: string,
  ): Promise<number> {
    if (prompt.type !== 'select') {
      throw new Error('AI bot selection requires a select prompt');
    }

    if (!this.env.AI) {
      return this._pickAiBotFallbackOption(prompt);
    }

    const elapsedMs = Date.now() - match.phaseEnteredAt;
    const remainingCommitMs =
      COMMIT_DURATION * 1000 - elapsedMs - AI_BOT_COMMIT_BUFFER_MS;
    const timeoutMs = Math.min(this._getAiBotTimeoutMs(), remainingCommitMs);

    if (timeoutMs <= 0) {
      return this._pickAiBotFallbackOption(prompt);
    }

    try {
      const output = await Promise.race([
        this.env.AI.run(this._getAiBotModel(accountId), {
          prompt: this._buildAiBotPrompt(prompt),
          guided_json: {
            type: 'object',
            additionalProperties: false,
            required: ['optionIndex'],
            properties: {
              optionIndex: {
                type: 'integer',
                minimum: 0,
                maximum: prompt.options.length - 1,
              },
            },
          },
          max_tokens: 16,
          temperature: 0,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('AI bot commit timed out')),
            timeoutMs,
          );
        }),
      ]);

      const parsedIndex = this._parseAiBotOptionIndex(output, prompt);
      if (parsedIndex !== null) {
        return parsedIndex;
      }
    } catch (error) {
      console.error('Workers AI bot inference failed', error);
    }

    return this._pickAiBotFallbackOption(prompt);
  }

  _buildAiBotPrompt(prompt: SchellingPrompt): string {
    if (prompt.type !== 'select') {
      throw new Error('AI bot prompt builder requires a select prompt');
    }
    const options = prompt.options
      .map((option, index) => `${index}: ${option}`)
      .join('\n');
    return [
      'You are filling one seat in a multiplayer coordination game.',
      'Choose the option you expect the most human players in this match to choose.',
      "Base the choice on an ordinary player's first instinct, not your personal preference.",
      'Do not explain your reasoning.',
      '',
      `Game prompt: ${prompt.text}`,
      'Options:',
      options,
      '',
      'Respond with JSON: {"optionIndex": <zero-based index>}',
    ].join('\n');
  }

  _parseAiBotOptionIndex(
    output: unknown,
    prompt: SchellingPrompt,
  ): number | null {
    if (prompt.type !== 'select') {
      return null;
    }
    const response =
      typeof output === 'object' &&
      output !== null &&
      'response' in output &&
      typeof output.response === 'string'
        ? output.response.trim()
        : null;

    if (!response) {
      return null;
    }

    try {
      const parsed = JSON.parse(response) as { optionIndex?: unknown };
      if (validateOptionIndex(parsed.optionIndex, prompt.options.length)) {
        return parsed.optionIndex;
      }
    } catch {}

    // Defense-in-depth: guided_json should guarantee structured output,
    // but some models silently ignore the constraint. These branches
    // catch plain-text responses like "Pizza" or "2".
    const exactOptionIndex = prompt.options.findIndex(
      (option) => option.toLowerCase() === response.toLowerCase(),
    );
    if (exactOptionIndex !== -1) {
      return exactOptionIndex;
    }

    const numericMatch = response.match(/-?\d+/);
    if (!numericMatch) {
      return null;
    }

    const parsedIndex = Number.parseInt(numericMatch[0], 10);
    if (!validateOptionIndex(parsedIndex, prompt.options.length)) {
      return null;
    }
    return parsedIndex;
  }

  // Heuristic fallback when Workers AI is unavailable or times out.
  // Only matches numeric-style option labels; for text labels like
  // "Heads"/"Tails" this falls through to the middle-index default.
  _pickAiBotFallbackOption(prompt: SchellingPrompt): number {
    if (prompt.type !== 'select') {
      return 0;
    }
    const normalizedTargets = ['1', '0', '50%', '50', '0.5', '0.50'];
    for (const target of normalizedTargets) {
      const index = prompt.options.findIndex(
        (option) => option.trim().toLowerCase() === target,
      );
      if (index !== -1) {
        return index;
      }
    }
    return Math.floor(prompt.options.length / 2);
  }

  _createAiBotSalt(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  _extractAiResponseText(output: unknown): string | null {
    if (typeof output === 'string') {
      return output.trim() || null;
    }
    if (
      typeof output === 'object' &&
      output !== null &&
      'response' in output &&
      typeof output.response === 'string'
    ) {
      return output.response.trim() || null;
    }
    return null;
  }

  _buildFallbackNormalizationRun(normalizedInputs: string[]): NormalizationRun {
    return {
      runId: null,
      mode: 'fallback_exact',
      verdicts: new Map(
        normalizedInputs.map((normalizedInputText) => [
          normalizedInputText,
          {
            normalizedInputText,
            bucketKey: normalizedInputText,
            bucketLabel: normalizedInputText,
          },
        ]),
      ),
      model: null,
      normalizerPrompt: null,
      requestJson: null,
      responseJson: null,
    };
  }

  _buildOpenTextNormalizationPrompt(
    prompt: SchellingPrompt,
    normalizedInputs: string[],
  ): string {
    return [
      'You are normalizing open-text answers for a Schelling coordination game.',
      'Merge only clearly identical referents or spelling, casing, punctuation, and whitespace variants.',
      'Do not merge nearby but distinct landmarks, concepts, or categories.',
      'Return one verdict for each input string exactly once.',
      '',
      `Game prompt: ${prompt.text}`,
      'Unique normalized player answers:',
      ...normalizedInputs.map((input, index) => `${index + 1}. ${input}`),
      '',
      'For each input, choose a short canonical bucketLabel that humans can read in results.',
      'If two inputs are not clearly the same referent, keep them in separate buckets.',
    ].join('\n');
  }

  _buildBucketKey(bucketLabel: string): string | null {
    const normalized = normalizeRevealText(bucketLabel);
    return normalized || null;
  }

  _parseNormalizationVerdicts(
    output: unknown,
    normalizedInputs: string[],
  ): Map<string, NormalizationVerdict> | null {
    const responseText = this._extractAiResponseText(output);
    if (!responseText) {
      return null;
    }

    try {
      const parsed = JSON.parse(responseText) as {
        verdicts?: Array<{
          normalizedInputText?: unknown;
          bucketLabel?: unknown;
        }>;
      };
      if (!Array.isArray(parsed.verdicts)) {
        return null;
      }

      const expectedInputs = new Set(normalizedInputs);
      const verdicts = new Map<string, NormalizationVerdict>();

      for (const verdict of parsed.verdicts) {
        if (
          !verdict ||
          typeof verdict.normalizedInputText !== 'string' ||
          typeof verdict.bucketLabel !== 'string'
        ) {
          return null;
        }

        const normalizedInputText = verdict.normalizedInputText.trim();
        const bucketLabel = verdict.bucketLabel.trim();
        const bucketKey = this._buildBucketKey(bucketLabel);

        if (
          !normalizedInputText ||
          !bucketLabel ||
          !bucketKey ||
          !expectedInputs.has(normalizedInputText) ||
          verdicts.has(normalizedInputText)
        ) {
          return null;
        }

        verdicts.set(normalizedInputText, {
          normalizedInputText,
          bucketKey,
          bucketLabel,
        });
      }

      if (verdicts.size !== expectedInputs.size) {
        return null;
      }

      for (const normalizedInputText of expectedInputs) {
        if (!verdicts.has(normalizedInputText)) {
          return null;
        }
      }

      return verdicts;
    } catch {
      return null;
    }
  }

  async _normalizeOpenTextReveals(
    prompt: SchellingPrompt,
    normalizedInputs: string[],
  ): Promise<NormalizationRun> {
    if (normalizedInputs.length === 0) {
      return {
        runId: null,
        mode: null,
        verdicts: new Map(),
        model: null,
        normalizerPrompt: null,
        requestJson: null,
        responseJson: null,
      };
    }

    if (!this.env.AI) {
      return this._buildFallbackNormalizationRun(normalizedInputs);
    }

    const normalizerPrompt = this._buildOpenTextNormalizationPrompt(
      prompt,
      normalizedInputs,
    );
    const model = this._getOpenTextNormalizerModel();
    const requestPayload = {
      prompt: normalizerPrompt,
      guided_json: {
        type: 'object',
        additionalProperties: false,
        required: ['verdicts'],
        properties: {
          verdicts: {
            type: 'array',
            minItems: normalizedInputs.length,
            maxItems: normalizedInputs.length,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['normalizedInputText', 'bucketLabel'],
              properties: {
                normalizedInputText: { type: 'string' },
                bucketLabel: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
      max_tokens: 512,
      temperature: 0,
    };

    try {
      const output = await Promise.race([
        this.env.AI.run(model, requestPayload),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('Open-text normalization timed out')),
            this._getOpenTextNormalizerTimeoutMs(),
          );
        }),
      ]);

      const verdicts = this._parseNormalizationVerdicts(
        output,
        normalizedInputs,
      );
      if (!verdicts) {
        return this._buildFallbackNormalizationRun(normalizedInputs);
      }

      return {
        runId: crypto.randomUUID(),
        mode: 'llm',
        verdicts,
        model,
        normalizerPrompt,
        requestJson: JSON.stringify(requestPayload),
        responseJson:
          this._extractAiResponseText(output) ?? JSON.stringify(output),
      };
    } catch (error) {
      console.error('Workers AI open-text normalization failed', error);
      return this._buildFallbackNormalizationRun(normalizedInputs);
    }
  }

  _autoRevealAiBots(match: WorkerMatchState): boolean {
    let anyRevealed = false;
    for (const player of match.players.values()) {
      if (
        !this._isAiBot(player.accountId) ||
        player.forfeited ||
        !player.committed ||
        player.revealed ||
        player.optionIndex === null ||
        !player.salt
      ) {
        continue;
      }

      player.revealed = true;
      this._checkpointPlayerAction(match.matchId, player.accountId, {
        revealed: true,
        optionIndex: player.optionIndex,
        salt: player.salt,
      });
      anyRevealed = true;
    }

    if (!anyRevealed) {
      return false;
    }

    this._broadcastRevealStatus(match);

    if (this._allCommittedNonForfeitedRevealed(match)) {
      this._waitUntil(
        this._finalizeGame(match),
        `finalize game ${match.currentGame} for ${match.matchId}`,
      );
      return true;
    }

    return false;
  }

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
        message: 'Did not commit this game',
      });
    }
    if (player.revealed) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already revealed',
      });
    }

    const { optionIndex, answerText, salt } = msg as {
      optionIndex?: unknown;
      answerText?: unknown;
      salt: unknown;
      type: string;
    };
    const prompt = this._getPromptForGame(match, match.currentGame);
    if (!validateSalt(salt)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Salt must be a hex string between 32 and 128 characters',
      });
    }

    // Verify hash (verifyCommit is synchronous)
    if (!player.hash) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'No commitment found',
      });
    }

    if (prompt.type === 'select') {
      if (!validateOptionIndex(optionIndex, prompt.options.length)) {
        return this._sendTo(accountId, {
          type: 'error',
          message: 'Invalid option index',
        });
      }

      const valid = verifyCommit(optionIndex, salt, player.hash);
      if (!valid) {
        return this._sendTo(accountId, {
          type: 'error',
          message: 'Hash mismatch: reveal does not match commitment',
        });
      }

      player.revealed = true;
      player.optionIndex = optionIndex;
      player.answerText = null;
      player.normalizedRevealText = null;
      player.salt = salt;
      this._checkpointPlayerAction(match.matchId, accountId, {
        revealed: true,
        optionIndex,
        answerText: null,
        normalizedRevealText: null,
        salt,
      });
    } else {
      if (!validateAnswerText(answerText, prompt.maxLength)) {
        return this._sendTo(accountId, {
          type: 'error',
          message: `Answer must be a single line between 1 and ${prompt.maxLength} characters`,
        });
      }

      const valid = verifyOpenTextCommit(answerText, salt, player.hash);
      if (!valid) {
        return this._sendTo(accountId, {
          type: 'error',
          message: 'Hash mismatch: reveal does not match commitment',
        });
      }

      player.revealed = true;
      player.optionIndex = null;
      player.answerText = answerText;
      player.normalizedRevealText = normalizeRevealText(answerText);
      player.salt = salt;
      this._checkpointPlayerAction(match.matchId, accountId, {
        revealed: true,
        optionIndex: null,
        answerText,
        normalizedRevealText: player.normalizedRevealText,
        salt,
      });
    }

    // Broadcast reveal status
    this._broadcastRevealStatus(match);

    // Auto-advance if all committed non-forfeited players revealed
    if (this._allCommittedNonForfeitedRevealed(match)) {
      this._waitUntil(
        this._finalizeGame(match),
        `finalize game ${match.currentGame} for ${match.matchId}`,
      );
    }
  }

  _handleForfeitMatch(accountId: string): void {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in a match',
      });
    }

    const match = this.activeMatches.get(matchId);
    if (!match) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Match not found',
      });
    }

    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already forfeited',
      });
    }

    this._forfeitPlayer(match, accountId);
  }

  async _handlePromptRating(
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
    const promptId = match.prompts[match.currentGame - 1]?.id;
    if (!promptId) return;

    try {
      await this.env.DB.prepare(`
        INSERT INTO prompt_ratings (prompt_id, account_id, match_id, game_number, rating)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(prompt_id, account_id, match_id) DO UPDATE SET rating = excluded.rating
      `)
        .bind(promptId, accountId, matchId, match.currentGame, rating)
        .run();
    } catch {
      return;
    }

    // Broadcast updated tally to match
    const rows = await this.env.DB.prepare(`
      SELECT rating, COUNT(*) as cnt FROM prompt_ratings
      WHERE prompt_id = ? AND match_id = ?
      GROUP BY rating
    `)
      .bind(promptId, matchId)
      .all();

    const tally = { likes: 0, dislikes: 0 };
    for (const r of rows.results as Array<{ rating: string; cnt: number }>) {
      if (r.rating === 'like') tally.likes = r.cnt;
      else if (r.rating === 'dislike') tally.dislikes = r.cnt;
    }

    this._broadcastToMatch(match, {
      type: 'prompt_rating_tally',
      promptId,
      ...tally,
    });
  }

  // -------------------------------------------------------------------------
  // Disconnect / Reconnect / Forfeit
  // -------------------------------------------------------------------------

  _handleDisconnect(accountId: string): void {
    this._clearConnectionLivenessMonitor(accountId);
    const matchId = this.playerMatchIndex.get(accountId);

    if (!matchId) {
      // Not in a match: remove from queue and forming match
      this._removeFromQueue(accountId);
      this.connections.delete(accountId);
      this._ensureAiBotBackfill();
      this._tryFormMatch();
      this._broadcastQueueState();
      return;
    }

    // In a match: start grace timer
    const match = this.activeMatches.get(matchId);
    if (!match) {
      this.playerMatchIndex.delete(accountId);
      this.connections.delete(accountId);
      return;
    }

    const player = match.players.get(accountId);
    if (!player || player.forfeited) {
      this.playerMatchIndex.delete(accountId);
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
    player.forfeitedAtGame = match.currentGame;
    player.graceTimer = null;

    // Burn future-game antes immediately. The player is detached from all
    // subsequent rounds, so this is the only place the penalty is applied.
    // Applying here instead of in _finalizeGame avoids a timing exploit
    // where a disconnect during the results phase would skip the penalty.
    const futureGamesPenaltyApplied = !match.aiAssisted;
    if (futureGamesPenaltyApplied) {
      const futureGames = match.totalGames - match.currentGame;
      player.currentBalance = Math.max(
        MIN_ALLOWED_BALANCE,
        player.currentBalance - futureGames * GAME_ANTE,
      );
    }

    this._checkpointPlayerAction(match.matchId, accountId, {
      forfeited: true,
      forfeitedAtGame: match.currentGame,
      currentBalance: player.currentBalance,
    });

    // Only take the results-phase path when the current game is fully
    // settled (lastGameResult built and cached). _finalizeGame sets
    // phase='results' before the D1 batch await, so checking phase alone
    // would race: the forfeit burn would fire while the batch is in
    // flight, and _finalizeGame would later build the payload from a
    // stale snapshot. Checking gameNum guards against both the mid-await
    // window and a stale lastGameResult from a prior game.
    //
    // During commit/reveal the player is still attached for the current
    // game. _finalizeGame will write the correct post-settlement
    // balance to D1, so persisting here would race with that write.
    const roundFullySettled =
      match.lastGameResult?.gameNum === match.currentGame;
    if (roundFullySettled && futureGamesPenaltyApplied) {
      this._waitUntil(
        this._persistAccountBalance(accountId, player.currentBalance),
        `persist forfeited balance for ${accountId}`,
      );

      // Patch the cached game result so reconnect replay reflects the
      // burned balance instead of the stale pre-forfeit value.
      if (match.lastGameResult) {
        const cached = match.lastGameResult.players.find(
          (p) => p.accountId === accountId,
        );
        if (cached) {
          cached.newBalance = player.currentBalance;
        }
        this._checkpointMatch(match);
      }
    }

    this._broadcastToMatch(match, {
      type: 'player_forfeited',
      displayName: player.displayName,
      futureGamesPenaltyApplied,
    });
    this._sendTo(accountId, {
      type: 'player_forfeited',
      displayName: player.displayName,
      futureGamesPenaltyApplied,
    });

    // If all players are now forfeited, check for early termination
    // This is handled naturally in _finalizeGame via the non-forfeited check.
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
        this._finalizeGame(match),
        `finalize game ${match.currentGame} for ${match.matchId}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  _sendTo(accountId: string, msg: ServerMessage): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {}
  }

  _broadcastToMatch(match: WorkerMatchState, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const p of match.players.values()) {
      if (!p.forfeited || msg.type === 'match_over') {
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

    this._sendTo(accountId, this._buildQueueStateMsg(accountId));
  }

  _broadcastQueueState(): void {
    // Send to all connected players NOT in an active match
    for (const [accountId, conn] of this.connections) {
      if (this.playerMatchIndex.has(accountId)) continue;

      const msg = this._buildQueueStateMsg(accountId);
      try {
        conn.ws.send(JSON.stringify(msg));
      } catch {}
    }
  }

  _buildQueueStateMsg(accountId: string): QueueStateMessage {
    const isForming = this.formingMatch?.players.includes(accountId) ?? false;
    const isQueued = this.waitingQueue.includes(accountId);
    let status: QueueStateMessage['status'] = 'idle';
    if (isForming) {
      status = 'forming';
    } else if (isQueued) {
      status = 'queued';
    }
    // All queued + forming display names
    const allQueuedIds = [...this.waitingQueue];
    if (this.formingMatch) {
      allQueuedIds.unshift(...this.formingMatch.players);
    }
    const queuedPlayers = allQueuedIds.map((id) => this._getDisplayName(id));

    let formingMatch: {
      playerCount: number;
      humanPlayerCount: number;
      readyHumanCount: number;
      players: string[];
      allowedSizes: number[];
      fillDeadlineMs: number | null;
      youCanVoteStartNow: boolean;
    } | null = null;
    const formingState = this.formingMatch;
    if (formingState) {
      const fmPlayers = formingState.players.map((id) =>
        this._getDisplayName(id),
      );
      const humanIds = formingState.players.filter((id) => !this._isAiBot(id));
      const readyHumanCount = humanIds.filter(
        (id) => this.connections.get(id)?.startNow,
      ).length;
      formingMatch = {
        playerCount: formingState.players.length,
        humanPlayerCount: humanIds.length,
        readyHumanCount,
        players: fmPlayers,
        allowedSizes: buildAllowedMatchSizes(
          formingState.players.length + this.waitingQueue.length,
        ),
        fillDeadlineMs: formingState.fillDeadlineMs,
        youCanVoteStartNow: formingState.players.includes(accountId),
      };
    }

    return {
      type: 'queue_state',
      status,
      startNow: this.connections.get(accountId)?.startNow ?? false,
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
    const matchId = this.playerMatchIndex.get(accountId);
    if (matchId) {
      return {
        status: 'in_match',
        matchId,
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

  async _persistAccountBalance(
    accountId: string,
    currentBalance: number,
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
      )
        .bind(currentBalance, accountId)
        .run();
    } catch (error) {
      console.error('D1: persist account balance for', accountId, error);
    }
  }

  async _fetchAccountBalance(accountId: string): Promise<number | null> {
    try {
      const row = await this.env.DB.prepare(
        'SELECT token_balance FROM accounts WHERE account_id = ?',
      )
        .bind(accountId)
        .first<{ token_balance: number | null }>();
      if (!row) return null;
      return row.token_balance ?? 0;
    } catch (error) {
      console.error('D1: fetch account balance for', accountId, error);
      return null;
    }
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
        players.set(id, {
          ...rp,
          ws: null,
          graceTimer: null,
          pendingAiCommit: false,
        });
        this.playerMatchIndex.set(id, rm.matchId);
      }
      this.activeMatches.set(rm.matchId, {
        ...rm,
        players,
        commitTimer: null,
        revealTimer: null,
        resultsTimer: null,
        lastGameResult: rm.lastGameResult,
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
        this._maybeScheduleAiBotCommit(match);
        match.commitTimer = setTimeout(() => {
          match.commitTimer = null;
          this._startRevealPhase(match);
        }, remaining);
      }
    } else if (match.phase === 'reveal' && !match.revealTimer) {
      const remaining = Math.max(0, REVEAL_DURATION * 1000 - elapsed);
      if (remaining <= 0) {
        if (this._autoRevealAiBots(match)) {
          return;
        }
        this._waitUntil(
          this._finalizeGame(match),
          `finalize game ${match.currentGame} for ${match.matchId}`,
        );
      } else {
        match.revealTimer = setTimeout(() => {
          match.revealTimer = null;
          this._waitUntil(
            this._finalizeGame(match),
            `finalize game ${match.currentGame} for ${match.matchId}`,
          );
        }, remaining);
        this._autoRevealAiBots(match);
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
      match.currentGame >= match.totalGames ||
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

  _getPromptForGame(match: WorkerMatchState, game: number): SchellingPrompt {
    const prompt = match.prompts[game - 1];
    if (!prompt) {
      throw new Error(`Missing prompt for match ${match.matchId} game ${game}`);
    }
    return prompt;
  }

  _sendMatchStateToPlayer(match: WorkerMatchState, accountId: string): void {
    const player = match.players.get(accountId);
    if (!player) return;

    // Send match_started so the client knows the match context
    const playersInfo = [...match.players.values()].map((p) => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
      currentBalance: p.currentBalance,
    }));
    this._sendTo(accountId, {
      type: 'match_started',
      matchId: match.matchId,
      gameCount: match.totalGames,
      aiAssisted: match.aiAssisted,
      players: playersInfo,
    });

    if (player.forfeited) {
      this._sendTo(accountId, {
        type: 'player_forfeited',
        displayName: player.displayName,
        futureGamesPenaltyApplied: !match.aiAssisted,
      });
    }

    // Replay peer disconnected/forfeited status so the client renders badges
    for (const peer of match.players.values()) {
      if (peer.accountId === accountId) continue;
      if (peer.forfeited) {
        this._sendTo(accountId, {
          type: 'player_forfeited',
          displayName: peer.displayName,
          futureGamesPenaltyApplied: !match.aiAssisted,
        });
      } else if (peer.disconnectedAt !== null) {
        const elapsedMs = Date.now() - peer.disconnectedAt;
        const remainingGraceSeconds = Math.max(
          0,
          Math.ceil((GRACE_DURATION_MS - elapsedMs) / 1000),
        );
        this._sendTo(accountId, {
          type: 'player_disconnected',
          displayName: peer.displayName,
          graceSeconds: remainingGraceSeconds,
        });
      }
    }

    // Send current game info with remaining time (not full duration)
    if (
      match.phase === 'commit' ||
      match.phase === 'reveal' ||
      match.phase === 'results'
    ) {
      const prompt = this._getPromptForGame(match, match.currentGame);
      const elapsed = Date.now() - match.phaseEnteredAt;
      const commitRemaining = Math.max(
        0,
        Math.ceil((COMMIT_DURATION * 1000 - elapsed) / 1000),
      );
      const revealRemaining = Math.max(
        0,
        Math.ceil((REVEAL_DURATION * 1000 - elapsed) / 1000),
      );
      const resultsRemaining = Math.max(
        0,
        Math.ceil((RESULTS_DURATION * 1000 - elapsed) / 1000),
      );

      this._sendTo(accountId, {
        type: 'game_started',
        game: match.currentGame,
        prompt: cloneJson(prompt),
        commitDuration:
          match.phase === 'commit' ? commitRemaining : COMMIT_DURATION,
        gameAnte: this._getMatchGameAnte(match),
        aiAssisted: match.aiAssisted,
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

      // Replay cached game result so the reconnecting client renders the results screen
      if (match.phase === 'results' && match.lastGameResult) {
        this._sendTo(accountId, {
          type: 'game_result',
          resultsDuration: resultsRemaining,
          result: match.lastGameResult,
        });

        // Replay prompt rating tally and the player's own rating (async D1 query)
        const promptId = match.prompts[match.currentGame - 1]?.id;
        if (promptId) {
          this._waitUntil(
            this._replayRatingTally(
              match.matchId,
              promptId,
              match.currentGame,
              accountId,
            ),
            'replay prompt rating tally on reconnect',
          );
        }
      }
    }
  }

  async _replayRatingTally(
    matchId: string,
    promptId: number,
    gameAtDispatch: number,
    accountId: string,
  ): Promise<void> {
    try {
      const [tallyRows, playerRow] = await Promise.all([
        this.env.DB.prepare(
          `SELECT rating, COUNT(*) as cnt FROM prompt_ratings
           WHERE prompt_id = ? AND match_id = ?
           GROUP BY rating`,
        )
          .bind(promptId, matchId)
          .all(),
        this.env.DB.prepare(
          `SELECT rating FROM prompt_ratings
           WHERE prompt_id = ? AND account_id = ? AND match_id = ?`,
        )
          .bind(promptId, accountId, matchId)
          .first<{ rating: string }>(),
      ]);

      // Guard: if the match advanced past the game we queried for, discard
      const match = this.activeMatches.get(matchId);
      if (
        !match ||
        match.phase !== 'results' ||
        match.currentGame !== gameAtDispatch
      ) {
        return;
      }

      const tally = { likes: 0, dislikes: 0 };
      for (const r of tallyRows.results as Array<{
        rating: string;
        cnt: number;
      }>) {
        if (r.rating === 'like') tally.likes = r.cnt;
        else if (r.rating === 'dislike') tally.dislikes = r.cnt;
      }

      const yourRating =
        playerRow?.rating === 'like' || playerRow?.rating === 'dislike'
          ? playerRow.rating
          : null;

      this._sendTo(accountId, {
        type: 'prompt_rating_tally',
        promptId,
        ...tally,
        yourRating,
      });
    } catch (err) {
      console.warn(
        'Failed to replay prompt rating tally',
        { matchId, promptId, accountId },
        err,
      );
    }
  }
}

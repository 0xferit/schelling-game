import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

const FILL_TIMER_MS = 20_000; // 20 seconds
const MIN_MATCH_SIZE = 3;
const MAX_MATCH_SIZE = 21;
const AI_BOT_TARGET_MATCH_SIZE = 5;
const AI_BOT_ACCOUNT_PREFIX = 'ai-bot:';

function buildAllowedSizes(maxSize: number): number[] {
  const sizes: number[] = [];
  const cappedMax = Math.max(MIN_MATCH_SIZE, Math.min(maxSize, MAX_MATCH_SIZE));
  for (let size = MIN_MATCH_SIZE; size <= cappedMax; size += 1) {
    sizes.push(size);
  }
  return sizes;
}

interface QueueEntry {
  accountId: string;
  displayName: string;
  ws: WebSocket | null;
  joinedAt: number;
  isBot: boolean;
  previousOpponents: Set<string>;
}

interface FormingMatch {
  players: QueueEntry[];
  fillDeadlineMs: number;
  timer: ReturnType<typeof setTimeout>;
}

interface EnqueueInput {
  accountId: string;
  displayName: string;
  ws: WebSocket | null;
  isBot?: boolean;
  previousOpponents?: Set<string>;
}

class MatchmakingQueue {
  waitingQueue: QueueEntry[];
  formingMatch: FormingMatch | null;
  activeMatches: Map<string, unknown>;
  onMatchReady: ((players: QueueEntry[], matchId: string) => void) | null;

  constructor() {
    this.waitingQueue = []; // Array of { accountId, displayName, ws, joinedAt, previousOpponents: Set }
    this.formingMatch = null; // { players: [], timer, fillDeadlineMs, startedForming }
    this.activeMatches = new Map(); // matchId -> Match state (managed by gameManager)
    this.onMatchReady = null; // callback: (players, matchId) => void
  }

  /**
   * Add a player to the queue.
   */
  enqueue(player: EnqueueInput): { success: boolean; error?: string } {
    // Check not already queued
    if (this.isQueued(player.accountId)) {
      return { success: false, error: 'Already queued' };
    }
    // Check not in active match
    if (this.isInActiveMatch(player.accountId)) {
      return { success: false, error: 'In active match' };
    }

    this.waitingQueue.push({
      accountId: player.accountId,
      displayName: player.displayName,
      ws: player.ws,
      joinedAt: Date.now(),
      isBot: Boolean(player.isBot),
      previousOpponents: player.previousOpponents || new Set(),
    });

    this._tryFormMatch();
    return { success: true };
  }

  /**
   * Remove a player from queue or forming match.
   */
  dequeue(accountId: string): void {
    // Remove from waiting queue
    this.waitingQueue = this.waitingQueue.filter(p => p.accountId !== accountId);

    // Remove from forming match
    if (this.formingMatch) {
      const idx = this.formingMatch.players.findIndex(p => p.accountId === accountId);
      if (idx !== -1) {
        this.formingMatch.players.splice(idx, 1);
        // Only cancel once the forming group is empty.
        if (this.formingMatch.players.length === 0) {
          this._cancelForming();
        }
      }
    }
  }

  isQueued(accountId: string): boolean {
    if (this.waitingQueue.some(p => p.accountId === accountId)) return true;
    if (this.formingMatch?.players.some(p => p.accountId === accountId)) return true;
    return false;
  }

  isInActiveMatch(accountId: string): boolean {
    for (const match of this.activeMatches.values()) {
      const players = (match as { players?: QueueEntry[] | Map<string, unknown> }).players;
      if (Array.isArray(players) && players.some(p => p.accountId === accountId)) return true;
      if (players instanceof Map && players.has(accountId)) return true;
    }
    return false;
  }

  /**
   * Get current queue state for broadcasting.
   */
  getQueueState(forAccountId: string | null = null): {
    type: 'queue_state';
    status: 'forming' | 'queued' | 'idle';
    queuedCount: number;
    queuedPlayers: string[];
    formingMatch: {
      playerCount: number;
      players: string[];
      allowedSizes: number[];
      fillDeadlineMs: number;
    } | null;
  } {
    const queuedPlayers = [
      ...(this.formingMatch ? this.formingMatch.players : []),
      ...this.waitingQueue,
    ].map(p => p.displayName);

    return {
      type: 'queue_state',
      status: this.formingMatch?.players.some(p => p.accountId === forAccountId) ? 'forming' :
              this.waitingQueue.some(p => p.accountId === forAccountId) ? 'queued' : 'idle',
      queuedCount: queuedPlayers.length,
      queuedPlayers,
      formingMatch: this.formingMatch ? {
        playerCount: this.formingMatch.players.length,
        players: this.formingMatch.players.map(p => p.displayName),
        allowedSizes: buildAllowedSizes(
          Math.max(
            this.formingMatch.players.length + this.waitingQueue.length,
            AI_BOT_TARGET_MATCH_SIZE,
          ),
        ),
        fillDeadlineMs: this.formingMatch.fillDeadlineMs,
      } : null,
    };
  }

  /**
   * Get all WebSockets for queued players (for broadcasting).
   */
  getAllQueuedWs(): WebSocket[] {
    const wsList: WebSocket[] = [];
    if (this.formingMatch) {
      for (const p of this.formingMatch.players) {
        if (p.ws) wsList.push(p.ws);
      }
    }
    for (const p of this.waitingQueue) {
      if (p.ws) wsList.push(p.ws);
    }
    return wsList;
  }

  /**
   * Register a match as active.
   */
  registerActiveMatch(matchId: string, matchState: unknown): void {
    this.activeMatches.set(matchId, matchState);
  }

  /**
   * Unregister a completed match.
   */
  unregisterActiveMatch(matchId: string): void {
    this.activeMatches.delete(matchId);
  }

  /**
   * Update a player's WebSocket reference (for reconnects).
   */
  updatePlayerWs(accountId: string, ws: WebSocket): void {
    const inQueue = this.waitingQueue.find(p => p.accountId === accountId);
    if (inQueue) inQueue.ws = ws;
    if (this.formingMatch) {
      const inForming = this.formingMatch.players.find(p => p.accountId === accountId);
      if (inForming) inForming.ws = ws;
    }
  }

  // ---- Internal ----

  _tryFormMatch(): void {
    if (this.formingMatch) {
      // Try to add more players to existing forming match
      while (this.waitingQueue.length > 0 && this.formingMatch.players.length < MAX_MATCH_SIZE) {
        const next = this.waitingQueue.shift()!;
        this.formingMatch.players.push(next);
      }
      // If reached 7, start immediately
      if (this.formingMatch.players.length >= MAX_MATCH_SIZE) {
        this._startMatch();
      }
      return;
    }

    if (this.waitingQueue.length === 0) return;

    // Reserve everyone available up to the maximum size. Backfill can
    // later add bots if the human crowd is below the playable threshold.
    const reserveCount = Math.min(this.waitingQueue.length, MAX_MATCH_SIZE);
    const reserved = this.waitingQueue.splice(0, reserveCount);

    this.formingMatch = {
      players: reserved,
      fillDeadlineMs: Date.now() + FILL_TIMER_MS,
      timer: setTimeout(() => this._onFillTimerExpired(), FILL_TIMER_MS),
    };

    // If reached 7, start immediately
    if (this.formingMatch.players.length >= MAX_MATCH_SIZE) {
      this._startMatch();
    }
  }

  _onFillTimerExpired(): void {
    if (!this.formingMatch) return;
    this._startMatch();
  }

  _startMatch(): void {
    if (!this.formingMatch) return;
    clearTimeout(this.formingMatch.timer);

    const matchPlayers = [...this.formingMatch.players];
    this.formingMatch = null;

    while (
      matchPlayers.length < MIN_MATCH_SIZE ||
      matchPlayers.length < AI_BOT_TARGET_MATCH_SIZE
    ) {
      if (matchPlayers.length >= MAX_MATCH_SIZE) break;
      const botIndex = matchPlayers.filter(p => p.isBot).length + 1;
      matchPlayers.push({
        accountId: `${AI_BOT_ACCOUNT_PREFIX}${uuidv4()}`,
        displayName: `Bot ${String(botIndex).padStart(2, '0')}`,
        ws: null,
        joinedAt: Date.now(),
        isBot: true,
        previousOpponents: new Set(),
      });
    }
    if (matchPlayers.length < MIN_MATCH_SIZE) {
      this.waitingQueue.unshift(...matchPlayers.filter(player => !player.isBot));
      this._tryFormMatch();
      return;
    }

    const matchId = `match_${uuidv4()}`;

    if (this.onMatchReady) {
      this.onMatchReady(matchPlayers, matchId);
    }

    // Try to form next match
    this._tryFormMatch();
  }

  _cancelForming(): void {
    if (!this.formingMatch) return;
    clearTimeout(this.formingMatch.timer);
    // Return all to front of queue
    this.waitingQueue.unshift(...this.formingMatch.players);
    this.formingMatch = null;
    // Don't retry forming here since we just lost players
  }
}

// Singleton
const queue = new MatchmakingQueue();
export default queue;
export { MatchmakingQueue, FILL_TIMER_MS, MAX_MATCH_SIZE, MIN_MATCH_SIZE };
export type { QueueEntry, FormingMatch, EnqueueInput };

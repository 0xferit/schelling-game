import { v4 as uuidv4 } from 'uuid';

const FILL_TIMER_MS = 20_000; // 20 seconds
const ALLOWED_SIZES = [3, 5, 7];
const MAX_MATCH_SIZE = 7;

class MatchmakingQueue {
  constructor() {
    this.waitingQueue = []; // Array of { accountId, displayName, ws, joinedAt, previousOpponents: Set }
    this.formingMatch = null; // { players: [], timer, fillDeadlineMs, startedForming }
    this.activeMatches = new Map(); // matchId -> Match state (managed by gameManager)
    this.onMatchReady = null; // callback: (players, matchId) => void
  }

  /**
   * Add a player to the queue.
   * @param {{ accountId, displayName, ws, previousOpponents }} player
   * @returns {{ success, error? }}
   */
  enqueue(player) {
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
      previousOpponents: player.previousOpponents || new Set(),
    });

    this._tryFormMatch();
    return { success: true };
  }

  /**
   * Remove a player from queue or forming match.
   */
  dequeue(accountId) {
    // Remove from waiting queue
    this.waitingQueue = this.waitingQueue.filter(p => p.accountId !== accountId);

    // Remove from forming match
    if (this.formingMatch) {
      const idx = this.formingMatch.players.findIndex(p => p.accountId === accountId);
      if (idx !== -1) {
        this.formingMatch.players.splice(idx, 1);
        // If below 3, cancel forming
        if (this.formingMatch.players.length < 3) {
          this._cancelForming();
        }
      }
    }
  }

  isQueued(accountId) {
    if (this.waitingQueue.some(p => p.accountId === accountId)) return true;
    if (this.formingMatch?.players.some(p => p.accountId === accountId)) return true;
    return false;
  }

  isInActiveMatch(accountId) {
    for (const match of this.activeMatches.values()) {
      if (match.players && match.players.some(p => p.accountId === accountId)) return true;
    }
    return false;
  }

  /**
   * Get current queue state for broadcasting.
   */
  getQueueState(forAccountId = null) {
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
        allowedSizes: ALLOWED_SIZES,
        fillDeadlineMs: this.formingMatch.fillDeadlineMs,
      } : null,
    };
  }

  /**
   * Get all WebSockets for queued players (for broadcasting).
   */
  getAllQueuedWs() {
    const wsList = [];
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
  registerActiveMatch(matchId, matchState) {
    this.activeMatches.set(matchId, matchState);
  }

  /**
   * Unregister a completed match.
   */
  unregisterActiveMatch(matchId) {
    this.activeMatches.delete(matchId);
  }

  /**
   * Update a player's WebSocket reference (for reconnects).
   */
  updatePlayerWs(accountId, ws) {
    const inQueue = this.waitingQueue.find(p => p.accountId === accountId);
    if (inQueue) inQueue.ws = ws;
    if (this.formingMatch) {
      const inForming = this.formingMatch.players.find(p => p.accountId === accountId);
      if (inForming) inForming.ws = ws;
    }
  }

  // ---- Internal ----

  _tryFormMatch() {
    if (this.formingMatch) {
      // Try to add more players to existing forming match
      while (this.waitingQueue.length > 0 && this.formingMatch.players.length < MAX_MATCH_SIZE) {
        const next = this.waitingQueue.shift();
        this.formingMatch.players.push(next);
      }
      // If reached 7, start immediately
      if (this.formingMatch.players.length >= MAX_MATCH_SIZE) {
        this._startMatch();
      }
      return;
    }

    // Need at least 3 to start forming
    if (this.waitingQueue.length < 3) return;

    // Reserve first 3 players
    const reserved = this.waitingQueue.splice(0, 3);

    this.formingMatch = {
      players: reserved,
      fillDeadlineMs: Date.now() + FILL_TIMER_MS,
      timer: setTimeout(() => this._onFillTimerExpired(), FILL_TIMER_MS),
    };

    // Try to add more
    while (this.waitingQueue.length > 0 && this.formingMatch.players.length < MAX_MATCH_SIZE) {
      const next = this.waitingQueue.shift();
      this.formingMatch.players.push(next);
    }

    // If reached 7, start immediately
    if (this.formingMatch.players.length >= MAX_MATCH_SIZE) {
      this._startMatch();
    }
  }

  _onFillTimerExpired() {
    if (!this.formingMatch) return;
    this._startMatch();
  }

  _startMatch() {
    if (!this.formingMatch) return;
    clearTimeout(this.formingMatch.timer);

    const reserved = this.formingMatch.players;
    // Find largest odd size <= reserved.length
    let matchSize = 3;
    for (const size of [7, 5, 3]) {
      if (reserved.length >= size) {
        matchSize = size;
        break;
      }
    }

    // Take matchSize players, push extras back to front of queue
    const matchPlayers = reserved.slice(0, matchSize);
    const extras = reserved.slice(matchSize);

    // Return extras to front of queue in their existing order
    this.waitingQueue.unshift(...extras);

    this.formingMatch = null;

    const matchId = `match_${uuidv4()}`;

    if (this.onMatchReady) {
      this.onMatchReady(matchPlayers, matchId);
    }

    // Try to form next match
    this._tryFormMatch();
  }

  _cancelForming() {
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
export { MatchmakingQueue, FILL_TIMER_MS, ALLOWED_SIZES, MAX_MATCH_SIZE };

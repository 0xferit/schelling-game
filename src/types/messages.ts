import type { GameResultWithBalances, SchellingPrompt } from './domain';

// ── Client → Server ──────────────────────────────────────────────

export type ClientMessage =
  | { type: 'join_queue' }
  | { type: 'leave_queue' }
  | { type: 'forfeit_match' }
  | { type: 'set_start_now'; value: boolean }
  | { type: 'commit'; hash: string }
  | { type: 'reveal'; optionIndex: number; salt: string }
  | { type: 'reveal'; answerText: string; salt: string }
  | { type: 'prompt_rating'; rating: 'like' | 'dislike' };

// ── Server → Client ──────────────────────────────────────────────

export interface QueueStateMessage {
  type: 'queue_state';
  status: 'queued' | 'forming' | 'idle';
  queuedCount: number;
  queuedPlayers: string[];
  startNow?: boolean;
  formingMatch: {
    playerCount: number;
    humanPlayerCount: number;
    readyHumanCount: number;
    players: string[];
    allowedSizes: number[];
    fillDeadlineMs: number | null;
    youCanVoteStartNow: boolean;
  } | null;
}

export interface MatchStartedMessage {
  type: 'match_started';
  matchId: string;
  gameCount: number;
  aiAssisted: boolean;
  players: {
    displayName: string;
    startingBalance: number;
    currentBalance?: number;
  }[];
}

export interface GameStartedMessage {
  type: 'game_started';
  game: number;
  prompt: SchellingPrompt;
  commitDuration: number;
  gameAnte: number;
  aiAssisted: boolean;
  phase: 'commit' | 'reveal' | 'normalizing' | 'results';
  /** Sent on reconnect: whether this player already committed this game */
  yourCommitted?: boolean;
  /** Sent on reconnect: whether this player already revealed this game */
  yourRevealed?: boolean;
}

export interface RevealPhaseChangeMessage {
  type: 'phase_change';
  phase: 'reveal';
  revealDuration: number;
}

export interface NormalizingPhaseChangeMessage {
  type: 'phase_change';
  phase: 'normalizing';
  status: string;
}

export type PhaseChangeMessage =
  | RevealPhaseChangeMessage
  | NormalizingPhaseChangeMessage;

export interface CommitStatusMessage {
  type: 'commit_status';
  committed: { displayName: string; hasCommitted: boolean }[];
}

export interface RevealStatusMessage {
  type: 'reveal_status';
  revealed: { displayName: string; hasRevealed: boolean }[];
}

export interface GameResultMessage {
  type: 'game_result';
  resultsDuration: number;
  result: GameResultWithBalances;
}

export interface MatchOverMessage {
  type: 'match_over';
  aiAssisted: boolean;
  summary: {
    players: {
      displayName: string;
      startingBalance: number;
      endingBalance: number;
      netDelta: number;
      result: 'completed' | 'forfeited';
    }[];
  };
}

export interface PlayerDisconnectedMessage {
  type: 'player_disconnected';
  displayName: string;
  graceSeconds: number;
}

export interface PlayerForfeitedMessage {
  type: 'player_forfeited';
  displayName: string;
  futureGamesPenaltyApplied: boolean;
}

export interface PlayerReconnectedMessage {
  type: 'player_reconnected';
  displayName: string;
}

export interface PromptRatingTallyMessage {
  type: 'prompt_rating_tally';
  promptId: number;
  likes: number;
  dislikes: number;
  /** Present on reconnect replay: the reconnecting player's own rating for this prompt. */
  yourRating?: 'like' | 'dislike' | null;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | QueueStateMessage
  | MatchStartedMessage
  | GameStartedMessage
  | PhaseChangeMessage
  | CommitStatusMessage
  | RevealStatusMessage
  | GameResultMessage
  | MatchOverMessage
  | PlayerDisconnectedMessage
  | PlayerForfeitedMessage
  | PlayerReconnectedMessage
  | PromptRatingTallyMessage
  | ErrorMessage;

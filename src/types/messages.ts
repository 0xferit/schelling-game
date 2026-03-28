import type { Question, RoundResultWithBalances } from './domain';

// ── Client → Server ──────────────────────────────────────────────

export type ClientMessage =
  | { type: 'join_queue' }
  | { type: 'leave_queue' }
  | { type: 'commit'; hash: string }
  | { type: 'reveal'; optionIndex: number; salt: string }
  | { type: 'question_rating'; rating: 'like' | 'dislike' };

// ── Server → Client ──────────────────────────────────────────────

export interface QueueStateMessage {
  type: 'queue_state';
  status: 'queued' | 'forming' | 'idle';
  queuedCount: number;
  queuedPlayers: string[];
  autoRequeue?: boolean;
  formingMatch: {
    playerCount: number;
    players: string[];
    allowedSizes: number[];
    fillDeadlineMs: number;
  } | null;
}

export interface GameStartedMessage {
  type: 'game_started';
  matchId: string;
  roundCount: number;
  players: {
    displayName: string;
    startingBalance: number;
    currentBalance?: number;
  }[];
}

export interface RoundStartMessage {
  type: 'round_start';
  round: number;
  question: Question;
  commitDuration: number;
  roundAnte: number;
  phase: 'commit' | 'reveal' | 'results';
  /** Sent on reconnect: whether this player already committed this round */
  yourCommitted?: boolean;
  /** Sent on reconnect: whether this player already revealed this round */
  yourRevealed?: boolean;
}

export interface PhaseChangeMessage {
  type: 'phase_change';
  phase: 'reveal';
  revealDuration: number;
}

export interface CommitStatusMessage {
  type: 'commit_status';
  committed: { displayName: string; hasCommitted: boolean }[];
}

export interface RevealStatusMessage {
  type: 'reveal_status';
  revealed: { displayName: string; hasRevealed: boolean }[];
}

export interface RoundResultMessage {
  type: 'round_result';
  resultsDuration: number;
  result: RoundResultWithBalances;
}

export interface GameOverMessage {
  type: 'game_over';
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
  futureRoundsPenaltyApplied: boolean;
}

export interface PlayerReconnectedMessage {
  type: 'player_reconnected';
  displayName: string;
}

export interface QuestionRatingTallyMessage {
  type: 'question_rating_tally';
  questionId: number;
  likes: number;
  dislikes: number;
  /** Present on reconnect replay: the reconnecting player's own rating for this question. */
  yourRating?: 'like' | 'dislike' | null;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | QueueStateMessage
  | GameStartedMessage
  | RoundStartMessage
  | PhaseChangeMessage
  | CommitStatusMessage
  | RevealStatusMessage
  | RoundResultMessage
  | GameOverMessage
  | PlayerDisconnectedMessage
  | PlayerForfeitedMessage
  | PlayerReconnectedMessage
  | QuestionRatingTallyMessage
  | ErrorMessage;

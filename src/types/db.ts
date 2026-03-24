export interface AccountRow {
  account_id: string;
  display_name: string | null;
  token_balance: number;
  leaderboard_eligible: number; // 0 | 1
  created_at: string;
}

export interface PlayerStatsRow {
  account_id: string;
  games_played: number;
  rounds_played: number;
  coherent_rounds: number;
  current_streak: number;
  longest_streak: number;
}

export interface AccountWithStats extends AccountRow {
  games_played: number;
  rounds_played: number;
  coherent_rounds: number;
  current_streak: number;
  longest_streak: number;
}

export interface AuthChallengeRow {
  challenge_id: string;
  wallet_address: string;
  message: string;
  nonce: string;
  expires_at: string;
  used: number; // 0 | 1
}

export interface MatchRow {
  match_id: string;
  started_at: string;
  ended_at: string | null;
  round_count: number;
  player_count: number;
  status: 'active' | 'completed';
}

export interface MatchPlayerRow {
  match_id: string;
  account_id: string;
  display_name_snapshot: string;
  starting_balance: number;
  ending_balance: number | null;
  net_delta: number | null;
  result: 'active' | 'completed' | 'forfeited';
}

export interface VoteLogRow {
  id: number;
  match_id: string;
  round_number: number;
  question_id: number;
  account_id: string;
  display_name_snapshot: string;
  revealed_option_index: number | null;
  revealed_option_label: string | null;
  won_round: number; // 0 | 1
  earns_coordination_credit: number; // 0 | 1
  ante_amount: number;
  round_payout: number;
  net_delta: number;
  player_count: number;
  valid_reveal_count: number | null;
  top_count: number | null;
  winner_count: number | null;
  winning_option_indexes_json: string | null;
  voided: number; // 0 | 1
  void_reason: string | null;
  timestamp: string;
}

export interface QuestionRatingRow {
  id: number;
  question_id: number;
  account_id: string;
  match_id: string;
  round_number: number;
  rating: 'like' | 'dislike';
  created_at: string;
}

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  tokenBalance: number;
  leaderboardEligible: number;
  gamesPlayed: number;
  roundsPlayed: number;
  coherentRounds: number;
  coherentPct: number;
  currentStreak: number;
  longestStreak: number;
  avgNetTokensPerGame: number;
}

export interface PlayerRankEntry extends LeaderboardEntry {
  account_id: string;
}

// ── Input param types ────────────────────────────────────────────

export interface CreateChallengeParams {
  challengeId: string;
  walletAddress: string;
  message: string;
  nonce: string;
  expiresAt: string;
}

export interface CreateMatchParams {
  matchId: string;
  playerCount: number;
}

export interface AddMatchPlayerParams {
  matchId: string;
  accountId: string;
  displayNameSnapshot: string;
  startingBalance: number;
}

export interface UpdateMatchPlayerParams {
  matchId: string;
  accountId: string;
  endingBalance: number;
  netDelta: number;
  result: string;
}

export interface VoteLogEntry {
  matchId: string;
  roundNumber: number;
  questionId: number;
  accountId: string;
  displayNameSnapshot: string;
  revealedOptionIndex: number | null;
  revealedOptionLabel: string | null;
  wonRound: boolean;
  earnsCoordinationCredit: boolean;
  anteAmount?: number;
  roundPayout?: number;
  netDelta?: number;
  playerCount: number;
  validRevealCount?: number | null;
  topCount?: number | null;
  winnerCount?: number | null;
  winningOptionIndexesJson?: string | null;
  voided: boolean;
  voidReason?: string | null;
}

export interface UpdatePlayerStatsParams {
  roundsPlayed?: number;
  coherentRounds?: number;
  isGameEnd: boolean;
  wonRound: boolean;
  earnsCoordinationCredit: boolean;
}

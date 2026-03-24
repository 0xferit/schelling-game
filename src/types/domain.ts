export type QuestionCategory =
  | 'number'
  | 'lifestyle'
  | 'culture'
  | 'psychology'
  | 'fantasy'
  | 'philosophy'
  | 'aesthetics';

export interface Question {
  id: number;
  text: string;
  type: 'select';
  category: QuestionCategory;
  options: string[];
}

export type GamePhase = 'commit' | 'reveal' | 'results';

export interface PlayerSettlementInput {
  accountId: string;
  displayName: string;
  optionIndex: number | null;
  validReveal: boolean;
  forfeited: boolean;
  attached: boolean;
}

export interface PlayerResult {
  accountId: string;
  displayName: string;
  revealedOptionIndex: number | null;
  revealedOptionLabel: string | null;
  wonRound: boolean;
  earnsCoordinationCredit: boolean;
  antePaid: number;
  roundPayout: number;
  netDelta: number;
}

export interface RoundResult {
  voided: boolean;
  voidReason: string | null;
  playerCount: number;
  pot: number;
  validRevealCount: number;
  topCount: number;
  winningOptionIndexes: number[];
  winnerCount: number;
  payoutPerWinner: number;
  players: PlayerResult[];
}

export interface RoundResultWithNum extends RoundResult {
  roundNum: number;
}

export interface PlayerResultWithBalance extends PlayerResult {
  newBalance: number;
}

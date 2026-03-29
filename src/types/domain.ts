export type PromptCategory =
  | 'number'
  | 'lifestyle'
  | 'culture'
  | 'psychology'
  | 'fantasy'
  | 'philosophy'
  | 'aesthetics';

export interface SchellingPrompt {
  id: number;
  text: string;
  type: 'select';
  category: PromptCategory;
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
  wonGame: boolean;
  earnsCoordinationCredit: boolean;
  antePaid: number;
  gamePayout: number;
  netDelta: number;
}

export interface GameResult {
  voided: boolean;
  voidReason: string | null;
  playerCount: number;
  pot: number;
  dustBurned: number;
  validRevealCount: number;
  topCount: number;
  winningOptionIndexes: number[];
  winnerCount: number;
  payoutPerWinner: number;
  players: PlayerResult[];
}

export interface GameResultWithNum extends GameResult {
  gameNum: number;
}

export interface PlayerResultWithBalance extends PlayerResult {
  newBalance: number;
}

export interface GameResultWithBalances
  extends Omit<GameResultWithNum, 'players'> {
  players: PlayerResultWithBalance[];
}

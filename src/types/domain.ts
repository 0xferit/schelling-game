export type PromptCategory =
  | 'number'
  | 'lifestyle'
  | 'culture'
  | 'psychology'
  | 'fantasy'
  | 'philosophy'
  | 'aesthetics';

interface BasePrompt {
  id: number;
  text: string;
  category: PromptCategory;
}

export interface IntegerRangeAnswerSpec {
  kind: 'integer_range';
  min: number;
  max: number;
  allowWords: boolean;
  allowCurrency?: boolean;
}

export interface PlayingCardAnswerSpec {
  kind: 'playing_card';
}

export interface FreeTextAnswerSpec {
  kind: 'free_text';
}

export interface SingleWordAnswerSpec {
  kind: 'single_word';
}

export type OpenTextAnswerSpec =
  | IntegerRangeAnswerSpec
  | PlayingCardAnswerSpec
  | FreeTextAnswerSpec
  | SingleWordAnswerSpec;

export interface SelectPrompt extends BasePrompt {
  type: 'select';
  options: string[];
}

export interface OpenTextPrompt extends BasePrompt {
  type: 'open_text';
  maxLength: number;
  placeholder: string;
  answerSpec: OpenTextAnswerSpec;
  aiNormalization: 'required';
  canonicalExamples?: string[];
}

export type SchellingPrompt = SelectPrompt | OpenTextPrompt;

export type GamePhase = 'commit' | 'reveal' | 'normalizing' | 'results';
export type NormalizationMode = 'llm' | null;

export interface PlayerSettlementInput {
  accountId: string;
  displayName: string;
  optionIndex: number | null;
  inputText: string | null;
  normalizedRevealText: string | null;
  bucketKey: string | null;
  bucketLabel: string | null;
  validReveal: boolean;
  forfeited: boolean;
  attached: boolean;
}

export interface PlayerResult {
  accountId: string;
  displayName: string;
  revealedOptionIndex: number | null;
  revealedOptionLabel: string | null;
  revealedInputText: string | null;
  revealedBucketKey: string | null;
  revealedBucketLabel: string | null;
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
  winningBucketKeys: string[];
  winnerCount: number;
  payoutPerWinner: number;
  normalizationMode: NormalizationMode;
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

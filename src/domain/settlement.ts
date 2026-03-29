import type {
  GameResult,
  PlayerResult,
  PlayerSettlementInput,
  SchellingPrompt,
} from '../types/domain';
import { GAME_ANTE } from './constants';

type ValidRevealInput = PlayerSettlementInput & {
  bucketKey: string;
  bucketLabel: string;
  validReveal: true;
};

export function settleGame(
  players: PlayerSettlementInput[],
  prompt: SchellingPrompt,
  normalizationMode: GameResult['normalizationMode'] = null,
): GameResult {
  const attached = players.filter((p) => p.attached);
  const gamePlayerCount = attached.length;
  const pot = gamePlayerCount * GAME_ANTE;

  const validReveals = players.filter(
    (p): p is ValidRevealInput =>
      p.validReveal && p.bucketKey !== null && p.bucketLabel !== null,
  );
  const validRevealCount = validReveals.length;

  if (validRevealCount === 0) {
    return buildVoidResult(players, gamePlayerCount, 'zero_valid_reveals');
  }

  const bucketCounts = new Map<string, number>();
  for (const player of validReveals) {
    bucketCounts.set(
      player.bucketKey,
      (bucketCounts.get(player.bucketKey) || 0) + 1,
    );
  }

  const topCount = Math.max(...bucketCounts.values());
  const winningBucketKeys = [...bucketCounts.entries()]
    .filter(([, count]) => count === topCount)
    .map(([bucketKey]) => bucketKey)
    .sort();

  const winnerSet = new Set<string>();
  for (const player of validReveals) {
    if (winningBucketKeys.includes(player.bucketKey)) {
      winnerSet.add(player.accountId);
    }
  }

  const winnerCount = winnerSet.size;
  const payoutPerWinner = Math.floor(pot / winnerCount);
  const dustBurned = pot % winnerCount;
  const bucketLabels = new Map(
    validReveals.map((player) => [player.bucketKey, player.bucketLabel]),
  );

  const winningOptionIndexes =
    prompt.type === 'select'
      ? winningBucketKeys
          .map((bucketKey) => {
            const optionLabel = bucketLabels.get(bucketKey);
            return optionLabel ? prompt.options.indexOf(optionLabel) : -1;
          })
          .filter((optionIndex) => optionIndex >= 0)
          .sort((a, b) => a - b)
      : [];

  const playerResults: PlayerResult[] = attached.map((player) => {
    const wonGame =
      player.bucketKey !== null && winnerSet.has(player.accountId);
    const earnsCoordinationCredit = wonGame && topCount >= 2;
    const antePaid = GAME_ANTE;
    const gamePayout = wonGame ? payoutPerWinner : 0;
    const netDelta = gamePayout - antePaid;

    return {
      accountId: player.accountId,
      displayName: player.displayName,
      revealedOptionIndex: player.validReveal ? player.optionIndex : null,
      revealedOptionLabel:
        player.validReveal &&
        player.optionIndex !== null &&
        prompt.type === 'select'
          ? prompt.options[player.optionIndex] || null
          : null,
      revealedInputText: player.validReveal ? player.inputText : null,
      revealedBucketKey: player.validReveal ? player.bucketKey : null,
      revealedBucketLabel: player.validReveal ? player.bucketLabel : null,
      wonGame,
      earnsCoordinationCredit,
      antePaid,
      gamePayout,
      netDelta,
    };
  });

  return {
    voided: false,
    voidReason: null,
    playerCount: gamePlayerCount,
    pot,
    dustBurned,
    validRevealCount,
    topCount,
    winningOptionIndexes,
    winningBucketKeys,
    winnerCount,
    payoutPerWinner,
    normalizationMode,
    players: playerResults,
  };
}

function buildVoidResult(
  players: PlayerSettlementInput[],
  gamePlayerCount: number,
  reason: string,
): GameResult {
  const playerResults: PlayerResult[] = players
    .filter((player) => player.attached)
    .map((player) => ({
      accountId: player.accountId,
      displayName: player.displayName,
      revealedOptionIndex: null,
      revealedOptionLabel: null,
      revealedInputText: null,
      revealedBucketKey: null,
      revealedBucketLabel: null,
      wonGame: false,
      earnsCoordinationCredit: false,
      antePaid: 0,
      gamePayout: 0,
      netDelta: 0,
    }));

  return {
    voided: true,
    voidReason: reason,
    playerCount: gamePlayerCount,
    pot: 0,
    dustBurned: 0,
    validRevealCount: 0,
    topCount: 0,
    winningOptionIndexes: [],
    winningBucketKeys: [],
    winnerCount: 0,
    payoutPerWinner: 0,
    normalizationMode: null,
    players: playerResults,
  };
}

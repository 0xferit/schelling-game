import type {
  GameResult,
  PlayerResult,
  PlayerSettlementInput,
  Question,
} from '../types/domain';
import { GAME_ANTE } from './constants';

type ValidRevealInput = PlayerSettlementInput & {
  optionIndex: number;
  validReveal: true;
};

export function settleGame(
  players: PlayerSettlementInput[],
  question: Question,
): GameResult {
  const attached = players.filter((p) => p.attached);
  const gamePlayerCount = attached.length;
  const pot = gamePlayerCount * GAME_ANTE;

  // Collect valid reveals
  const validReveals = players.filter(
    (p): p is ValidRevealInput => p.validReveal && p.optionIndex !== null,
  );
  const validRevealCount = validReveals.length;

  // Zero valid reveals: void
  if (validRevealCount === 0) {
    return buildVoidResult(players, gamePlayerCount, 'zero_valid_reveals');
  }

  // Count votes per option
  const optionCounts = new Map<number, number>();
  for (const p of validReveals) {
    optionCounts.set(p.optionIndex, (optionCounts.get(p.optionIndex) || 0) + 1);
  }

  // Find topCount and winning options
  const topCount = Math.max(...optionCounts.values());
  const winningOptionIndexes: number[] = [];
  for (const [idx, count] of optionCounts) {
    if (count === topCount) winningOptionIndexes.push(idx);
  }
  winningOptionIndexes.sort((a, b) => a - b);

  // Determine winners
  const winnerSet = new Set<string>();
  for (const p of validReveals) {
    if (winningOptionIndexes.includes(p.optionIndex)) {
      winnerSet.add(p.accountId);
    }
  }
  const winnerCount = winnerSet.size;
  const payoutPerWinner = Math.floor(pot / winnerCount);

  // Build player results
  const playerResults: PlayerResult[] = attached.map((p) => {
    const wonGame = winnerSet.has(p.accountId);
    const earnsCoordinationCredit = wonGame && topCount >= 2;
    const antePaid = GAME_ANTE;
    const gamePayout = wonGame ? payoutPerWinner : 0;
    const netDelta = gamePayout - antePaid;

    return {
      accountId: p.accountId,
      displayName: p.displayName,
      revealedOptionIndex: p.validReveal ? p.optionIndex : null,
      revealedOptionLabel:
        p.validReveal && p.optionIndex != null
          ? question.options[p.optionIndex] || null
          : null,
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
    validRevealCount,
    topCount,
    winningOptionIndexes,
    winnerCount,
    payoutPerWinner,
    players: playerResults,
  };
}

function buildVoidResult(
  players: PlayerSettlementInput[],
  gamePlayerCount: number,
  reason: string,
): GameResult {
  const playerResults: PlayerResult[] = players
    .filter((p) => p.attached)
    .map((p) => ({
      accountId: p.accountId,
      displayName: p.displayName,
      revealedOptionIndex: null,
      revealedOptionLabel: null,
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
    validRevealCount: 0,
    topCount: 0,
    winningOptionIndexes: [],
    winnerCount: 0,
    payoutPerWinner: 0,
    players: playerResults,
  };
}

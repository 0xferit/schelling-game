import type {
  PlayerResult,
  PlayerSettlementInput,
  Question,
  RoundResult,
} from '../types/domain';

const ROUND_ANTE = 60;

export function settleRound(
  players: PlayerSettlementInput[],
  question: Question,
): RoundResult {
  const attached = players.filter((p) => p.attached);
  const roundPlayerCount = attached.length;
  const pot = roundPlayerCount * ROUND_ANTE;

  // Collect valid reveals
  const validReveals = players.filter((p) => p.validReveal);
  const validRevealCount = validReveals.length;

  // Zero valid reveals: void
  if (validRevealCount === 0) {
    return buildVoidResult(players, roundPlayerCount, 'zero_valid_reveals');
  }

  // Count votes per option
  const optionCounts = new Map<number, number>();
  for (const p of validReveals) {
    optionCounts.set(
      p.optionIndex!,
      (optionCounts.get(p.optionIndex!) || 0) + 1,
    );
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
    if (winningOptionIndexes.includes(p.optionIndex!)) {
      winnerSet.add(p.accountId);
    }
  }
  const winnerCount = winnerSet.size;
  const payoutPerWinner = Math.floor(pot / winnerCount);

  // Build player results
  const playerResults: PlayerResult[] = attached.map((p) => {
    const wonRound = winnerSet.has(p.accountId);
    const earnsCoordinationCredit = wonRound && topCount >= 2;
    const antePaid = ROUND_ANTE;
    const roundPayout = wonRound ? payoutPerWinner : 0;
    const netDelta = roundPayout - antePaid;

    return {
      accountId: p.accountId,
      displayName: p.displayName,
      revealedOptionIndex: p.validReveal ? p.optionIndex : null,
      revealedOptionLabel:
        p.validReveal && p.optionIndex != null
          ? question.options[p.optionIndex] || null
          : null,
      wonRound,
      earnsCoordinationCredit,
      antePaid,
      roundPayout,
      netDelta,
    };
  });

  return {
    voided: false,
    voidReason: null,
    playerCount: roundPlayerCount,
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
  roundPlayerCount: number,
  reason: string,
): RoundResult {
  const playerResults: PlayerResult[] = players
    .filter((p) => p.attached)
    .map((p) => ({
      accountId: p.accountId,
      displayName: p.displayName,
      revealedOptionIndex: null,
      revealedOptionLabel: null,
      wonRound: false,
      earnsCoordinationCredit: false,
      antePaid: 0,
      roundPayout: 0,
      netDelta: 0,
    }));

  return {
    voided: true,
    voidReason: reason,
    playerCount: roundPlayerCount,
    pot: 0,
    validRevealCount: 0,
    topCount: 0,
    winningOptionIndexes: [],
    winnerCount: 0,
    payoutPerWinner: 0,
    players: playerResults,
  };
}

export { ROUND_ANTE };

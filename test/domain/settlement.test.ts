import { describe, expect, it } from 'vitest';
import {
  MIN_ESTABLISHED_MATCHES,
  ROUND_ANTE,
} from '../../src/domain/constants';
import { settleRound } from '../../src/domain/settlement';
import type { PlayerSettlementInput, Question } from '../../src/types/domain';

function must<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

const question: Question = {
  id: 1,
  text: 'Test',
  type: 'select',
  category: 'number',
  options: ['A', 'B', 'C', 'D'],
};

function makePlayer(
  id: string,
  name: string,
  optionIndex: number | null,
  validReveal = true,
  forfeited = false,
  attached = true,
): PlayerSettlementInput {
  return {
    accountId: id,
    displayName: name,
    optionIndex,
    validReveal,
    forfeited,
    attached,
  };
}

describe('plurality settlement: basic cases', () => {
  it('3 players all pick same option', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 0),
      makePlayer('a3', 'Carol', 0),
    ];
    const result = settleRound(players, question);

    expect(result.voided).toBe(false);
    expect(result.pot).toBe(180);
    expect(result.winnerCount).toBe(3);
    expect(result.payoutPerWinner).toBe(60);
    expect(result.players.every((p) => p.netDelta === 0)).toBe(true);
    expect(result.players.every((p) => p.earnsCoordinationCredit)).toBe(true);
  });

  it('3 players: 2-1 split', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 0),
      makePlayer('a3', 'Carol', 1),
    ];
    const result = settleRound(players, question);

    expect(result.voided).toBe(false);
    expect(result.topCount).toBe(2);
    expect(result.winnerCount).toBe(2);
    expect(result.payoutPerWinner).toBe(90);

    const carol = must(
      result.players.find((p) => p.accountId === 'a3'),
      'Expected Carol in round result',
    );
    expect(carol.wonRound).toBe(false);
    expect(carol.netDelta).toBe(-60);
    expect(carol.earnsCoordinationCredit).toBe(false);
  });

  it('5 players: 3-1-1 split', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 0),
      makePlayer('a3', 'Carol', 0),
      makePlayer('a4', 'Dave', 1),
      makePlayer('a5', 'Eve', 2),
    ];
    const result = settleRound(players, question);

    expect(result.topCount).toBe(3);
    expect(result.winnerCount).toBe(3);
    expect(result.pot).toBe(300);
    expect(result.payoutPerWinner).toBe(100);

    const losers = result.players.filter((p) => !p.wonRound);
    expect(losers).toHaveLength(2);
    expect(losers.every((p) => p.netDelta === -60)).toBe(true);
  });

  it('7 players: 4-2-1 split', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 0),
      makePlayer('a3', 'Carol', 0),
      makePlayer('a4', 'Dave', 0),
      makePlayer('a5', 'Eve', 1),
      makePlayer('a6', 'Frank', 1),
      makePlayer('a7', 'Grace', 2),
    ];
    const result = settleRound(players, question);

    expect(result.topCount).toBe(4);
    expect(result.winnerCount).toBe(4);
    expect(result.pot).toBe(420);
    expect(result.payoutPerWinner).toBe(105);
  });
});

describe('single valid revealer', () => {
  it('sole revealer takes the whole pot', () => {
    const players = [
      makePlayer('a1', 'Alice', 0, true),
      makePlayer('a2', 'Bob', null, false),
      makePlayer('a3', 'Carol', null, false),
    ];
    const result = settleRound(players, question);

    expect(result.voided).toBe(false);
    expect(result.validRevealCount).toBe(1);
    expect(result.winnerCount).toBe(1);
    expect(result.pot).toBe(180);
    expect(result.payoutPerWinner).toBe(180);

    const alice = must(
      result.players.find((p) => p.accountId === 'a1'),
      'Expected Alice in round result',
    );
    expect(alice.netDelta).toBe(120);
    expect(alice.earnsCoordinationCredit).toBe(false);
  });
});

describe('zero valid reveals = void', () => {
  it('voids the round with zero reveals', () => {
    const players = [
      makePlayer('a1', 'Alice', null, false),
      makePlayer('a2', 'Bob', null, false),
      makePlayer('a3', 'Carol', null, false),
    ];
    const result = settleRound(players, question);

    expect(result.voided).toBe(true);
    expect(result.voidReason).toBe('zero_valid_reveals');
    expect(result.players.every((p) => p.antePaid === 0)).toBe(true);
    expect(result.players.every((p) => p.netDelta === 0)).toBe(true);
    expect(result.players.every((p) => !p.earnsCoordinationCredit)).toBe(true);
  });
});

describe('tied pluralities', () => {
  it('5 players: 2-2-1 tie', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 0),
      makePlayer('a3', 'Carol', 1),
      makePlayer('a4', 'Dave', 1),
      makePlayer('a5', 'Eve', 2),
    ];
    const result = settleRound(players, question);

    expect(result.topCount).toBe(2);
    expect(result.winningOptionIndexes).toHaveLength(2);
    expect(result.winnerCount).toBe(4);
    expect(result.pot).toBe(300);
    expect(result.payoutPerWinner).toBe(75);

    const winners = result.players.filter((p) => p.wonRound);
    expect(winners).toHaveLength(4);
    expect(winners.every((p) => p.earnsCoordinationCredit)).toBe(true);

    const eve = must(
      result.players.find((p) => p.accountId === 'a5'),
      'Expected Eve in round result',
    );
    expect(eve.wonRound).toBe(false);
    expect(eve.earnsCoordinationCredit).toBe(false);
  });
});

describe('all distinct (topCount=1)', () => {
  it('everyone wins but no coordination credit', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 1),
      makePlayer('a3', 'Carol', 2),
    ];
    const result = settleRound(players, question);

    expect(result.topCount).toBe(1);
    expect(result.winnerCount).toBe(3);
    expect(result.winningOptionIndexes).toHaveLength(3);
    expect(result.players.every((p) => p.wonRound)).toBe(true);
    expect(result.players.every((p) => !p.earnsCoordinationCredit)).toBe(true);
  });
});

describe('pot math', () => {
  it.each([
    { playerCount: 3, expectedPot: 180 },
    { playerCount: 5, expectedPot: 300 },
    { playerCount: 7, expectedPot: 420 },
  ])('$playerCount players: pot = $expectedPot', ({
    playerCount,
    expectedPot,
  }) => {
    const players = Array.from({ length: playerCount }, (_, i) =>
      makePlayer(`a${i + 1}`, String.fromCharCode(65 + i), 0),
    );
    const result = settleRound(players, question);

    expect(result.pot).toBe(playerCount * ROUND_ANTE);
    expect(result.pot).toBe(expectedPot);
  });

  it('integer division floor: 7 players, 3 winners → floor(420/3) = 140', () => {
    const players = [
      makePlayer('a1', 'A', 0),
      makePlayer('a2', 'B', 0),
      makePlayer('a3', 'C', 0),
      makePlayer('a4', 'D', 1),
      makePlayer('a5', 'E', 1),
      makePlayer('a6', 'F', 2),
      makePlayer('a7', 'G', 3),
    ];
    const result = settleRound(players, question);
    expect(result.payoutPerWinner).toBe(Math.floor(420 / 3));
  });

  it('odd-size floor: 11 players, 7 winners → floor(660/7) = 94', () => {
    const players = [
      makePlayer('a1', 'A', 0),
      makePlayer('a2', 'B', 0),
      makePlayer('a3', 'C', 0),
      makePlayer('a4', 'D', 0),
      makePlayer('a5', 'E', 0),
      makePlayer('a6', 'F', 0),
      makePlayer('a7', 'G', 0),
      makePlayer('a8', 'H', 1),
      makePlayer('a9', 'I', 1),
      makePlayer('a10', 'J', 2),
      makePlayer('a11', 'K', 3),
    ];
    const result = settleRound(players, question);
    const winners = result.players.filter((p) => p.wonRound);

    expect(result.pot).toBe(660);
    expect(result.winnerCount).toBe(7);
    expect(result.payoutPerWinner).toBe(Math.floor(660 / 7));
    expect(winners.every((p) => p.netDelta === 34)).toBe(true);
  });
});

describe('forfeited player handling', () => {
  it('forfeited player pays ante but does not win', () => {
    const players: PlayerSettlementInput[] = [
      makePlayer('a1', 'Alice', 0, true, false),
      makePlayer('a2', 'Bob', 0, true, false),
      {
        accountId: 'a3',
        displayName: 'Carol',
        optionIndex: null,
        validReveal: false,
        forfeited: true,
        attached: true,
      },
    ];
    const result = settleRound(players, question);

    expect(result.voided).toBe(false);
    expect(result.pot).toBe(180);
    expect(result.validRevealCount).toBe(2);

    const carol = must(
      result.players.find((p) => p.accountId === 'a3'),
      'Expected Carol in round result',
    );
    expect(carol.wonRound).toBe(false);
    expect(carol.netDelta).toBe(-60);
  });

  it('detached (prior-round forfeit) player is excluded from pot', () => {
    const players: PlayerSettlementInput[] = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 0),
      makePlayer('a3', 'Carol', null, false, true, false),
    ];
    const result = settleRound(players, question);

    expect(result.playerCount).toBe(2);
    expect(result.pot).toBe(120);
    expect(result.players.find((p) => p.accountId === 'a3')).toBeUndefined();
    expect(result.winnerCount).toBe(2);
    expect(result.payoutPerWinner).toBe(60);
  });
});

describe('coordination credit rules', () => {
  it('topCount >= 2: winners earn credit, losers do not', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 0),
      makePlayer('a3', 'Carol', 1),
    ];
    const result = settleRound(players, question);
    const winners = result.players.filter((p) => p.wonRound);
    const losers = result.players.filter((p) => !p.wonRound);

    expect(result.topCount).toBeGreaterThanOrEqual(2);
    expect(winners.every((p) => p.earnsCoordinationCredit)).toBe(true);
    expect(losers.every((p) => !p.earnsCoordinationCredit)).toBe(true);
  });

  it('single revealer (topCount=1): no coordination credit', () => {
    const players = [
      makePlayer('a1', 'Alice', 0, true),
      makePlayer('a2', 'Bob', null, false),
      makePlayer('a3', 'Carol', null, false),
    ];
    const result = settleRound(players, question);

    expect(result.topCount).toBe(1);
    const alice = must(
      result.players.find((p) => p.accountId === 'a1'),
      'Expected Alice in round result',
    );
    expect(alice.earnsCoordinationCredit).toBe(false);
  });

  it('all distinct (topCount=1): no coordination credit', () => {
    const players = [
      makePlayer('a1', 'Alice', 0),
      makePlayer('a2', 'Bob', 1),
      makePlayer('a3', 'Carol', 2),
    ];
    const result = settleRound(players, question);

    expect(result.topCount).toBe(1);
    expect(result.players.every((p) => !p.earnsCoordinationCredit)).toBe(true);
  });

  it('voided round: no coordination credit', () => {
    const players = [
      makePlayer('a1', 'Alice', null, false),
      makePlayer('a2', 'Bob', null, false),
    ];
    const result = settleRound(players, question);

    expect(result.voided).toBe(true);
    expect(result.players.every((p) => !p.earnsCoordinationCredit)).toBe(true);
  });
});

describe('provisional leaderboard threshold', () => {
  it('threshold is 5 matches', () => {
    expect(MIN_ESTABLISHED_MATCHES).toBe(5);
  });

  it.each([
    { gamesPlayed: 0, provisional: true },
    { gamesPlayed: 4, provisional: true },
    { gamesPlayed: 5, provisional: false },
    { gamesPlayed: 10, provisional: false },
  ])('gamesPlayed=$gamesPlayed is provisional=$provisional', ({
    gamesPlayed,
    provisional,
  }) => {
    expect(gamesPlayed < MIN_ESTABLISHED_MATCHES).toBe(provisional);
  });
});

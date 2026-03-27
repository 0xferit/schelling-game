import { readFileSync } from 'node:fs';
import {
  createCommitHash,
  validateHash,
  validateOptionIndex,
  validateSalt,
  verifyCommit,
} from '../src/domain/commitReveal';
import { MIN_ESTABLISHED_MATCHES } from '../src/domain/constants';
import {
  getPublicPool,
  selectQuestionsForMatch,
  validatePool,
} from '../src/domain/questions';
import { ROUND_ANTE, settleRound } from '../src/domain/settlement';
import type { PlayerSettlementInput, Question } from '../src/types/domain';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  + ${label}`);
    passed++;
  } else {
    console.error(`  x ${label}`);
    failed++;
  }
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
): PlayerSettlementInput {
  return {
    accountId: id,
    displayName: name,
    optionIndex,
    validReveal,
    forfeited,
    attached: true,
  };
}

// ---------------------------------------------------------------------------
// 1. Commit-Reveal Verification
// ---------------------------------------------------------------------------
console.log('\n1. Commit-Reveal Verification');

{
  const optionIndex = 2;
  const salt = 'a'.repeat(32);
  const hash = createCommitHash(optionIndex, salt);

  assert(
    verifyCommit(optionIndex, salt, hash),
    'Valid commit verifies correctly',
  );
  assert(!verifyCommit(1, salt, hash), 'Wrong optionIndex rejected');
  assert(
    !verifyCommit(optionIndex, 'b'.repeat(32), hash),
    'Wrong salt rejected',
  );
  assert(
    !verifyCommit(optionIndex, salt, 'f'.repeat(64)),
    'Wrong hash rejected',
  );
}

{
  assert(!validateSalt('abcd'), 'Salt too short (< 32 hex chars) rejected');
  assert(!validateSalt('z'.repeat(32)), 'Non-hex salt rejected');
  assert(validateSalt('a'.repeat(32)), 'Valid salt (32 hex chars) accepted');
  assert(
    validateSalt('abcdef0123456789'.repeat(3)),
    'Valid salt (48 hex chars) accepted',
  );
  assert(validateSalt('a'.repeat(128)), 'Salt at max length (128) accepted');
  assert(!validateSalt('a'.repeat(129)), 'Salt just over max (129) rejected');
  assert(
    !validateSalt('a'.repeat(10000)),
    'Very long salt (10000 chars) rejected',
  );
}

{
  assert(validateHash('a'.repeat(64)), 'Valid hash (64 hex chars) accepted');
  assert(!validateHash('a'.repeat(63)), 'Hash too short rejected');
  assert(!validateHash('a'.repeat(65)), 'Hash too long rejected');
  assert(!validateHash('g'.repeat(64)), 'Non-hex hash rejected');
  assert(!validateHash(123), 'Non-string hash rejected');
}

{
  assert(validateOptionIndex(0, 4), 'Option index 0 valid for 4 options');
  assert(validateOptionIndex(3, 4), 'Option index 3 valid for 4 options');
  assert(
    !validateOptionIndex(4, 4),
    'Option index 4 out of range for 4 options',
  );
  assert(!validateOptionIndex(-1, 4), 'Negative option index rejected');
  assert(!validateOptionIndex(1.5, 4), 'Non-integer option index rejected');
  assert(!validateOptionIndex(NaN, 4), 'NaN option index rejected');
}

// ---------------------------------------------------------------------------
// 2. Question Pool
// ---------------------------------------------------------------------------
console.log('\n2. Question Pool');

{
  const pool = getPublicPool();
  assert(pool.length > 0, 'Pool is non-empty');
  assert(
    pool.every((q) => q.type === 'select'),
    'All questions are select type',
  );
  assert(
    pool.every((q) => Array.isArray(q.options) && q.options.length > 0),
    'All questions have non-empty options array',
  );
  assert(validatePool(), 'validatePool returns true');
}

{
  const selected = selectQuestionsForMatch(5);
  assert(
    selected.length === 5,
    'selectQuestionsForMatch returns correct count',
  );

  const ids = selected.map((q) => q.id);
  const uniqueIds = new Set(ids);
  assert(uniqueIds.size === 5, 'Selected questions are unique (no duplicates)');
}

{
  const pool = getPublicPool();
  let threw = false;
  try {
    selectQuestionsForMatch(pool.length + 1);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, 'Requesting more than pool size throws RangeError');
}

// ---------------------------------------------------------------------------
// 3. Plurality Settlement: Basic Cases
// ---------------------------------------------------------------------------
console.log('\n3. Plurality Settlement: Basic Cases');

// 3a. 3 players all pick same option
{
  const players = [
    makePlayer('a1', 'Alice', 0),
    makePlayer('a2', 'Bob', 0),
    makePlayer('a3', 'Carol', 0),
  ];
  const result = settleRound(players, question);

  assert(!result.voided, '3 same picks: round not voided');
  assert(result.pot === 180, '3 same picks: pot = 180');
  assert(result.winnerCount === 3, '3 same picks: all 3 win');
  assert(result.payoutPerWinner === 60, '3 same picks: payout = 60 each');
  assert(
    result.players.every((p) => p.netDelta === 0),
    '3 same picks: net delta = 0 each',
  );
  assert(
    result.players.every((p) => p.earnsCoordinationCredit),
    '3 same picks: all earn coordination credit',
  );
}

// 3b. 3 players: 2 pick A, 1 picks B
{
  const players = [
    makePlayer('a1', 'Alice', 0),
    makePlayer('a2', 'Bob', 0),
    makePlayer('a3', 'Carol', 1),
  ];
  const result = settleRound(players, question);

  assert(!result.voided, '2-1 split: round not voided');
  assert(result.topCount === 2, '2-1 split: topCount = 2');
  assert(result.winnerCount === 2, '2-1 split: 2 winners');
  assert(result.payoutPerWinner === 90, '2-1 split: payout = 90 each');

  const carol = result.players.find((p) => p.accountId === 'a3');
  assert(
    carol !== undefined && !carol.wonRound,
    '2-1 split: loser did not win',
  );
  assert(
    carol !== undefined && carol.netDelta === -60,
    '2-1 split: loser net delta = -60',
  );
  assert(
    carol !== undefined && !carol.earnsCoordinationCredit,
    '2-1 split: loser no coordination credit',
  );
}

// 3c. 5 players: 3-1-1 split
{
  const players = [
    makePlayer('a1', 'Alice', 0),
    makePlayer('a2', 'Bob', 0),
    makePlayer('a3', 'Carol', 0),
    makePlayer('a4', 'Dave', 1),
    makePlayer('a5', 'Eve', 2),
  ];
  const result = settleRound(players, question);

  assert(result.topCount === 3, '3-1-1 split: topCount = 3');
  assert(result.winnerCount === 3, '3-1-1 split: 3 winners');
  assert(result.pot === 300, '3-1-1 split: pot = 300');
  assert(result.payoutPerWinner === 100, '3-1-1 split: payout = 100 each');

  const losers = result.players.filter((p) => !p.wonRound);
  assert(losers.length === 2, '3-1-1 split: 2 losers');
  assert(
    losers.every((p) => p.netDelta === -60),
    '3-1-1 split: losers net delta = -60',
  );
}

// 3d. 7 players: 4-2-1 split
{
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

  assert(result.topCount === 4, '4-2-1 split: topCount = 4');
  assert(result.winnerCount === 4, '4-2-1 split: 4 winners');
  assert(result.pot === 420, '4-2-1 split: pot = 420');
  assert(result.payoutPerWinner === 105, '4-2-1 split: payout = 105 each');
}

// ---------------------------------------------------------------------------
// 4. Single Valid Revealer
// ---------------------------------------------------------------------------
console.log('\n4. Single Valid Revealer');

{
  const players = [
    makePlayer('a1', 'Alice', 0, true),
    makePlayer('a2', 'Bob', null, false),
    makePlayer('a3', 'Carol', null, false),
  ];
  const result = settleRound(players, question);

  assert(!result.voided, 'Single revealer: round not voided');
  assert(
    result.validRevealCount === 1,
    'Single revealer: validRevealCount = 1',
  );
  assert(result.winnerCount === 1, 'Single revealer: 1 winner');
  assert(result.pot === 180, 'Single revealer: pot = 180');
  assert(
    result.payoutPerWinner === 180,
    'Single revealer: winner takes whole pot',
  );

  const alice = result.players.find((p) => p.accountId === 'a1');
  assert(
    alice !== undefined && alice.netDelta === 120,
    'Single revealer: winner net = 180 - 60 = 120',
  );
  assert(
    alice !== undefined && !alice.earnsCoordinationCredit,
    'Single revealer: topCount=1 so no coordination credit',
  );
}

// ---------------------------------------------------------------------------
// 5. Zero Valid Reveals = Void
// ---------------------------------------------------------------------------
console.log('\n5. Zero Valid Reveals = Void');

{
  const players = [
    makePlayer('a1', 'Alice', null, false),
    makePlayer('a2', 'Bob', null, false),
    makePlayer('a3', 'Carol', null, false),
  ];
  const result = settleRound(players, question);

  assert(result.voided === true, 'Zero reveals: voided = true');
  assert(
    result.voidReason === 'zero_valid_reveals',
    'Zero reveals: correct void reason',
  );
  assert(
    result.players.every((p) => p.antePaid === 0),
    'Zero reveals: no ante charged',
  );
  assert(
    result.players.every((p) => p.netDelta === 0),
    'Zero reveals: all net delta = 0',
  );
  assert(
    result.players.every((p) => !p.earnsCoordinationCredit),
    'Zero reveals: no coordination credit',
  );
}

// ---------------------------------------------------------------------------
// 6. Tied Pluralities
// ---------------------------------------------------------------------------
console.log('\n6. Tied Pluralities');

{
  // 5 players: 2-2-1 split (options 0 and 1 tied at 2 each)
  const players = [
    makePlayer('a1', 'Alice', 0),
    makePlayer('a2', 'Bob', 0),
    makePlayer('a3', 'Carol', 1),
    makePlayer('a4', 'Dave', 1),
    makePlayer('a5', 'Eve', 2),
  ];
  const result = settleRound(players, question);

  assert(result.topCount === 2, '2-2-1 tie: topCount = 2');
  assert(
    result.winningOptionIndexes.length === 2,
    '2-2-1 tie: 2 winning option indexes',
  );
  assert(
    result.winnerCount === 4,
    '2-2-1 tie: 4 winners (2 from each tied option)',
  );
  assert(result.pot === 300, '2-2-1 tie: pot = 300');
  assert(
    result.payoutPerWinner === 75,
    '2-2-1 tie: payout = floor(300/4) = 75',
  );

  const winners = result.players.filter((p) => p.wonRound);
  assert(winners.length === 4, '2-2-1 tie: 4 players won');
  assert(
    winners.every((p) => p.earnsCoordinationCredit),
    '2-2-1 tie: winners earn coordination credit (topCount >= 2)',
  );

  const eve = result.players.find((p) => p.accountId === 'a5');
  assert(eve !== undefined && !eve.wonRound, '2-2-1 tie: minority picker lost');
  assert(
    eve !== undefined && !eve.earnsCoordinationCredit,
    '2-2-1 tie: loser no coordination credit',
  );
}

// ---------------------------------------------------------------------------
// 7. All Distinct (topCount=1)
// ---------------------------------------------------------------------------
console.log('\n7. All Distinct (topCount=1)');

{
  const players = [
    makePlayer('a1', 'Alice', 0),
    makePlayer('a2', 'Bob', 1),
    makePlayer('a3', 'Carol', 2),
  ];
  const result = settleRound(players, question);

  assert(result.topCount === 1, 'All distinct: topCount = 1');
  assert(result.winnerCount === 3, 'All distinct: all 3 win (tied at 1 each)');
  assert(
    result.winningOptionIndexes.length === 3,
    'All distinct: 3 winning option indexes',
  );
  assert(
    result.players.every((p) => p.wonRound),
    'All distinct: everyone wins',
  );
  assert(
    result.players.every((p) => !p.earnsCoordinationCredit),
    'All distinct: topCount=1 so no coordination credit',
  );
}

// ---------------------------------------------------------------------------
// 8. Pot Math Verification
// ---------------------------------------------------------------------------
console.log('\n8. Pot Math Verification');

{
  // 3 players
  const p3 = [
    makePlayer('a1', 'A', 0),
    makePlayer('a2', 'B', 0),
    makePlayer('a3', 'C', 0),
  ];
  const r3 = settleRound(p3, question);
  assert(r3.pot === 3 * ROUND_ANTE, `3 players: pot = ${3 * ROUND_ANTE}`);
  assert(r3.pot === 180, '3 players: pot = 180');
}

{
  // 5 players
  const p5 = [
    makePlayer('a1', 'A', 0),
    makePlayer('a2', 'B', 0),
    makePlayer('a3', 'C', 0),
    makePlayer('a4', 'D', 0),
    makePlayer('a5', 'E', 0),
  ];
  const r5 = settleRound(p5, question);
  assert(r5.pot === 300, '5 players: pot = 300');
}

{
  // 7 players
  const p7 = [
    makePlayer('a1', 'A', 0),
    makePlayer('a2', 'B', 0),
    makePlayer('a3', 'C', 0),
    makePlayer('a4', 'D', 0),
    makePlayer('a5', 'E', 0),
    makePlayer('a6', 'F', 0),
    makePlayer('a7', 'G', 0),
  ];
  const r7 = settleRound(p7, question);
  assert(r7.pot === 420, '7 players: pot = 420');
}

{
  // Integer division floor check: 7 players, 3 winners => floor(420/3) = 140
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
  assert(
    result.payoutPerWinner === Math.floor(420 / 3),
    'Integer division floor: floor(420/3) = 140',
  );
}

{
  // Arbitrary odd-size floor check: 11 players, 7 winners => floor(660/7) = 94
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

  assert(result.pot === 660, '11 players: pot = 660');
  assert(result.winnerCount === 7, '11 players: 7 winners');
  assert(
    result.payoutPerWinner === Math.floor(660 / 7),
    'Odd-size floor: floor(660/7) = 94',
  );
  assert(
    winners.every((p) => p.netDelta === 34),
    'Odd-size floor: winners net +34 each',
  );
}

// ---------------------------------------------------------------------------
// 9. Forfeited Player Handling
// ---------------------------------------------------------------------------
console.log('\n9. Forfeited Player Handling');

{
  // Forfeited player: attached but validReveal = false
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

  assert(!result.voided, 'Forfeited player: round not voided');
  assert(
    result.pot === 180,
    'Forfeited player: pot includes forfeited player ante',
  );
  assert(
    result.validRevealCount === 2,
    'Forfeited player: only 2 valid reveals',
  );

  const carol = result.players.find((p) => p.accountId === 'a3');
  assert(
    carol !== undefined && !carol.wonRound,
    'Forfeited player did not win',
  );
  assert(
    carol !== undefined && carol.netDelta === -60,
    'Forfeited player loses ante',
  );
}

// ---------------------------------------------------------------------------
// 10. Coordination Credit Rules
// ---------------------------------------------------------------------------
console.log('\n10. Coordination Credit Rules');

// topCount >= 2: winners earn coordination credit
{
  const players = [
    makePlayer('a1', 'Alice', 0),
    makePlayer('a2', 'Bob', 0),
    makePlayer('a3', 'Carol', 1),
  ];
  const result = settleRound(players, question);
  const winners = result.players.filter((p) => p.wonRound);
  const losers = result.players.filter((p) => !p.wonRound);

  assert(result.topCount >= 2, 'topCount >= 2 case confirmed');
  assert(
    winners.every((p) => p.earnsCoordinationCredit),
    'topCount >= 2: winners earn coordination credit',
  );
  assert(
    losers.every((p) => !p.earnsCoordinationCredit),
    'Losers never earn coordination credit',
  );
}

// topCount = 1 with single revealer: no coordination credit
{
  const players = [
    makePlayer('a1', 'Alice', 0, true),
    makePlayer('a2', 'Bob', null, false),
    makePlayer('a3', 'Carol', null, false),
  ];
  const result = settleRound(players, question);

  assert(result.topCount === 1, 'Single revealer: topCount = 1');
  const alice = result.players.find((p) => p.accountId === 'a1');
  assert(
    alice !== undefined && !alice.earnsCoordinationCredit,
    'Single revealer: no coordination credit',
  );
}

// topCount = 1 with all distinct: no coordination credit
{
  const players = [
    makePlayer('a1', 'Alice', 0),
    makePlayer('a2', 'Bob', 1),
    makePlayer('a3', 'Carol', 2),
  ];
  const result = settleRound(players, question);

  assert(result.topCount === 1, 'All distinct: topCount = 1');
  assert(
    result.players.every((p) => !p.earnsCoordinationCredit),
    'All distinct: no coordination credit for anyone',
  );
}

// Voided round: no coordination credit
{
  const players = [
    makePlayer('a1', 'Alice', null, false),
    makePlayer('a2', 'Bob', null, false),
  ];
  const result = settleRound(players, question);

  assert(result.voided, 'Voided round confirmed');
  assert(
    result.players.every((p) => !p.earnsCoordinationCredit),
    'Voided round: no coordination credit for anyone',
  );
}

// ---------------------------------------------------------------------------
// 11. Provisional leaderboard threshold
// ---------------------------------------------------------------------------
{
  console.log('\n11. Provisional leaderboard threshold');

  assert(MIN_ESTABLISHED_MATCHES === 5, 'threshold is 5 matches');
  assert(4 < MIN_ESTABLISHED_MATCHES, 'gamesPlayed=4 is provisional');
  assert(!(5 < MIN_ESTABLISHED_MATCHES), 'gamesPlayed=5 is not provisional');
  assert(!(10 < MIN_ESTABLISHED_MATCHES), 'gamesPlayed=10 is not provisional');
  assert(0 < MIN_ESTABLISHED_MATCHES, 'gamesPlayed=0 is provisional');
}

// ---------------------------------------------------------------------------
// 12. Feedback entry points
// ---------------------------------------------------------------------------
{
  console.log('\n12. Feedback entry points');

  const landingHtml = readFileSync(
    new URL('../public/index.html', import.meta.url),
    'utf8',
  );
  const appHtml = readFileSync(
    new URL('../public/app.html', import.meta.url),
    'utf8',
  );
  const feedbackTemplate = readFileSync(
    new URL('../.github/ISSUE_TEMPLATE/feedback.md', import.meta.url),
    'utf8',
  );

  assert(
    landingHtml.includes('issues/new?template=feedback.md'),
    'Landing page exposes the feedback issue link',
  );
  assert(
    appHtml.includes('issues/new?template=feedback.md'),
    'App shell exposes the feedback issue link',
  );
  assert(
    feedbackTemplate.includes('name: Feedback'),
    'Feedback issue template is present',
  );
  assert(
    feedbackTemplate.includes('- feedback'),
    'Feedback issue template defaults the feedback label',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

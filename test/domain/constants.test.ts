import { describe, expect, it } from 'vitest';
import {
  clampTokenBalance,
  GAME_ANTE,
  MATCH_GAME_COUNT,
  MIN_ALLOWED_BALANCE,
} from '../../src/domain/constants';

describe('domain constants', () => {
  it('derives the minimum allowed balance from match size and ante', () => {
    expect(MIN_ALLOWED_BALANCE).toBe(-MATCH_GAME_COUNT * GAME_ANTE);
  });

  it('clamps balances at the allowed floor', () => {
    expect(clampTokenBalance(MIN_ALLOWED_BALANCE - GAME_ANTE)).toBe(
      MIN_ALLOWED_BALANCE,
    );
    expect(clampTokenBalance(MIN_ALLOWED_BALANCE)).toBe(MIN_ALLOWED_BALANCE);
    expect(clampTokenBalance(0)).toBe(0);
  });
});

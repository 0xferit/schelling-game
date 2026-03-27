import { describe, expect, it } from 'vitest';
import {
  getPublicPool,
  selectQuestionsForMatch,
  validatePool,
} from '../../src/domain/questions';

describe('question pool', () => {
  const pool = getPublicPool();

  it('is non-empty', () => {
    expect(pool.length).toBeGreaterThan(0);
  });

  it('contains only select-type questions', () => {
    expect(pool.every((q) => q.type === 'select')).toBe(true);
  });

  it('every question has a non-empty options array', () => {
    expect(
      pool.every((q) => Array.isArray(q.options) && q.options.length > 0),
    ).toBe(true);
  });

  it('passes validatePool', () => {
    expect(validatePool()).toBe(true);
  });
});

describe('selectQuestionsForMatch', () => {
  it('returns the requested count', () => {
    const selected = selectQuestionsForMatch(5);
    expect(selected).toHaveLength(5);
  });

  it('returns unique questions (no duplicates)', () => {
    const selected = selectQuestionsForMatch(5);
    const ids = selected.map((q) => q.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('throws RangeError when requesting more than pool size', () => {
    const pool = getPublicPool();
    expect(() => selectQuestionsForMatch(pool.length + 1)).toThrow(RangeError);
  });
});

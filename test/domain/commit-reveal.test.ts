import { describe, expect, it } from 'vitest';
import {
  createCommitHash,
  createOpenTextCommitHash,
  normalizeRevealText,
  validateAnswerText,
  validateHash,
  validateOptionIndex,
  validateSalt,
  verifyCommit,
  verifyOpenTextCommit,
} from '../../src/domain/commitReveal';

describe('commit-reveal verification', () => {
  const optionIndex = 2;
  const salt = 'a'.repeat(32);
  const hash = createCommitHash(optionIndex, salt);

  it('verifies a valid commit', () => {
    expect(verifyCommit(optionIndex, salt, hash)).toBe(true);
  });

  it('rejects wrong optionIndex', () => {
    expect(verifyCommit(1, salt, hash)).toBe(false);
  });

  it('rejects wrong salt', () => {
    expect(verifyCommit(optionIndex, 'b'.repeat(32), hash)).toBe(false);
  });

  it('rejects wrong hash', () => {
    expect(verifyCommit(optionIndex, salt, 'f'.repeat(64))).toBe(false);
  });
});

describe('validateSalt', () => {
  it.each([
    { input: 'abcd', expected: false, label: 'too short (< 32 hex chars)' },
    { input: 'z'.repeat(32), expected: false, label: 'non-hex characters' },
    { input: 'a'.repeat(32), expected: true, label: '32 hex chars' },
    {
      input: 'abcdef0123456789'.repeat(3),
      expected: true,
      label: '48 hex chars',
    },
    { input: 'a'.repeat(128), expected: true, label: 'at max length (128)' },
    {
      input: 'a'.repeat(129),
      expected: false,
      label: 'just over max (129)',
    },
    {
      input: 'a'.repeat(10000),
      expected: false,
      label: 'very long (10000 chars)',
    },
  ])('$label → $expected', ({ input, expected }) => {
    expect(validateSalt(input)).toBe(expected);
  });
});

describe('validateHash', () => {
  it.each([
    { input: 'a'.repeat(64), expected: true, label: 'valid 64 hex chars' },
    { input: 'a'.repeat(63), expected: false, label: 'too short' },
    { input: 'a'.repeat(65), expected: false, label: 'too long' },
    { input: 'g'.repeat(64), expected: false, label: 'non-hex characters' },
    { input: 123, expected: false, label: 'non-string value' },
  ])('$label → $expected', ({ input, expected }) => {
    expect(validateHash(input)).toBe(expected);
  });
});

describe('validateOptionIndex', () => {
  const optionCount = 4;

  it.each([
    { index: 0, expected: true, label: 'index 0 valid' },
    { index: 3, expected: true, label: 'index 3 valid (last)' },
    { index: 4, expected: false, label: 'index 4 out of range' },
    { index: -1, expected: false, label: 'negative index' },
    { index: 1.5, expected: false, label: 'non-integer' },
    { index: NaN, expected: false, label: 'NaN' },
  ])('$label → $expected', ({ index, expected }) => {
    expect(validateOptionIndex(index, optionCount)).toBe(expected);
  });
});

describe('open-text commit-reveal verification', () => {
  const salt = 'b'.repeat(32);
  const answerText = ' New York ';
  const hash = createOpenTextCommitHash(answerText, salt);

  it('normalizes casing and whitespace before hashing', () => {
    expect(verifyOpenTextCommit('new york', salt, hash)).toBe(true);
  });

  it('rejects a different normalized answer', () => {
    expect(verifyOpenTextCommit('new york city', salt, hash)).toBe(false);
  });

  it('normalizes quotes and terminal punctuation', () => {
    expect(normalizeRevealText('“Grand Central.”')).toBe('"grand central"');
  });
});

describe('validateAnswerText', () => {
  it('accepts a valid single-line answer', () => {
    expect(validateAnswerText('Grand Central', 80)).toBe(true);
  });

  it('rejects empty answers after normalization', () => {
    expect(validateAnswerText('   ...   ', 80)).toBe(false);
  });

  it('rejects multiline answers', () => {
    expect(validateAnswerText('Grand\nCentral', 80)).toBe(false);
  });

  it('rejects answers longer than the prompt limit', () => {
    expect(validateAnswerText('a'.repeat(81), 80)).toBe(false);
  });
});

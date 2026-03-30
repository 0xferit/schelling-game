import { describe, expect, it } from 'vitest';
import {
  createCommitHash,
  createOpenTextCommitHash,
  validateAnswerText,
  validateHash,
  validateOptionIndex,
  validateSalt,
  verifyCommit,
  verifyOpenTextCommit,
} from '../../src/domain/commitReveal';
import {
  canonicalizeOpenTextAnswer,
  normalizeRevealText,
} from '../../src/domain/openText';
import type { OpenTextPrompt } from '../../src/types/domain';

const numberPrompt: OpenTextPrompt = {
  id: 1002,
  text: 'Pick a number between 1 and 10.',
  type: 'open_text',
  category: 'number',
  maxLength: 16,
  placeholder: 'e.g. 7',
  answerSpec: { kind: 'integer_range', min: 1, max: 10, allowWords: true },
  aiNormalization: 'required',
  canonicalExamples: ['7', 'seven'],
};

const splitPrompt: OpenTextPrompt = {
  id: 1007,
  text: 'Split $100 with a stranger. How much do you keep?',
  type: 'open_text',
  category: 'philosophy',
  maxLength: 24,
  placeholder: 'e.g. 50',
  answerSpec: {
    kind: 'integer_range',
    min: 0,
    max: 100,
    allowWords: true,
    allowCurrency: true,
  },
  aiNormalization: 'required',
  canonicalExamples: ['$50', '50', 'fifty'],
};

const cardPrompt: OpenTextPrompt = {
  id: 1006,
  text: 'Pick a playing card.',
  type: 'open_text',
  category: 'culture',
  maxLength: 24,
  placeholder: 'e.g. Ace of Spades',
  answerSpec: { kind: 'playing_card' },
  aiNormalization: 'required',
  canonicalExamples: ['Ace of Spades', 'A♠', 'AS'],
};

const wordPrompt: OpenTextPrompt = {
  id: 1010,
  text: 'Pick a word.',
  type: 'open_text',
  category: 'psychology',
  maxLength: 32,
  placeholder: 'e.g. love',
  answerSpec: { kind: 'single_word' },
  aiNormalization: 'required',
  canonicalExamples: ['love'],
};

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
  ])('$label → $expected', ({ index, expected }) => {
    expect(validateOptionIndex(index, optionCount)).toBe(expected);
  });
});

describe('open-text canonicalization', () => {
  it('normalizes casing and whitespace for transport', () => {
    expect(normalizeRevealText(' New York ')).toBe('new york');
  });

  it('canonicalizes numeric word forms to digits', () => {
    expect(
      canonicalizeOpenTextAnswer('seven', numberPrompt)?.canonicalCommitText,
    ).toBe('7');
  });

  it('canonicalizes currency and word forms for fair-split amounts', () => {
    expect(
      canonicalizeOpenTextAnswer('$50', splitPrompt)?.canonicalCommitText,
    ).toBe('50');
    expect(
      canonicalizeOpenTextAnswer('fifty', splitPrompt)?.canonicalCommitText,
    ).toBe('50');
    expect(
      canonicalizeOpenTextAnswer('$50', splitPrompt)?.bucketLabelCandidate,
    ).toBe('$50');
  });

  it('canonicalizes playing-card abbreviations and suit symbols', () => {
    expect(
      canonicalizeOpenTextAnswer('AS', cardPrompt)?.canonicalCommitText,
    ).toBe('Ace of Spades');
    expect(
      canonicalizeOpenTextAnswer('A♠', cardPrompt)?.canonicalCommitText,
    ).toBe('Ace of Spades');
  });

  it('rejects out-of-range integers', () => {
    expect(canonicalizeOpenTextAnswer('11', numberPrompt)).toBeNull();
    expect(canonicalizeOpenTextAnswer('101', splitPrompt)).toBeNull();
  });

  it('rejects multi-word answers for single-word prompts', () => {
    expect(canonicalizeOpenTextAnswer('hello world', wordPrompt)).toBeNull();
  });
});

describe('open-text commit-reveal verification', () => {
  const salt = 'b'.repeat(32);
  const hash = createOpenTextCommitHash('seven', salt, numberPrompt);

  it('uses prompt-aware canonicalization before hashing', () => {
    expect(verifyOpenTextCommit('7', salt, hash, numberPrompt)).toBe(true);
  });

  it('rejects a different canonical answer', () => {
    expect(verifyOpenTextCommit('8', salt, hash, numberPrompt)).toBe(false);
  });

  it('verifies playing-card aliases against the same commitment', () => {
    const cardHash = createOpenTextCommitHash(
      'Ace of Spades',
      salt,
      cardPrompt,
    );
    expect(verifyOpenTextCommit('A♠', salt, cardHash, cardPrompt)).toBe(true);
    expect(verifyOpenTextCommit('AS', salt, cardHash, cardPrompt)).toBe(true);
  });
});

describe('validateAnswerText', () => {
  it('accepts valid structured answers', () => {
    expect(validateAnswerText('Grand Central', 80)).toBe(true);
    expect(validateAnswerText('seven', numberPrompt)).toBe(true);
    expect(validateAnswerText('A♠', cardPrompt)).toBe(true);
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

  it('rejects structured answers that do not match the prompt', () => {
    expect(validateAnswerText('11', numberPrompt)).toBe(false);
    expect(validateAnswerText('101', splitPrompt)).toBe(false);
    expect(validateAnswerText('two words', wordPrompt)).toBe(false);
  });
});

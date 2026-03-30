import crypto from 'node:crypto';
import type { OpenTextPrompt } from '../types/domain';
import {
  canonicalizeOpenTextAnswer,
  normalizeRevealText,
  validateOpenTextAnswer,
} from './openText';

const MIN_SALT_LENGTH = 32;
const MAX_SALT_LENGTH = 128;

function buildCommitPreimage(value: string | number, salt: string): string {
  return `${value}:${salt}`;
}

export function createCommitHash(value: string | number, salt: string): string {
  return crypto
    .createHash('sha256')
    .update(buildCommitPreimage(value, salt))
    .digest('hex');
}

export function verifyCommit(
  value: string | number,
  salt: string,
  hash: string,
): boolean {
  return createCommitHash(value, salt) === hash;
}

export function createOpenTextCommitHash(
  answerText: string,
  salt: string,
  prompt: OpenTextPrompt,
): string {
  const canonical = canonicalizeOpenTextAnswer(answerText, prompt);
  if (!canonical) {
    throw new RangeError(
      'Open-text answer does not satisfy prompt constraints',
    );
  }
  return createCommitHash(canonical.canonicalCommitText, salt);
}

export function verifyOpenTextCommit(
  answerText: string,
  salt: string,
  hash: string,
  prompt: OpenTextPrompt,
): boolean {
  const canonical = canonicalizeOpenTextAnswer(answerText, prompt);
  if (!canonical) return false;
  return createCommitHash(canonical.canonicalCommitText, salt) === hash;
}

export function validateSalt(salt: unknown): salt is string {
  if (typeof salt !== 'string') return false;
  if (salt.length < MIN_SALT_LENGTH) return false;
  if (salt.length > MAX_SALT_LENGTH) return false;
  return /^[0-9a-f]+$/i.test(salt);
}

export function validateHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
}

export function validateOptionIndex(
  optionIndex: unknown,
  optionCount: number,
): optionIndex is number {
  return (
    Number.isInteger(optionIndex) &&
    (optionIndex as number) >= 0 &&
    (optionIndex as number) < optionCount
  );
}

export function validateAnswerText(
  answerText: unknown,
  maxLengthOrPrompt: number | OpenTextPrompt,
): answerText is string {
  if (typeof maxLengthOrPrompt === 'number') {
    if (typeof answerText !== 'string') return false;
    if (
      answerText.length === 0 ||
      answerText.length > maxLengthOrPrompt ||
      /[\r\n]/.test(answerText)
    ) {
      return false;
    }
    return normalizeRevealText(answerText).length > 0;
  }

  return validateOpenTextAnswer(answerText, maxLengthOrPrompt);
}

import crypto from 'node:crypto';

const MIN_SALT_LENGTH = 32;
const MAX_SALT_LENGTH = 128;
const TERMINAL_PUNCTUATION_RE = /[.!?,;:]+(?=(?:['"])?$)/;

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

export function normalizeRevealText(answerText: string): string {
  return answerText
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u2032`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(TERMINAL_PUNCTUATION_RE, '')
    .trim();
}

export function createOpenTextCommitHash(
  answerText: string,
  salt: string,
): string {
  return createCommitHash(normalizeRevealText(answerText), salt);
}

export function verifyOpenTextCommit(
  answerText: string,
  salt: string,
  hash: string,
): boolean {
  return createOpenTextCommitHash(answerText, salt) === hash;
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
  maxLength: number,
): answerText is string {
  if (typeof answerText !== 'string') return false;
  if (answerText.length === 0 || answerText.length > maxLength) return false;
  if (/[\r\n]/.test(answerText)) return false;
  return normalizeRevealText(answerText).length > 0;
}

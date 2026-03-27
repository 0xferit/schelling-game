import crypto from 'node:crypto';

// Preimage format: "${optionIndex}:${salt}"
// Hash: SHA-256 hex digest

export function createCommitHash(optionIndex: number, salt: string): string {
  const preimage = `${optionIndex}:${salt}`;
  return crypto.createHash('sha256').update(preimage).digest('hex');
}

export function verifyCommit(
  optionIndex: number,
  salt: string,
  hash: string,
): boolean {
  return createCommitHash(optionIndex, salt) === hash;
}

// Validate salt: must be hex string, 32–128 chars (128–512 bits)
const MAX_SALT_LENGTH = 128;

export function validateSalt(salt: unknown): salt is string {
  if (typeof salt !== 'string') return false;
  if (salt.length < 32) return false;
  if (salt.length > MAX_SALT_LENGTH) return false;
  return /^[0-9a-f]+$/i.test(salt);
}

// Validate commit hash format
export function validateHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
}

// Validate optionIndex: must be non-negative integer within option count
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

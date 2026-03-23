import crypto from 'node:crypto';

// Preimage format: "${optionIndex}:${salt}"
// Hash: SHA-256 hex digest

export function createCommitHash(optionIndex, salt) {
  const preimage = `${optionIndex}:${salt}`;
  return crypto.createHash('sha256').update(preimage).digest('hex');
}

export function verifyCommit(optionIndex, salt, hash) {
  return createCommitHash(optionIndex, salt) === hash;
}

// Validate salt: must be hex string, at least 32 chars (128 bits)
export function validateSalt(salt) {
  if (typeof salt !== 'string') return false;
  if (salt.length < 32) return false;
  return /^[0-9a-f]+$/i.test(salt);
}

// Validate commit hash format
export function validateHash(hash) {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
}

// Validate optionIndex: must be non-negative integer within option count
export function validateOptionIndex(optionIndex, optionCount) {
  return Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < optionCount;
}

import { ethers } from 'ethers';
import crypto from 'node:crypto';
import db from './db.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const sessions = new Map(); // sessionToken -> { accountId, createdAt }

/**
 * Create an auth challenge for a wallet address.
 * @param {string} walletAddress - Ethereum address (0x...)
 * @returns {{ challengeId, message, expiresAt }}
 */
export function createChallenge(walletAddress) {
  // Normalize to checksum address
  const normalized = ethers.getAddress(walletAddress);
  const nonce = crypto.randomBytes(32).toString('hex');
  const challengeId = `ch_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const message = `Sign this message to authenticate with Schelling Game.\n\nWallet: ${normalized}\nNonce: ${nonce}\nExpires: ${expiresAt}`;

  db.createChallenge({ challengeId, walletAddress: normalized, message, nonce, expiresAt });

  return { challengeId, message, expiresAt };
}

/**
 * Verify a signed challenge and establish a session.
 * @param {{ challengeId, walletAddress, signature }} params
 * @returns {{ sessionToken, account }}
 * @throws {Error} on invalid/expired challenge or bad signature
 */
export function verifyChallenge({ challengeId, walletAddress, signature }) {
  const normalized = ethers.getAddress(walletAddress);
  const challenge = db.getChallenge(challengeId);
  if (!challenge) throw new Error('Challenge not found or already used');
  if (challenge.wallet_address !== normalized) throw new Error('Wallet address mismatch');
  if (new Date(challenge.expires_at) < new Date()) throw new Error('Challenge expired');

  // Verify the signature
  const recoveredAddress = ethers.verifyMessage(challenge.message, signature);
  if (recoveredAddress.toLowerCase() !== normalized.toLowerCase()) {
    throw new Error('Signature verification failed');
  }

  // Mark challenge as used
  db.markChallengeUsed(challengeId);

  // Upsert account
  db.upsertAccount(normalized);
  const account = db.getAccount(normalized);

  // Create session
  const sessionToken = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionToken, { accountId: normalized, createdAt: Date.now() });

  return {
    sessionToken,
    account: {
      accountId: account.account_id,
      displayName: account.display_name,
      requiresDisplayName: !account.display_name,
      tokenBalance: account.token_balance,
      leaderboardEligible: !!account.leaderboard_eligible,
    },
  };
}

/**
 * Get account from session token.
 * @param {string} sessionToken
 * @returns {object|null} account info or null
 */
export function getSession(sessionToken) {
  if (!sessionToken) return null;
  const session = sessions.get(sessionToken);
  if (!session) return null;
  return session;
}

/**
 * Remove a session.
 */
export function destroySession(sessionToken) {
  sessions.delete(sessionToken);
}

/**
 * Validate an Ethereum address format.
 */
export function isValidAddress(address) {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

// Dev-mode shortcut: create a session without wallet signing
// Only use when NODE_ENV !== 'production'
export function devCreateSession(walletAddress) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Dev sessions not allowed in production');
  }
  const normalized = walletAddress.toLowerCase();
  db.upsertAccount(normalized);
  const account = db.getAccount(normalized);
  const sessionToken = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionToken, { accountId: normalized, createdAt: Date.now() });
  return {
    sessionToken,
    account: {
      accountId: account.account_id,
      displayName: account.display_name,
      requiresDisplayName: !account.display_name,
      tokenBalance: account.token_balance,
      leaderboardEligible: !!account.leaderboard_eligible,
    },
  };
}

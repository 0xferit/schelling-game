import crypto from 'node:crypto';
import { ethers } from 'ethers';
import db from './db';
import type { AccountRow } from './types/db';

export interface Session {
  accountId: string;
  createdAt: number;
}

export interface AccountResponse {
  accountId: string;
  displayName: string | null;
  requiresDisplayName: boolean;
  tokenBalance: number;
  leaderboardEligible: boolean;
}

const CHALLENGE_TTL_MS: number = 5 * 60 * 1000; // 5 minutes
const sessions: Map<string, Session> = new Map(); // sessionToken -> { accountId, createdAt }

/**
 * Create an auth challenge for a wallet address.
 * @param walletAddress - Ethereum address (0x...)
 * @returns challengeId, message, and expiresAt
 */
export function createChallenge(walletAddress: string): {
  challengeId: string;
  message: string;
  expiresAt: string;
} {
  // Normalize to checksum address
  const normalized: string = ethers.getAddress(walletAddress);
  const nonce: string = crypto.randomBytes(32).toString('hex');
  const challengeId: string = `ch_${crypto.randomBytes(16).toString('hex')}`;
  const issuedAt: number = Date.now();
  const expiresAt: string = new Date(
    issuedAt + CHALLENGE_TTL_MS,
  ).toISOString();
  const message: string = `Sign this message to authenticate with Schelling Game.\n\nWallet: ${normalized}\nNonce: ${nonce}\nExpires: ${expiresAt}`;

  db.createChallenge({
    challengeId,
    walletAddress: normalized,
    message,
    nonce,
    expiresAt,
    issuedAt,
  });

  return { challengeId, message, expiresAt };
}

/**
 * Verify a signed challenge and establish a session.
 * @param params - challengeId, walletAddress, signature
 * @returns sessionToken and account info
 * @throws Error on invalid/expired challenge or bad signature
 */
export function verifyChallenge({
  challengeId,
  walletAddress,
  signature,
}: {
  challengeId: string;
  walletAddress: string;
  signature: string;
}): { sessionToken: string; account: AccountResponse } {
  const normalized: string = ethers.getAddress(walletAddress);
  const challenge = db.getChallenge(challengeId);
  if (!challenge) throw new Error('Challenge not found or already used');
  if (challenge.wallet_address !== normalized)
    throw new Error('Wallet address mismatch');
  if (new Date(challenge.expires_at) < new Date())
    throw new Error('Challenge expired');

  // Verify the signature
  const recoveredAddress: string = ethers.verifyMessage(
    challenge.message,
    signature,
  );
  if (recoveredAddress.toLowerCase() !== normalized.toLowerCase()) {
    throw new Error('Signature verification failed');
  }

  // Mark challenge as used
  db.markChallengeUsed(challengeId);

  // Upsert account
  db.upsertAccount(normalized);
  const account: AccountRow = db.getAccount(normalized)!;

  // Create session
  const sessionToken: string = crypto.randomBytes(32).toString('hex');
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
 * @param sessionToken
 * @returns session info or null
 */
export function getSession(sessionToken: string | undefined): Session | null {
  if (!sessionToken) return null;
  const session: Session | undefined = sessions.get(sessionToken);
  if (!session) return null;
  return session;
}

/**
 * Remove a session.
 */
export function destroySession(sessionToken: string): void {
  sessions.delete(sessionToken);
}

/**
 * Validate an Ethereum address format.
 */
export function isValidAddress(address: string): boolean {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

// Dev-mode shortcut: create a session without wallet signing
// Only use when NODE_ENV !== 'production'
export function devCreateSession(walletAddress: string): {
  sessionToken: string;
  account: AccountResponse;
} {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Dev sessions not allowed in production');
  }
  const normalized: string = walletAddress.toLowerCase();
  db.upsertAccount(normalized);
  const account: AccountRow = db.getAccount(normalized)!;
  const sessionToken: string = crypto.randomBytes(32).toString('hex');
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

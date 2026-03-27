import { ethers } from 'ethers';
import {
  buildChallengeMessage,
  createSessionCookie,
} from '../../src/worker/session';

// Deterministic test wallets derived from sequential private keys.
// 22 distinct keys (indices 0-21), starting at private key value 1 (0 is invalid for secp256k1).
const TEST_KEYS = [
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000000000000000000000000000003',
  '0x0000000000000000000000000000000000000000000000000000000000000004',
  '0x0000000000000000000000000000000000000000000000000000000000000005',
  '0x0000000000000000000000000000000000000000000000000000000000000006',
  '0x0000000000000000000000000000000000000000000000000000000000000007',
  '0x0000000000000000000000000000000000000000000000000000000000000008',
  '0x0000000000000000000000000000000000000000000000000000000000000009',
  '0x000000000000000000000000000000000000000000000000000000000000000a',
  '0x000000000000000000000000000000000000000000000000000000000000000b',
  '0x000000000000000000000000000000000000000000000000000000000000000c',
  '0x000000000000000000000000000000000000000000000000000000000000000d',
  '0x000000000000000000000000000000000000000000000000000000000000000e',
  '0x000000000000000000000000000000000000000000000000000000000000000f',
  '0x0000000000000000000000000000000000000000000000000000000000000010',
  '0x0000000000000000000000000000000000000000000000000000000000000011',
  '0x0000000000000000000000000000000000000000000000000000000000000012',
  '0x0000000000000000000000000000000000000000000000000000000000000013',
  '0x0000000000000000000000000000000000000000000000000000000000000014',
  '0x0000000000000000000000000000000000000000000000000000000000000015',
  '0x0000000000000000000000000000000000000000000000000000000000000016',
];

export function createTestWallet(index = 0): ethers.Wallet {
  return new ethers.Wallet(TEST_KEYS[index]!);
}

/**
 * Build a valid session cookie for a test wallet.
 * The session is stateless: the cookie itself is the proof (EIP-191 sig).
 */
export async function createTestSession(wallet: ethers.Wallet): Promise<{
  accountId: string;
  cookie: string;
}> {
  const accountId = wallet.address.toLowerCase();
  const nonce = '00000000-0000-4000-8000-000000000000';
  const issuedAt = Date.now();
  const message = buildChallengeMessage(accountId, nonce, issuedAt);
  const signature = await wallet.signMessage(message);
  const cookie = createSessionCookie(accountId, nonce, issuedAt, signature);
  return { accountId, cookie };
}

/**
 * Seed an account + player_stats row in D1 so the Worker can look it up.
 */
export async function seedAccount(
  db: D1Database,
  accountId: string,
  displayName: string | null = null,
  balance = 0,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'INSERT INTO accounts (account_id, display_name, token_balance) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET display_name = excluded.display_name, token_balance = excluded.token_balance',
      )
      .bind(accountId, displayName, balance),
    db
      .prepare(
        'INSERT INTO player_stats (account_id) VALUES (?) ON CONFLICT(account_id) DO NOTHING',
      )
      .bind(accountId),
  ]);
}

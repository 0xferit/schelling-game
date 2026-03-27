import { describe, expect, it } from 'vitest';
import {
  buildChallengeMessage,
  createSessionCookie,
  verifySessionCookie,
} from '../../src/worker/session';
import { createTestWallet } from './helpers';

const NONCE = '00000000-0000-4000-8000-000000000000';

describe('session cookies', () => {
  it('createSessionCookie canonicalizes hex fields to lowercase', async () => {
    const wallet = createTestWallet(0);
    const issuedAt = Date.now();
    const accountId = wallet.address.toLowerCase();
    const message = buildChallengeMessage(accountId, NONCE, issuedAt);
    const signature = await wallet.signMessage(message);
    const upperSignature = `0x${signature.slice(2).toUpperCase()}`;

    const cookie = createSessionCookie(
      wallet.address,
      NONCE,
      issuedAt,
      upperSignature,
    );

    expect(cookie).toBe(
      `${accountId}:${NONCE}:${issuedAt}:${signature.toLowerCase()}`,
    );
  });

  it('createSessionCookie produces identical output for upper and lowercase signatures', async () => {
    const wallet = createTestWallet(1);
    const issuedAt = Date.now();
    const accountId = wallet.address.toLowerCase();
    const message = buildChallengeMessage(accountId, NONCE, issuedAt);
    const signature = await wallet.signMessage(message);
    const upperSignature = `0x${signature.slice(2).toUpperCase()}`;

    const lowerCookie = createSessionCookie(
      accountId,
      NONCE,
      issuedAt,
      signature,
    );
    const upperCookie = createSessionCookie(
      accountId,
      NONCE,
      issuedAt,
      upperSignature,
    );

    expect(upperCookie).toBe(lowerCookie);
    expect(verifySessionCookie(lowerCookie)).toBe(accountId);
  });

  it('verifySessionCookie rejects a manually-constructed cookie with uppercase signature hex', async () => {
    const wallet = createTestWallet(2);
    const issuedAt = Date.now();
    const accountId = wallet.address.toLowerCase();
    const message = buildChallengeMessage(accountId, NONCE, issuedAt);
    const signature = await wallet.signMessage(message);
    const upperSignature = `0x${signature.slice(2).toUpperCase()}`;

    // Bypass createSessionCookie to craft a cookie with uppercase signature
    const manualUpperCookie = `${accountId}:${NONCE}:${issuedAt}:${upperSignature}`;

    expect(verifySessionCookie(manualUpperCookie)).toBeNull();
  });
});

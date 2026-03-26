// Wallet-signature-based session: no server-side secret.
// Cookie format: walletAddress:nonce:issuedAt:signature
// Verification reconstructs the challenge message, recovers the signer,
// and checks the issuedAt timestamp is within the allowed window.

import { ethers } from 'ethers';

const MESSAGE_PREFIX = 'Sign this message to authenticate with Schelling Game.';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function buildChallengeMessage(walletAddress: string, nonce: string): string {
  return `${MESSAGE_PREFIX}\n\nWallet: ${walletAddress}\nNonce: ${nonce}`;
}

export function createSessionCookie(
  walletAddress: string,
  nonce: string,
  signature: string,
): string {
  const issuedAt = Date.now();
  return `${walletAddress}:${nonce}:${issuedAt}:${signature}`;
}

export function verifySessionCookie(cookie: string | undefined): string | null {
  if (!cookie) return null;

  // Format: walletAddress:nonce:issuedAt:signature
  // Split on first three colons; everything after the third is the signature.
  const firstColon = cookie.indexOf(':');
  if (firstColon === -1) return null;
  const secondColon = cookie.indexOf(':', firstColon + 1);
  if (secondColon === -1) return null;
  const thirdColon = cookie.indexOf(':', secondColon + 1);
  if (thirdColon === -1) return null;

  const walletAddress = cookie.slice(0, firstColon);
  const nonce = cookie.slice(firstColon + 1, secondColon);
  const issuedAtStr = cookie.slice(secondColon + 1, thirdColon);
  const signature = cookie.slice(thirdColon + 1);

  if (!walletAddress || !nonce || !issuedAtStr || !signature) return null;

  // Validate server-side expiry
  const issuedAt = Number(issuedAtStr);
  if (Number.isNaN(issuedAt)) return null;
  if (Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null;

  const message = buildChallengeMessage(walletAddress, nonce);

  try {
    const recovered = ethers.verifyMessage(message, signature).toLowerCase();
    if (recovered === walletAddress.toLowerCase()) {
      return walletAddress.toLowerCase();
    }
  } catch {
    // Invalid signature format
  }

  return null;
}

export function parseCookies(
  cookieHeader: string | null,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  }
  return cookies;
}

export function getAuthenticatedAccountId(request: Request): string | null {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return verifySessionCookie(cookies.session);
}

export { buildChallengeMessage, MESSAGE_PREFIX };

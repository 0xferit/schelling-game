// Wallet-signature-based session: no server-side secret.
// Cookie contains walletAddress:nonce:signature. Verification
// reconstructs the challenge message and recovers the signer.

import { ethers } from 'ethers';

const MESSAGE_PREFIX = 'Sign this message to authenticate with Schelling Game.';

function buildChallengeMessage(walletAddress: string, nonce: string): string {
  return `${MESSAGE_PREFIX}\n\nWallet: ${walletAddress}\nNonce: ${nonce}`;
}

export function createSessionCookie(
  walletAddress: string,
  nonce: string,
  signature: string,
): string {
  return `${walletAddress}:${nonce}:${signature}`;
}

export function verifySessionCookie(cookie: string | undefined): string | null {
  if (!cookie) return null;

  // Format: walletAddress:nonce:signature
  // Signature is 0x-prefixed and contains colons-worth of hex, so split carefully.
  // walletAddress is 42 chars (0x + 40 hex), nonce is a UUID (36 chars),
  // signature is the rest.
  const firstColon = cookie.indexOf(':');
  if (firstColon === -1) return null;
  const secondColon = cookie.indexOf(':', firstColon + 1);
  if (secondColon === -1) return null;

  const walletAddress = cookie.slice(0, firstColon);
  const nonce = cookie.slice(firstColon + 1, secondColon);
  const signature = cookie.slice(secondColon + 1);

  if (!walletAddress || !nonce || !signature) return null;

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

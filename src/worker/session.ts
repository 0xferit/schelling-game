// Wallet-signature-based session: no server-side secret.
// Cookie format: walletAddress:nonce:issuedAt:signature
// The challenge message includes walletAddress, nonce, AND issuedAt,
// so the signature covers all fields. Tampering with issuedAt invalidates
// the signature.

import { ethers } from 'ethers';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLOCK_SKEW_MS = 60 * 1000; // 60 seconds leeway for edge POP clock drift
const MAX_COOKIE_LENGTH = 512; // wallet(42) + nonce(36) + issuedAt(~13) + sig(132) + colons(3) < 230
const WALLET_RE = /^0x[0-9a-f]{40}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ETH_SIG_RE = /^0x[0-9a-f]{130}$/;

export function buildChallengeMessage(
  walletAddress: string,
  nonce: string,
  issuedAt: number,
): string {
  return (
    'Sign this message to authenticate with Schelling Games.' +
    `\n\nWallet: ${walletAddress}\nNonce: ${nonce}\nIssued: ${issuedAt}`
  );
}

export function createSessionCookie(
  walletAddress: string,
  nonce: string,
  issuedAt: number,
  signature: string,
): string {
  const normalizedWalletAddress = walletAddress.toLowerCase();
  const normalizedSignature = signature.toLowerCase();
  return `${normalizedWalletAddress}:${nonce}:${issuedAt}:${normalizedSignature}`;
}

export function verifySessionCookie(cookie: string | undefined): string | null {
  if (!cookie || cookie.length > MAX_COOKIE_LENGTH) return null;

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

  // Strict format checks before touching crypto
  if (!WALLET_RE.test(walletAddress)) return null;
  if (!UUID_RE.test(nonce)) return null;
  if (!ETH_SIG_RE.test(signature)) return null;

  // Validate server-side expiry (single Date.now() call, with clock skew leeway)
  const issuedAt = Number(issuedAtStr);
  if (Number.isNaN(issuedAt)) return null;
  // Reject non-canonical representations (e.g. "01711411200000", "1e12")
  // so the cookie string matches exactly what buildChallengeMessage produces.
  if (String(issuedAt) !== issuedAtStr) return null;
  const now = Date.now();
  if (issuedAt > now + CLOCK_SKEW_MS) return null;
  if (now - issuedAt > SESSION_MAX_AGE_MS) return null;

  // Reconstruct the message that was signed (includes issuedAt)
  const message = buildChallengeMessage(walletAddress, nonce, issuedAt);

  try {
    const recovered = ethers.verifyMessage(message, signature).toLowerCase();
    if (recovered === walletAddress) {
      return walletAddress;
    }
  } catch {
    // Invalid signature
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

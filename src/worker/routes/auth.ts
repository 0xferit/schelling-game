import { ethers } from 'ethers';
import type { Env } from '../../types/worker-env';
import { buildChallengeMessage, createSessionCookie } from '../session';
import {
  AUTH_CHALLENGE_LIMIT,
  AUTH_VERIFY_LIMIT,
  ensureAccountWithStats,
  errorResponse,
  getRequiredString,
  isRateLimited,
  jsonResponse,
  normalizeWalletAddress,
  rateLimitResponse,
  readJsonObjectBody,
} from './_helpers';

const SIGNATURE_REGEX = /^0x[a-fA-F0-9]{130}$/;

interface AuthChallengeRow {
  challenge_id: string;
  wallet_address: string;
  nonce: string;
  message: string;
  expires_at: string;
  issued_at?: number | null;
}

function cookieAttrs(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

const AUTH_CHALLENGE_CLEANUP_INTERVAL_MS = 60 * 1000;

// Per-isolate state; each isolate gets its own timestamp.
let nextAuthChallengeCleanupAt = 0;

async function maybeCleanupExpiredAuthChallenges(
  db: D1Database,
): Promise<void> {
  const now = Date.now();
  if (now < nextAuthChallengeCleanupAt) return;
  nextAuthChallengeCleanupAt = now + AUTH_CHALLENGE_CLEANUP_INTERVAL_MS;

  try {
    await db
      .prepare('DELETE FROM auth_challenges WHERE expires_at < ?')
      .bind(new Date(now).toISOString())
      .run();
  } catch (error) {
    console.error('D1: auth challenge cleanup failed', error);
  }
}

function isMissingIssuedAtColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('no such column: issued_at') ||
    message.includes('no column named issued_at')
  );
}

async function insertAuthChallenge(
  db: D1Database,
  challengeId: string,
  walletAddress: string,
  nonce: string,
  message: string,
  expiresAt: string,
  issuedAt: number,
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(challengeId, walletAddress, nonce, message, expiresAt, issuedAt)
      .run();
  } catch (error) {
    if (!isMissingIssuedAtColumnError(error)) throw error;

    await db
      .prepare(
        'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(challengeId, walletAddress, nonce, message, expiresAt)
      .run();
  }
}

function parseIssuedAtFromChallengeMessage(message: string): number | null {
  const match = /\nIssued: (\d+)$/.exec(message);
  if (!match) return null;

  const issuedAt = Number(match[1]);
  if (!Number.isSafeInteger(issuedAt)) return null;
  return issuedAt;
}

export async function handleChallenge(
  request: Request,
  env: Env,
): Promise<Response> {
  if (isRateLimited('auth_challenge', request, AUTH_CHALLENGE_LIMIT)) {
    return rateLimitResponse(AUTH_CHALLENGE_LIMIT.windowMs);
  }
  await maybeCleanupExpiredAuthChallenges(env.DB);

  const rawBody = await readJsonObjectBody(request);
  if (rawBody instanceof Response) return rawBody;

  const walletAddress = getRequiredString(rawBody, 'walletAddress');
  if (!walletAddress) {
    return errorResponse('walletAddress required');
  }
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) {
    return errorResponse('walletAddress must be a valid 0x-prefixed address');
  }
  const challengeId = `ch_${crypto.randomUUID()}`;
  const nonce = crypto.randomUUID();
  const issuedAt = Date.now();
  const expiresAt = new Date(issuedAt + 5 * 60 * 1000).toISOString();
  const message = buildChallengeMessage(normalized, nonce, issuedAt);

  await insertAuthChallenge(
    env.DB,
    challengeId,
    normalized,
    nonce,
    message,
    expiresAt,
    issuedAt,
  );

  return jsonResponse({ challengeId, message, expiresAt });
}

export async function handleVerify(
  request: Request,
  env: Env,
): Promise<Response> {
  if (isRateLimited('auth_verify', request, AUTH_VERIFY_LIMIT)) {
    return rateLimitResponse(AUTH_VERIFY_LIMIT.windowMs);
  }
  await maybeCleanupExpiredAuthChallenges(env.DB);

  const rawBody = await readJsonObjectBody(request);
  if (rawBody instanceof Response) return rawBody;

  const challengeId = getRequiredString(rawBody, 'challengeId');
  const walletAddress = getRequiredString(rawBody, 'walletAddress');
  const signature = getRequiredString(rawBody, 'signature');
  if (!challengeId || !walletAddress || !signature) {
    return errorResponse('challengeId, walletAddress, and signature required');
  }
  if (!challengeId.startsWith('ch_')) {
    return errorResponse('challengeId format is invalid');
  }
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) {
    return errorResponse('walletAddress must be a valid 0x-prefixed address');
  }
  if (!SIGNATURE_REGEX.test(signature)) {
    return errorResponse('signature format is invalid');
  }

  const challenge = (await env.DB.prepare(
    'SELECT * FROM auth_challenges WHERE challenge_id = ? AND wallet_address = ?',
  )
    .bind(challengeId, normalized)
    .first()) as AuthChallengeRow | null;

  if (!challenge) return errorResponse('Invalid or expired challenge', 401);
  const challengeIssuedAt =
    challenge.issued_at ?? parseIssuedAtFromChallengeMessage(challenge.message);
  if (challengeIssuedAt == null) {
    // Pre-migration challenge row; force client to restart auth
    await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?')
      .bind(challengeId)
      .run();
    return errorResponse('Challenge outdated. Please request a new one.', 401);
  }
  if (new Date(challenge.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?')
      .bind(challengeId)
      .run();
    return errorResponse('Challenge expired', 401);
  }

  // Verify signature
  let recoveredAddress: string;
  try {
    recoveredAddress = ethers
      .verifyMessage(challenge.message, signature)
      .toLowerCase();
  } catch {
    return errorResponse('Invalid signature', 401);
  }
  if (recoveredAddress !== normalized) {
    return errorResponse('Signature does not match wallet address', 401);
  }

  // Delete used challenge
  await env.DB.prepare('DELETE FROM auth_challenges WHERE challenge_id = ?')
    .bind(challengeId)
    .run();

  const account = await ensureAccountWithStats(env.DB, normalized);
  if (!account) {
    return errorResponse('Failed to fetch account after upsert', 500);
  }

  const token = createSessionCookie(
    normalized,
    challenge.nonce,
    challengeIssuedAt,
    signature,
  );
  const requiresDisplayName = !account.display_name;

  return jsonResponse(
    {
      accountId: normalized,
      displayName: account.display_name || null,
      requiresDisplayName,
      tokenBalance: account.token_balance ?? 0,
      leaderboardEligible: !!account.leaderboard_eligible,
    },
    200,
    {
      'Set-Cookie': `session=${token}; ${cookieAttrs(request)}; Max-Age=86400`,
    },
  );
}

export function handleLogout(request: Request): Response {
  return jsonResponse({ ok: true }, 200, {
    'Set-Cookie': `session=; ${cookieAttrs(request)}; Max-Age=0`,
  });
}

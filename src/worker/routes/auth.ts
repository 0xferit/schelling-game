import { ethers } from 'ethers';
import type { Env } from '../../types/worker-env';
import { buildChallengeMessage, createSessionCookie } from '../session';
import {
  AUTH_CHALLENGE_LIMIT,
  AUTH_VERIFY_LIMIT,
  type AuthChallengeRow,
  cookieAttrs,
  ensureAccountWithStats,
  errorResponse,
  getRequiredString,
  insertAuthChallenge,
  isRateLimited,
  jsonResponse,
  maybeCleanupExpiredAuthChallenges,
  normalizeWalletAddress,
  parseIssuedAtFromChallengeMessage,
  rateLimitResponse,
  readJsonObjectBody,
  SIGNATURE_REGEX,
} from './_helpers';

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

import type { Env } from '../../types/worker-env';
import { fetchPlayerDOStatus } from '../accountRepo';
import { getAuthenticatedAccountId } from '../session';
import {
  DISPLAY_NAME_REGEX,
  ensureAccountWithStats,
  errorResponse,
  getRequiredString,
  jsonResponse,
  readJsonObjectBody,
} from './_helpers';

export async function handleGetMe(
  request: Request,
  env: Env,
): Promise<Response> {
  const accountId = getAuthenticatedAccountId(request);
  if (!accountId) return errorResponse('Unauthorized', 401);

  const account = await ensureAccountWithStats(env.DB, accountId);
  if (!account) return errorResponse('Failed to provision account', 500);

  const queueStatus = await fetchPlayerDOStatus(env, request.url, accountId);

  return jsonResponse({
    accountId: account.account_id,
    displayName: account.display_name || null,
    tokenBalance: account.token_balance ?? 0,
    leaderboardEligible: !!account.leaderboard_eligible,
    queueStatus,
  });
}

export async function handlePatchProfile(
  request: Request,
  env: Env,
): Promise<Response> {
  const accountId = getAuthenticatedAccountId(request);
  if (!accountId) return errorResponse('Unauthorized', 401);

  const rawBody = await readJsonObjectBody(request);
  if (rawBody instanceof Response) return rawBody;

  const displayName = getRequiredString(rawBody, 'displayName');
  if (!displayName || !DISPLAY_NAME_REGEX.test(displayName)) {
    return errorResponse('displayName must be 1-20 characters: A-Za-z0-9_-');
  }

  // Check if player is in queue/match via DO
  const playerStatus = await fetchPlayerDOStatus(env, request.url, accountId);
  if (playerStatus !== 'idle') {
    return errorResponse(
      'Cannot change display name while queued, forming, or in a match',
      409,
    );
  }

  // Check uniqueness
  const existing = (await env.DB.prepare(
    'SELECT account_id FROM accounts WHERE display_name = ? COLLATE NOCASE AND account_id != ?',
  )
    .bind(displayName, accountId)
    .first()) as { account_id: string } | null;
  if (existing) return errorResponse('Display name already claimed', 409);

  await env.DB.prepare(
    'UPDATE accounts SET display_name = ? WHERE account_id = ?',
  )
    .bind(displayName, accountId)
    .run();

  return jsonResponse({ displayName });
}

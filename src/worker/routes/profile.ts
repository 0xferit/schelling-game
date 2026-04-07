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

  // Single atomic UPDATE. The NOT EXISTS predicate with COLLATE NOCASE
  // enforces case-insensitive uniqueness; the DB UNIQUE constraint only
  // catches exact-case duplicates, not the full NOCASE invariant.
  try {
    const result = await env.DB.prepare(
      'UPDATE accounts SET display_name = ? WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM accounts WHERE display_name = ? COLLATE NOCASE AND account_id != ?)',
    )
      .bind(displayName, accountId, displayName, accountId)
      .run();

    if (result.meta.changes === 0) {
      const existing = await env.DB.prepare(
        'SELECT display_name FROM accounts WHERE account_id = ?',
      )
        .bind(accountId)
        .first<{ display_name: string | null }>();
      if (existing?.display_name === displayName) {
        return jsonResponse({ displayName });
      }
      return errorResponse('Display name already claimed', 409);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint')) {
      return errorResponse('Display name already claimed', 409);
    }
    throw err;
  }

  return jsonResponse({ displayName });
}

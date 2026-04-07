import { COMMIT_DURATION, REVEAL_DURATION } from '../../domain/constants';
import type { Env } from '../../types/worker-env';
import {
  type CacheStorageWithDefault,
  EXAMPLE_VOTE_LIMIT,
  errorResponse,
  getConfiguredTurnstileSiteKey,
  getRequiredString,
  isRateLimited,
  jsonResponse,
  rateLimitResponse,
  readJsonObjectBody,
  verifyExampleVoteTurnstileToken,
} from './_helpers';

const LANDING_STATS_CACHE_TTL_SECONDS = 60;
const LANDING_STATS_CACHE_CONTROL = `public, max-age=${LANDING_STATS_CACHE_TTL_SECONDS}, s-maxage=${LANDING_STATS_CACHE_TTL_SECONDS}`;
const LANDING_STATS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function handleLandingStats(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const cache = (globalThis.caches as CacheStorageWithDefault | undefined)
    ?.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const startedAfter = new Date(
    Date.now() - LANDING_STATS_LOOKBACK_MS,
  ).toISOString();

  const [playersLast24hRow, completedMatchesRow, longestStreakRow] =
    await Promise.all([
      env.DB.prepare(
        'SELECT COUNT(DISTINCT mp.account_id) AS players_last_24h ' +
          'FROM matches m ' +
          'JOIN match_players mp ON mp.match_id = m.match_id ' +
          'WHERE m.started_at >= ? AND m.ai_assisted = 0',
      )
        .bind(startedAfter)
        .first<{ players_last_24h: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS completed_matches FROM matches WHERE status = 'completed' AND ai_assisted = 0",
      ).first<{ completed_matches: number }>(),
      env.DB.prepare(
        'SELECT COALESCE(MAX(longest_streak), 0) AS longest_streak FROM player_stats',
      ).first<{ longest_streak: number }>(),
    ]);

  const response = jsonResponse(
    {
      playersLast24h: playersLast24hRow?.players_last_24h ?? 0,
      completedMatches: completedMatchesRow?.completed_matches ?? 0,
      longestStreak: longestStreakRow?.longest_streak ?? 0,
    },
    200,
    { 'Cache-Control': LANDING_STATS_CACHE_CONTROL },
  );

  if (cache) {
    await cache.put(cacheKey, response.clone());
  }

  return response;
}

export function handleGameConfig(_request: Request, env: Env): Response {
  return jsonResponse({
    commitDuration: COMMIT_DURATION,
    revealDuration: REVEAL_DURATION,
    turnstileSiteKey: getConfiguredTurnstileSiteKey(env),
  });
}

export async function handleExampleVote(
  request: Request,
  env: Env,
): Promise<Response> {
  if (isRateLimited('example_vote', request, EXAMPLE_VOTE_LIMIT)) {
    return rateLimitResponse(EXAMPLE_VOTE_LIMIT.windowMs);
  }
  const rawBody = await readJsonObjectBody(request);
  if (rawBody instanceof Response) return rawBody;

  const idx = rawBody.optionIndex;
  const turnstileToken = getRequiredString(rawBody, 'turnstileToken');
  if (
    typeof idx !== 'number' ||
    !Number.isInteger(idx) ||
    idx < 0 ||
    idx > 17
  ) {
    return errorResponse('optionIndex must be an integer 0-17', 400);
  }
  if (!turnstileToken) {
    return errorResponse('turnstileToken is required', 400);
  }

  const verificationError = await verifyExampleVoteTurnstileToken(
    request,
    env,
    turnstileToken,
  );
  if (verificationError) return verificationError;

  await env.DB.prepare('INSERT INTO example_votes (option_index) VALUES (?)')
    .bind(idx)
    .run();
  return jsonResponse({ ok: true });
}

export async function handleExampleTally(
  _request: Request,
  env: Env,
): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT option_index, COUNT(*) as count FROM example_votes GROUP BY option_index',
  ).all();
  const votes = (results || []).map((r: Record<string, unknown>) => ({
    optionIndex: r.option_index as number,
    count: r.count as number,
  }));
  const total = votes.reduce(
    (sum: number, v: { count: number }) => sum + v.count,
    0,
  );
  return jsonResponse({ total, votes });
}

import { LEADERBOARD_LIMIT } from '../../domain/constants';
import type { Env } from '../../types/worker-env';
import { fetchAccountWithStats, shapeLeaderboardEntry } from '../accountRepo';
import { getAuthenticatedAccountId } from '../session';
import {
  errorResponse,
  jsonResponse,
  parseLeaderboardEntryRow,
} from './_helpers';

export async function handleLeaderboard(
  _request: Request,
  env: Env,
): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT a.account_id, a.display_name, a.token_balance, a.leaderboard_eligible, ' +
      's.matches_played, s.games_played, s.coherent_games, s.current_streak, s.longest_streak ' +
      'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
      'WHERE a.leaderboard_eligible = 1 AND a.display_name IS NOT NULL ' +
      'ORDER BY a.token_balance DESC, COALESCE(s.coherent_games, 0) DESC, a.display_name ASC ' +
      `LIMIT ${LEADERBOARD_LIMIT}`,
  ).all();

  const leaderboard = (results || [])
    .map((r: Record<string, unknown>, i: number) => ({
      rank: i + 1,
      row: parseLeaderboardEntryRow(r),
    }))
    .filter(
      (
        row,
      ): row is {
        rank: number;
        row: NonNullable<ReturnType<typeof parseLeaderboardEntryRow>>;
      } => row.row !== null,
    )
    .map(({ rank, row }) => ({
      rank,
      ...shapeLeaderboardEntry(row),
    }));

  return jsonResponse(leaderboard);
}

export async function handleLeaderboardMe(
  request: Request,
  env: Env,
): Promise<Response> {
  const accountId = getAuthenticatedAccountId(request);
  if (!accountId) return errorResponse('Unauthorized', 401);

  const account = await fetchAccountWithStats(env.DB, accountId);
  if (!account) return errorResponse('Account not found', 404);

  const cg = account.coherent_games || 0;
  const eligible =
    account.leaderboard_eligible === 1 && account.display_name !== null;

  let rank: number | null = null;
  if (eligible) {
    const rankRow = (await env.DB.prepare(
      'SELECT COUNT(*) as rank FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
        'WHERE a.leaderboard_eligible = 1 AND a.display_name IS NOT NULL AND (' +
        'a.token_balance > ? OR ' +
        '(a.token_balance = ? AND COALESCE(s.coherent_games, 0) > ?) OR ' +
        '(a.token_balance = ? AND COALESCE(s.coherent_games, 0) = ? AND a.display_name < ?)' +
        ')',
    )
      .bind(
        account.token_balance ?? 0,
        account.token_balance ?? 0,
        cg,
        account.token_balance ?? 0,
        cg,
        account.display_name ?? '',
      )
      .first()) as { rank: number } | null;
    rank = (rankRow?.rank ?? 0) + 1;
  }

  return jsonResponse({
    rank,
    ...shapeLeaderboardEntry(account),
  });
}

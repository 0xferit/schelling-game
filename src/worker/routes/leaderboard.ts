import { clampTokenBalance, LEADERBOARD_LIMIT } from '../../domain/constants';
import type { Env } from '../../types/worker-env';
import { fetchAccountWithStats, shapeLeaderboardEntry } from '../accountRepo';
import { getAuthenticatedAccountId } from '../session';
import { errorResponse, jsonResponse } from './_helpers';

function parseLeaderboardEntryRow(row: Record<string, unknown>): {
  display_name: string | null;
  token_balance: number;
  leaderboard_eligible: number;
  matches_played: number | null;
  games_played: number | null;
  coherent_games: number | null;
  current_streak: number | null;
  longest_streak: number | null;
} | null {
  const displayName = row.display_name;
  if (!(displayName === null || typeof displayName === 'string')) return null;

  const toNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const tokenBalance = toNumber(row.token_balance);
  const leaderboardEligible = toNumber(row.leaderboard_eligible);
  const matchesPlayed = toNumber(row.matches_played);
  const gamesPlayed = toNumber(row.games_played);
  const coherentGames = toNumber(row.coherent_games);
  const currentStreak = toNumber(row.current_streak);
  const longestStreak = toNumber(row.longest_streak);

  if (tokenBalance === null || leaderboardEligible === null) return null;

  return {
    display_name: displayName,
    token_balance: clampTokenBalance(tokenBalance),
    leaderboard_eligible: leaderboardEligible,
    matches_played: matchesPlayed,
    games_played: gamesPlayed,
    coherent_games: coherentGames,
    current_streak: currentStreak,
    longest_streak: longestStreak,
  };
}

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

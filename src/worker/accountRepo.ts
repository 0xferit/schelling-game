import {
  clampTokenBalance,
  MIN_ESTABLISHED_MATCHES,
} from '../domain/constants';
import type { Env } from '../types/worker-env';

// ---------------------------------------------------------------------------
// Account + player_stats lookup
// ---------------------------------------------------------------------------

export interface AccountWithStats {
  account_id: string;
  display_name: string | null;
  token_balance: number;
  leaderboard_eligible: number;
  created_at: string;
  matches_played: number | null;
  games_played: number | null;
  coherent_games: number | null;
  current_streak: number | null;
  longest_streak: number | null;
}

const ACCOUNT_WITH_STATS_SQL =
  'SELECT a.account_id, a.display_name, a.token_balance, a.leaderboard_eligible, a.created_at, ' +
  's.matches_played, s.games_played, s.coherent_games, s.current_streak, s.longest_streak ' +
  'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
  'WHERE a.account_id = ?';

export async function fetchAccountWithStats(
  db: D1Database,
  accountId: string,
): Promise<AccountWithStats | null> {
  const row = (await db
    .prepare(ACCOUNT_WITH_STATS_SQL)
    .bind(accountId)
    .first()) as AccountWithStats | null;
  if (!row) return null;
  return {
    ...row,
    token_balance: clampTokenBalance(row.token_balance ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Leaderboard stat shaping
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  displayName: string | null;
  tokenBalance: number;
  leaderboardEligible: boolean;
  matchesPlayed: number;
  avgNetTokensPerMatch: number;
  gamesPlayed: number;
  coherentGames: number;
  coherentPct: number;
  currentStreak: number;
  longestStreak: number;
  provisional: boolean;
}

// Only the fields actually read by shapeLeaderboardEntry — allows callers to
// pass either a full AccountWithStats or a narrower bulk-query row.
export type LeaderboardEntryInput = Pick<
  AccountWithStats,
  | 'display_name'
  | 'token_balance'
  | 'leaderboard_eligible'
  | 'matches_played'
  | 'games_played'
  | 'coherent_games'
  | 'current_streak'
  | 'longest_streak'
>;

export function shapeLeaderboardEntry(
  row: LeaderboardEntryInput,
): LeaderboardEntry {
  const mp = row.matches_played || 0;
  const gp = row.games_played || 0;
  const cg = row.coherent_games || 0;
  const balance = clampTokenBalance(row.token_balance ?? 0);

  return {
    displayName: row.display_name,
    tokenBalance: balance,
    leaderboardEligible:
      row.leaderboard_eligible === 1 && row.display_name !== null,
    matchesPlayed: mp,
    avgNetTokensPerMatch: mp > 0 ? Math.round((balance / mp) * 100) / 100 : 0,
    gamesPlayed: gp,
    coherentGames: cg,
    coherentPct: gp > 0 ? Math.round((cg / gp) * 100) : 0,
    currentStreak: row.current_streak || 0,
    longestStreak: row.longest_streak || 0,
    provisional: mp < MIN_ESTABLISHED_MATCHES,
  };
}

// ---------------------------------------------------------------------------
// Durable Object /status probe
// ---------------------------------------------------------------------------

export async function fetchPlayerDOStatus(
  env: Env,
  requestUrl: string,
  accountId: string,
): Promise<string> {
  try {
    const id = env.GAME_ROOM.idFromName('lobby');
    const stub = env.GAME_ROOM.get(id);
    const statusUrl = new URL(requestUrl);
    statusUrl.pathname = '/status';
    statusUrl.searchParams.set('accountId', accountId);
    const resp = await stub.fetch(new Request(statusUrl.toString()));
    const data = (await resp.json()) as { status?: string };
    return data.status || 'idle';
  } catch {
    return 'idle';
  }
}

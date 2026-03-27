import { MIN_ESTABLISHED_MATCHES } from '../domain/constants';
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
  games_played: number;
  rounds_played: number;
  coherent_rounds: number;
  current_streak: number;
  longest_streak: number;
}

const ACCOUNT_WITH_STATS_SQL =
  'SELECT a.account_id, a.display_name, a.token_balance, a.leaderboard_eligible, a.created_at, ' +
  's.games_played, s.rounds_played, s.coherent_rounds, s.current_streak, s.longest_streak ' +
  'FROM accounts a LEFT JOIN player_stats s ON a.account_id = s.account_id ' +
  'WHERE a.account_id = ?';

export async function fetchAccountWithStats(
  db: D1Database,
  accountId: string,
): Promise<AccountWithStats | null> {
  return (await db
    .prepare(ACCOUNT_WITH_STATS_SQL)
    .bind(accountId)
    .first()) as AccountWithStats | null;
}

// ---------------------------------------------------------------------------
// Leaderboard stat shaping
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  displayName: string | null;
  tokenBalance: number;
  leaderboardEligible: boolean;
  gamesPlayed: number;
  avgNetTokensPerGame: number;
  roundsPlayed: number;
  coherentRounds: number;
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
  | 'games_played'
  | 'rounds_played'
  | 'coherent_rounds'
  | 'current_streak'
  | 'longest_streak'
>;

export function shapeLeaderboardEntry(
  row: LeaderboardEntryInput,
): LeaderboardEntry {
  const gp = row.games_played || 0;
  const rp = row.rounds_played || 0;
  const cr = row.coherent_rounds || 0;
  const balance = row.token_balance ?? 0;

  return {
    displayName: row.display_name,
    tokenBalance: balance,
    leaderboardEligible:
      !!row.leaderboard_eligible && row.display_name !== null,
    gamesPlayed: gp,
    avgNetTokensPerGame: gp > 0 ? Math.round((balance / gp) * 100) / 100 : 0,
    roundsPlayed: rp,
    coherentRounds: cr,
    coherentPct: rp > 0 ? Math.round((cr / rp) * 100) : 0,
    currentStreak: row.current_streak || 0,
    longestStreak: row.longest_streak || 0,
    provisional: gp < MIN_ESTABLISHED_MATCHES,
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

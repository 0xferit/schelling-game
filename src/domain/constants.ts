/** Minimum matches before leaderboard stats are treated as established. */
export const MIN_ESTABLISHED_MATCHES = 5;

/** Fixed number of games in a public match. */
export const MATCH_GAME_COUNT = 10;

/** Token ante charged per player per game. */
export const GAME_ANTE = 2520;

/** Lowest persistent balance allowed for public play. */
export const MIN_ALLOWED_BALANCE = -MATCH_GAME_COUNT * GAME_ANTE;

/** Maximum rows returned by the public leaderboard endpoint. */
export const LEADERBOARD_LIMIT = 100;

/** Phase durations in seconds. Single source of truth for all consumers. */
export const COMMIT_DURATION = 60;
export const REVEAL_DURATION = 15;
export const RESULTS_DURATION = 7;

export function clampTokenBalance(balance: number): number {
  return Math.max(MIN_ALLOWED_BALANCE, balance);
}

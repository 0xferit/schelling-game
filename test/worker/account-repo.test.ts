import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  MIN_ALLOWED_BALANCE,
  MIN_ESTABLISHED_MATCHES,
} from '../../src/domain/constants';
import type { Env } from '../../src/types/worker-env';
import {
  fetchAccountWithStats,
  fetchPlayerDOStatus,
  shapeLeaderboardEntry,
} from '../../src/worker/accountRepo';

describe('accountRepo', () => {
  it('fetchAccountWithStats returns account row joined with stats', async () => {
    const accountId = `acct_repo_${Date.now()}`;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO accounts (account_id, display_name, token_balance, leaderboard_eligible, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(accountId, 'RepoUser', 777, 1, new Date().toISOString()),
      env.DB.prepare(
        'INSERT INTO player_stats (account_id, matches_played, games_played, coherent_games, current_streak, longest_streak) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(accountId, 12, 120, 60, 3, 9),
    ]);

    const row = await fetchAccountWithStats(env.DB, accountId);
    expect(row?.account_id).toBe(accountId);
    expect(row?.display_name).toBe('RepoUser');
    expect(row?.token_balance).toBe(777);
    expect(row?.matches_played).toBe(12);
    expect(row?.games_played).toBe(120);
    expect(row?.coherent_games).toBe(60);
  });

  it('fetchAccountWithStats clamps stale balances below the allowed floor', async () => {
    const accountId = `acct_repo_floor_${Date.now()}`;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO accounts (account_id, display_name, token_balance, leaderboard_eligible, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(
        accountId,
        'FloorUser',
        MIN_ALLOWED_BALANCE - 120,
        1,
        new Date().toISOString(),
      ),
      env.DB.prepare(
        'INSERT INTO player_stats (account_id, matches_played, games_played, coherent_games, current_streak, longest_streak) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(accountId, 3, 30, 10, 1, 4),
    ]);

    const row = await fetchAccountWithStats(env.DB, accountId);
    expect(row?.token_balance).toBe(MIN_ALLOWED_BALANCE);
  });

  it('shapeLeaderboardEntry computes derived fields correctly', () => {
    const shaped = shapeLeaderboardEntry({
      display_name: 'Alice',
      token_balance: 100,
      leaderboard_eligible: 1,
      matches_played: MIN_ESTABLISHED_MATCHES - 1,
      games_played: 5,
      coherent_games: 3,
      current_streak: 2,
      longest_streak: 4,
    });

    expect(shaped.displayName).toBe('Alice');
    expect(shaped.leaderboardEligible).toBe(true);
    expect(shaped.avgNetTokensPerMatch).toBe(
      Math.round((100 / (MIN_ESTABLISHED_MATCHES - 1)) * 100) / 100,
    );
    expect(shaped.coherentPct).toBe(60);
    expect(shaped.provisional).toBe(true);
  });

  it('fetchPlayerDOStatus returns status from the durable object', async () => {
    const envStub = {
      GAME_ROOM: {
        idFromName: () => ({}) as DurableObjectId,
        get: () =>
          ({
            fetch: async () =>
              Response.json({ status: 'queued' }, { status: 200 }),
          }) as DurableObjectStub,
      },
    } as unknown as Env;

    const status = await fetchPlayerDOStatus(
      envStub,
      'https://test.local/ws',
      'acct',
    );
    expect(status).toBe('queued');
  });

  it('fetchPlayerDOStatus falls back to idle on durable object errors', async () => {
    const envStub = {
      GAME_ROOM: {
        idFromName: () => ({}) as DurableObjectId,
        get: () =>
          ({
            fetch: async () => {
              throw new Error('boom');
            },
          }) as DurableObjectStub,
      },
    } as unknown as Env;

    const status = await fetchPlayerDOStatus(
      envStub,
      'https://test.local/ws',
      'acct',
    );
    expect(status).toBe('idle');
  });
});

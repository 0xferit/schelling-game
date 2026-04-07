import { fetchAccountWithStats } from '../accountRepo';

const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export const AUTH_CHALLENGE_LIMIT = { max: 12, windowMs: 60 * 1000 };
export const AUTH_VERIFY_LIMIT = { max: 24, windowMs: 60 * 1000 };
export const EXAMPLE_VOTE_LIMIT = { max: 40, windowMs: 60 * 1000 };

const RATE_LIMIT_SWEEP_INTERVAL_MS = 60 * 1000;

// Per-isolate rate-limit state. Moving this to a separate file does NOT make
// it global across Workers isolates; each isolate still gets its own Map.
const rateLimitBuckets = new Map<string, RateLimitBucket>();
let nextRateLimitSweepAt = 0;

interface RateLimitBucket {
  windowStartedAt: number;
  count: number;
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(data, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function rateLimitResponse(windowMs: number): Response {
  return jsonResponse(
    { error: 'Too many requests. Please try again later.' },
    429,
    { 'Retry-After': String(Math.ceil(windowMs / 1000)) },
  );
}

export function getRequiredString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function readJsonObjectBody(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return errorResponse('Invalid JSON');
    }
    return raw as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON');
  }
}

export function normalizeWalletAddress(value: string): string | null {
  if (!WALLET_ADDRESS_REGEX.test(value)) return null;
  return value.toLowerCase();
}

export function getClientIdentifier(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp.trim();
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0];
    if (first) return first.trim();
  }
  return 'unknown';
}

function sweepStaleBuckets(now: number): void {
  if (now < nextRateLimitSweepAt) return;
  nextRateLimitSweepAt = now + RATE_LIMIT_SWEEP_INTERVAL_MS;
  const maxWindowMs = Math.max(
    AUTH_CHALLENGE_LIMIT.windowMs,
    AUTH_VERIFY_LIMIT.windowMs,
    EXAMPLE_VOTE_LIMIT.windowMs,
  );
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStartedAt >= maxWindowMs) {
      rateLimitBuckets.delete(key);
    }
  }
}

export function isRateLimited(
  scope: string,
  request: Request,
  limit: { max: number; windowMs: number },
): boolean {
  const now = Date.now();
  sweepStaleBuckets(now);
  const key = `${scope}:${getClientIdentifier(request)}`;
  const existing = rateLimitBuckets.get(key);
  if (!existing || now - existing.windowStartedAt >= limit.windowMs) {
    rateLimitBuckets.set(key, { windowStartedAt: now, count: 1 });
    return false;
  }

  existing.count += 1;
  if (existing.count > limit.max) {
    return true;
  }
  return false;
}

export async function ensureAccountWithStats(
  db: D1Database,
  accountId: string,
): Promise<Awaited<ReturnType<typeof fetchAccountWithStats>>> {
  const existing = await fetchAccountWithStats(db, accountId);
  if (existing) return existing;

  const createdAt = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        'INSERT INTO accounts (account_id, token_balance, leaderboard_eligible, created_at) VALUES (?, 0, 1, ?) ' +
          'ON CONFLICT(account_id) DO NOTHING',
      )
      .bind(accountId, createdAt),
    db
      .prepare(
        'INSERT INTO player_stats (account_id, matches_played, games_played, coherent_games, current_streak, longest_streak) ' +
          'VALUES (?, 0, 0, 0, 0, 0) ON CONFLICT(account_id) DO NOTHING',
      )
      .bind(accountId),
  ]);

  return fetchAccountWithStats(db, accountId);
}

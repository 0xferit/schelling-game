import { clampTokenBalance } from '../../domain/constants';
import type { Env } from '../../types/worker-env';
import { fetchAccountWithStats } from '../accountRepo';

export const DISPLAY_NAME_REGEX = /^[A-Za-z0-9_-]{1,20}$/;
export const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
export const SIGNATURE_REGEX = /^0x[a-fA-F0-9]{130}$/;

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

export function cookieAttrs(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r')
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
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

function getClientIdentifier(request: Request): string {
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

interface TurnstileVerificationResult {
  success: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EXAMPLE_VOTE_TURNSTILE_ACTION = 'landing_example_vote';
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

export function getConfiguredTurnstileSiteKey(env: Env): string | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  return siteKey ? siteKey : null;
}

function getConfiguredTurnstileSecretKey(env: Env): string | null {
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  return secretKey ? secretKey : null;
}

function normalizeBracketedIpv6Hostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLocalHostname(hostname: string): boolean {
  const normalizedHostname = normalizeBracketedIpv6Hostname(hostname);
  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '::1' ||
    normalizedHostname.endsWith('.localhost')
  );
}

function isCloudflareTurnstileTestMode(
  siteKey: string,
  secretKey: string,
  hostname: string,
): boolean {
  return (
    siteKey === TURNSTILE_TEST_SITE_KEY &&
    secretKey === TURNSTILE_TEST_SECRET_KEY &&
    isLocalHostname(hostname)
  );
}

export async function verifyExampleVoteTurnstileToken(
  request: Request,
  env: Env,
  token: string,
): Promise<Response | null> {
  const siteKey = getConfiguredTurnstileSiteKey(env);
  const secretKey = getConfiguredTurnstileSecretKey(env);
  if (!siteKey || !secretKey) {
    return errorResponse('Demo voting is temporarily unavailable.', 503);
  }

  const body = new URLSearchParams();
  body.set('secret', secretKey);
  body.set('response', token);

  const clientIdentifier = getClientIdentifier(request);
  if (clientIdentifier !== 'unknown') {
    body.set('remoteip', clientIdentifier);
  }

  let verificationResponse: Response;
  try {
    verificationResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    console.error('Turnstile siteverify request failed', error);
    return errorResponse('Human verification is temporarily unavailable.', 503);
  }

  if (!verificationResponse.ok) {
    console.error(
      'Turnstile siteverify request returned non-OK status',
      verificationResponse.status,
    );
    return errorResponse('Human verification is temporarily unavailable.', 503);
  }

  let verificationResult: TurnstileVerificationResult;
  try {
    verificationResult =
      (await verificationResponse.json()) as TurnstileVerificationResult;
  } catch (error) {
    console.error('Turnstile siteverify response was not valid JSON', error);
    return errorResponse('Human verification is temporarily unavailable.', 503);
  }

  const expectedHostname = normalizeBracketedIpv6Hostname(
    new URL(request.url).hostname,
  );
  const verifiedHostname = verificationResult.hostname
    ? normalizeBracketedIpv6Hostname(verificationResult.hostname)
    : null;
  if (
    verificationResult.success &&
    isCloudflareTurnstileTestMode(siteKey, secretKey, expectedHostname)
  ) {
    return null;
  }

  if (
    !verificationResult.success ||
    verificationResult.action !== EXAMPLE_VOTE_TURNSTILE_ACTION ||
    verifiedHostname !== expectedHostname
  ) {
    return errorResponse('Human verification failed.', 403);
  }

  return null;
}

export interface AuthChallengeRow {
  challenge_id: string;
  wallet_address: string;
  nonce: string;
  message: string;
  expires_at: string;
  issued_at?: number | null;
}

const AUTH_CHALLENGE_CLEANUP_INTERVAL_MS = 60 * 1000;

// Per-isolate state; see rate-limit note above.
let nextAuthChallengeCleanupAt = 0;

export async function maybeCleanupExpiredAuthChallenges(
  db: D1Database,
): Promise<void> {
  const now = Date.now();
  if (now < nextAuthChallengeCleanupAt) return;
  nextAuthChallengeCleanupAt = now + AUTH_CHALLENGE_CLEANUP_INTERVAL_MS;

  try {
    await db
      .prepare('DELETE FROM auth_challenges WHERE expires_at < ?')
      .bind(new Date(now).toISOString())
      .run();
  } catch (error) {
    console.error('D1: auth challenge cleanup failed', error);
  }
}

function isMissingIssuedAtColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('no such column: issued_at') ||
    message.includes('no column named issued_at')
  );
}

export async function insertAuthChallenge(
  db: D1Database,
  challengeId: string,
  walletAddress: string,
  nonce: string,
  message: string,
  expiresAt: string,
  issuedAt: number,
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(challengeId, walletAddress, nonce, message, expiresAt, issuedAt)
      .run();
  } catch (error) {
    if (!isMissingIssuedAtColumnError(error)) throw error;

    await db
      .prepare(
        'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(challengeId, walletAddress, nonce, message, expiresAt)
      .run();
  }
}

export function parseIssuedAtFromChallengeMessage(
  message: string,
): number | null {
  const match = /\nIssued: (\d+)$/.exec(message);
  if (!match) return null;

  const issuedAt = Number(match[1]);
  if (!Number.isSafeInteger(issuedAt)) return null;
  return issuedAt;
}

export function parseLeaderboardEntryRow(row: Record<string, unknown>): {
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

export interface CacheStorageWithDefault extends CacheStorage {
  default?: Cache;
}

export async function requireAdmin(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.ADMIN_KEY) return errorResponse('ADMIN_KEY not configured', 503);

  const subtle = crypto.subtle as unknown as {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
  };
  const enc = new TextEncoder();
  const auth = request.headers.get('Authorization') ?? '';
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(auth)),
    crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${env.ADMIN_KEY}`)),
  ]);
  if (!subtle.timingSafeEqual(digestA, digestB)) {
    await new Promise((r) => setTimeout(r, 1000));
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

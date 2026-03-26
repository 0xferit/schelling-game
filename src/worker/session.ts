// Session token helpers (HMAC-signed, stateless)

const FALLBACK_SECRET = 'schelling-game-session-v1';
let sessionSecret = FALLBACK_SECRET;

export function setSessionSecret(secret: string): void {
  sessionSecret = secret;
}

export async function createSessionToken(accountId: string): Promise<string> {
  const payload = `${accountId}:${Date.now()}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  const sig = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${payload}:${sig}`;
}

export async function verifySessionToken(
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length < 3) return null;
  const sig = parts.pop()!;
  const payload = parts.join(':');

  // Validate signature is non-empty even-length hex
  if (!sig || sig.length % 2 !== 0 || !/^[0-9a-f]+$/.test(sig)) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const sigBuf = new Uint8Array(
    (sig.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBuf,
    new TextEncoder().encode(payload),
  );
  if (!valid) return null;
  return parts[0] ?? null;
}

export function parseCookies(
  cookieHeader: string | null,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  }
  return cookies;
}

export async function getAuthenticatedAccountId(
  request: Request,
): Promise<string | null> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return verifySessionToken(cookies.session);
}

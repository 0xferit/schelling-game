import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const headersFile = readFileSync(
  new URL('../../public/_headers', import.meta.url),
  'utf8',
);

const contentSecurityPolicy = headersFile
  .split('\n')
  .find((line) => line.includes('Content-Security-Policy:'));

describe('asset CSP', () => {
  it('allows secure websockets across deployment hosts while keeping local dev explicit', () => {
    expect(contentSecurityPolicy).toContain("connect-src 'self' wss:");
    expect(contentSecurityPolicy).toContain('ws://localhost:*');
    expect(contentSecurityPolicy).toContain('ws://127.0.0.1:*');
    expect(contentSecurityPolicy).not.toContain('https://api.github.com');
    expect(contentSecurityPolicy).not.toContain('wss://schelling.games');
  });

  it('allows Cloudflare Turnstile only in the script and frame directives', () => {
    expect(contentSecurityPolicy).toContain(
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://challenges.cloudflare.com",
    );
    expect(contentSecurityPolicy).toContain(
      'frame-src https://challenges.cloudflare.com',
    );
  });
});

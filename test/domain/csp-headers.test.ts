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
    expect(contentSecurityPolicy).toContain('https://api.github.com');
    expect(contentSecurityPolicy).not.toContain('wss://schelling.games');
  });
});

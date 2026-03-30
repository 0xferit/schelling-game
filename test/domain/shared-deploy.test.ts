import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sharedDeployScript = readFileSync(
  new URL('../../public/shared-deploy.js', import.meta.url),
  'utf8',
);

describe('shared deploy badge', () => {
  it('does not poll the GitHub API from the browser', () => {
    expect(sharedDeployScript).not.toContain('api.github.com');
    expect(sharedDeployScript).not.toContain('actions/runs');
  });

  it('renders a local build badge from stamped metadata', () => {
    expect(sharedDeployScript).toContain('live build');
    expect(sharedDeployScript).toContain('local dev');
  });
});

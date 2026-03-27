import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const landingHtml = readFileSync(
  new URL('../../public/index.html', import.meta.url),
  'utf8',
);
const appHtml = readFileSync(
  new URL('../../public/app.html', import.meta.url),
  'utf8',
);
const feedbackTemplate = readFileSync(
  new URL('../../.github/ISSUE_TEMPLATE/feedback.md', import.meta.url),
  'utf8',
);

describe('feedback entry points', () => {
  it('landing page exposes the feedback issue link', () => {
    expect(landingHtml).toContain('issues/new?template=feedback.md');
  });

  it('app shell exposes the feedback issue link', () => {
    expect(appHtml).toContain('issues/new?template=feedback.md');
  });

  it('feedback issue template is present', () => {
    expect(feedbackTemplate).toContain('name: Feedback');
  });

  it('feedback issue template defaults the feedback label', () => {
    expect(feedbackTemplate).toContain('- feedback');
  });
});

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

  it('app shell keeps build stamp placeholders for deploy stamping', () => {
    expect(appHtml).toContain('__BUILD_HASH__');
    expect(appHtml).toContain('__BUILD_DATE__');
  });

  it('app shell references extracted stylesheets and runtime script', () => {
    expect(appHtml).toContain('/styles/tokens.css');
    expect(appHtml).toContain('/styles/base.css');
    expect(appHtml).toContain('/styles/layout.css');
    expect(appHtml).toContain('/styles/components.css');
    expect(appHtml).toContain(
      '<script type="module" src="/scripts/app.js"></script>',
    );
  });

  it('app shell no longer embeds the application style block or runtime script', () => {
    expect(appHtml).not.toContain('<style>');
    expect(appHtml).not.toContain('The Schelling Game client');
    expect(appHtml).not.toContain("window.addEventListener('error'");
  });

  it('feedback issue template is present', () => {
    expect(feedbackTemplate).toContain('name: Feedback');
  });

  it('feedback issue template defaults the feedback label', () => {
    expect(feedbackTemplate).toContain('- feedback');
  });
});

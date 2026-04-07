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

  it('landing shell references extracted stylesheet and runtime script', () => {
    expect(landingHtml).toContain(
      '<link rel="stylesheet" href="/styles/landing.css"/>',
    );
    expect(landingHtml).toContain(
      '<script src="/scripts/landing.js"></script>',
    );
  });

  it('landing shell no longer embeds inline style or runtime script blocks', () => {
    expect(landingHtml).not.toContain('<style>');
    expect(landingHtml).not.toContain('/* ── Convergence Canvas');
  });

  it('app shell exposes the feedback issue link', () => {
    expect(appHtml).toContain('issues/new?template=feedback.md');
  });

  it('app shell keeps build stamp placeholders for deploy stamping', () => {
    expect(appHtml).toContain('__BUILD_HASH__');
    expect(appHtml).toContain('__BUILD_DATE__');
  });

  it('app shell references extracted stylesheets and runtime script', () => {
    const stylesheetLinks = appHtml.match(
      /<link rel="stylesheet" href="\/styles\/[^"]+\.css"\/>/g,
    );
    expect(stylesheetLinks?.length).toBeGreaterThanOrEqual(5);
    expect(appHtml).toContain(
      '<script type="module" src="/scripts/app.js"></script>',
    );
  });

  it('app shell no longer embeds the application style block, runtime script, or inline styles', () => {
    expect(appHtml).not.toContain('<style>');
    expect(appHtml).not.toContain('style=');
    expect(appHtml).not.toContain('Schelling Games client');
    expect(appHtml).not.toContain("window.addEventListener('error'");
  });

  it('feedback issue template is present', () => {
    expect(feedbackTemplate).toContain('name: Feedback');
  });

  it('feedback issue template defaults the feedback label', () => {
    expect(feedbackTemplate).toContain('- feedback');
  });
});

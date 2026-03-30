import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeOpenTextAnswer,
  normalizeRevealText,
} from '../../src/domain/openText';
import { getCanonicalPromptPool } from '../../src/domain/prompts';
import type { OpenTextPrompt } from '../../src/types/domain';

interface BrowserOpenTextApi {
  normalizeRevealText(answerText: string): string;
  canonicalizeOpenTextAnswer(
    answerText: unknown,
    prompt: OpenTextPrompt,
  ): {
    normalizedRevealText: string;
    canonicalCommitText: string;
    canonicalCandidate: string;
    bucketLabelCandidate: string;
  } | null;
}

function loadBrowserOpenTextApi(): BrowserOpenTextApi {
  const html = fs.readFileSync(
    path.resolve(process.cwd(), 'public/app.html'),
    'utf8',
  );
  const start = html.indexOf('function normalizeRevealText(answerText) {');
  const end = html.indexOf('function hasRevealPreimageForPrompt(');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Unable to locate browser open-text helpers in app.html');
  }

  const snippet = html.slice(start, end);
  const context = vm.createContext({ globalThis: {} });
  new vm.Script(
    `${snippet}
globalThis.__openTextApi = {
  normalizeRevealText,
  canonicalizeOpenTextAnswer,
};`,
  ).runInContext(context);

  return (
    (context as { __openTextApi?: BrowserOpenTextApi }).__openTextApi ??
    ((context as { globalThis?: { __openTextApi?: BrowserOpenTextApi } })
      .globalThis?.__openTextApi as BrowserOpenTextApi)
  );
}

function getOpenTextPrompt(id: number): OpenTextPrompt {
  const prompt = getCanonicalPromptPool().find(
    (candidate) => candidate.id === id,
  );
  if (!prompt || prompt.type !== 'open_text') {
    throw new Error(`Expected open-text prompt ${id}`);
  }
  return prompt;
}

const browserOpenTextApi = loadBrowserOpenTextApi();
const numberPrompt = getOpenTextPrompt(1002);
const cardPrompt = getOpenTextPrompt(1006);
const cityPrompt = getOpenTextPrompt(1009);
const wordPrompt = getOpenTextPrompt(1010);

describe('browser and worker open-text canonicalization parity', () => {
  it.each([
    'rock′n′roll',
    ' "New-York!" ',
    'A♠',
    'twenty-one dollars',
    'Love',
  ])('matches transport normalization for %s', (answerText) => {
    expect(browserOpenTextApi.normalizeRevealText(answerText)).toBe(
      normalizeRevealText(answerText),
    );
  });

  it.each([
    { prompt: numberPrompt, answerText: 'seven' },
    { prompt: numberPrompt, answerText: ' 10 ' },
    { prompt: cardPrompt, answerText: 'A♠' },
    { prompt: cityPrompt, answerText: 'New York' },
    { prompt: wordPrompt, answerText: 'Love' },
  ])('matches canonicalization for prompt $prompt.id answer $answerText', ({
    prompt,
    answerText,
  }) => {
    expect(
      browserOpenTextApi.canonicalizeOpenTextAnswer(answerText, prompt),
    ).toEqual(canonicalizeOpenTextAnswer(answerText, prompt));
  });
});

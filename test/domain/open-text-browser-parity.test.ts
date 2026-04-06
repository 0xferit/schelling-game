import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
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

async function loadBrowserOpenTextApi(): Promise<BrowserOpenTextApi> {
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), 'public/scripts/openText.js'),
  ).href;
  const module = await import(moduleUrl);
  return {
    normalizeRevealText: module.normalizeRevealText,
    canonicalizeOpenTextAnswer: module.canonicalizeOpenTextAnswer,
  };
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

let browserOpenTextApi: BrowserOpenTextApi;
const numberPrompt = getOpenTextPrompt(1002);
const cardPrompt = getOpenTextPrompt(1006);
const cityPrompt = getOpenTextPrompt(1009);
const wordPrompt = getOpenTextPrompt(1010);

describe('browser and worker open-text canonicalization parity', () => {
  beforeAll(async () => {
    browserOpenTextApi = await loadBrowserOpenTextApi();
  });

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

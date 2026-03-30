import crypto from 'node:crypto';
import type {
  OpenTextPrompt,
  PromptCategory,
  SchellingPrompt,
  SelectPrompt,
} from '../types/domain';
import { validateAnswerText } from './commitReveal';
import { MATCH_GAME_COUNT } from './constants';
import { canonicalizeOpenTextAnswer } from './openText';

export type PromptRoot =
  | 'coin_side'
  | 'number_1_to_10'
  | 'fruit'
  | 'colour'
  | 'day_of_week'
  | 'playing_card'
  | 'fair_split_keep_amount'
  | 'planet'
  | 'city'
  | 'word';

export interface PromptCatalogRecord {
  prompt: SchellingPrompt;
  root: PromptRoot;
  calibration: boolean;
}

const CANONICAL_PROMPT_RECORDS: PromptCatalogRecord[] = [
  {
    root: 'coin_side',
    calibration: true,
    prompt: createSelectPrompt(1001, 'Pick a side of a coin.', 'culture', [
      'Heads',
      'Tails',
    ]),
  },
  {
    root: 'number_1_to_10',
    calibration: false,
    prompt: createOpenTextPrompt(
      1002,
      'Pick a number between 1 and 10.',
      'number',
      16,
      'e.g. 7',
      { kind: 'integer_range', min: 1, max: 10, allowWords: true },
      ['7', 'seven', '10', 'ten'],
    ),
  },
  {
    root: 'fruit',
    calibration: false,
    prompt: createSelectPrompt(1003, 'Pick a fruit.', 'lifestyle', [
      'Apple',
      'Banana',
      'Orange',
      'Grape',
      'Strawberry',
      'Mango',
    ]),
  },
  {
    root: 'colour',
    calibration: false,
    prompt: createSelectPrompt(1004, 'Pick a colour.', 'aesthetics', [
      'Red',
      'Blue',
      'Green',
      'Yellow',
      'Black',
      'White',
    ]),
  },
  {
    root: 'day_of_week',
    calibration: false,
    prompt: createSelectPrompt(1005, 'Pick a day of the week.', 'lifestyle', [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]),
  },
  {
    root: 'playing_card',
    calibration: false,
    prompt: createOpenTextPrompt(
      1006,
      'Pick a playing card.',
      'culture',
      24,
      'e.g. Ace of Spades',
      { kind: 'playing_card' },
      ['Ace of Spades', 'A♠', 'AS', '10 of Hearts'],
    ),
  },
  {
    root: 'fair_split_keep_amount',
    calibration: false,
    prompt: createOpenTextPrompt(
      1007,
      'Split $100 with a stranger. How much do you keep?',
      'philosophy',
      24,
      'e.g. 50',
      {
        kind: 'integer_range',
        min: 0,
        max: 100,
        allowWords: true,
        allowCurrency: true,
      },
      ['$50', '50', 'fifty', '$60'],
    ),
  },
  {
    root: 'planet',
    calibration: false,
    prompt: createSelectPrompt(1008, 'Pick a planet.', 'culture', [
      'Mercury',
      'Venus',
      'Earth',
      'Mars',
      'Jupiter',
      'Saturn',
    ]),
  },
  {
    root: 'city',
    calibration: false,
    prompt: createOpenTextPrompt(
      1009,
      'Pick a city.',
      'culture',
      64,
      'e.g. New York',
      { kind: 'free_text' },
      ['New York', 'NYC', 'London', 'Paris'],
    ),
  },
  {
    root: 'word',
    calibration: false,
    prompt: createOpenTextPrompt(
      1010,
      'Pick a word.',
      'psychology',
      32,
      'e.g. love',
      { kind: 'single_word' },
      ['love', 'home', 'peace', 'money'],
    ),
  },
];

const PROMPT_RECORDS_BY_ID = new Map(
  CANONICAL_PROMPT_RECORDS.map((record) => [record.prompt.id, record]),
);

function createSelectPrompt(
  id: number,
  text: string,
  category: PromptCategory,
  options: string[],
): SelectPrompt {
  return {
    id,
    text,
    type: 'select',
    category,
    options: [...options],
  };
}

function createOpenTextPrompt(
  id: number,
  text: string,
  category: PromptCategory,
  maxLength: number,
  placeholder: string,
  answerSpec: OpenTextPrompt['answerSpec'],
  canonicalExamples: string[],
): OpenTextPrompt {
  return {
    id,
    text,
    type: 'open_text',
    category,
    maxLength,
    placeholder,
    answerSpec,
    aiNormalization: 'required',
    canonicalExamples: [...canonicalExamples],
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getCurrentCanonicalPool(): SchellingPrompt[] {
  return CANONICAL_PROMPT_RECORDS.map((record) => record.prompt);
}

function shuffleInPlace<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const randomValue = buf[0];
    if (randomValue === undefined) {
      throw new RangeError('Missing random value during prompt shuffle');
    }
    const j = randomValue % (i + 1);
    const current = values[i];
    const swap = values[j];
    if (current === undefined || swap === undefined) {
      throw new RangeError('Prompt shuffle index out of bounds');
    }
    values[i] = swap;
    values[j] = current;
  }
  return values;
}

function normalizeOptionIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ');
}

function getPromptIssues(pool: readonly SchellingPrompt[]): string[] {
  const issues: string[] = [];

  if (pool.length < MATCH_GAME_COUNT) {
    issues.push(
      `Prompt pool must contain at least ${MATCH_GAME_COUNT} prompts; found ${pool.length}.`,
    );
  }

  const ids = new Set<number>();
  let selectCount = 0;
  let openTextCount = 0;
  for (const prompt of pool) {
    if (ids.has(prompt.id)) {
      issues.push(`Duplicate prompt id detected: ${prompt.id}.`);
    }
    ids.add(prompt.id);

    if (prompt.type === 'select') {
      selectCount += 1;
      if (prompt.options.length === 0) {
        issues.push(`Prompt ${prompt.id} must have at least one option.`);
      }
      const normalized = prompt.options.map(normalizeOptionIdentity);
      if (new Set(normalized).size !== normalized.length) {
        issues.push(
          `Prompt ${prompt.id} contains duplicate normalized options.`,
        );
      }
    } else {
      openTextCount += 1;
      if (prompt.maxLength <= 0) {
        issues.push(`Prompt ${prompt.id} must declare a positive maxLength.`);
      }
      if (!prompt.placeholder.trim()) {
        issues.push(
          `Prompt ${prompt.id} must declare a non-empty placeholder.`,
        );
      }
      if (!prompt.aiNormalization || prompt.aiNormalization !== 'required') {
        issues.push(`Prompt ${prompt.id} must require AI normalization.`);
      }
      if (!prompt.answerSpec?.kind) {
        issues.push(`Prompt ${prompt.id} must declare an answerSpec.`);
      }
      if (!prompt.canonicalExamples || prompt.canonicalExamples.length === 0) {
        issues.push(
          `Prompt ${prompt.id} must declare at least one canonicalExample.`,
        );
      } else {
        for (const example of prompt.canonicalExamples) {
          if (!validateAnswerText(example, prompt)) {
            issues.push(
              `Prompt ${prompt.id} canonicalExample "${example}" fails answer validation.`,
            );
          } else if (!canonicalizeOpenTextAnswer(example, prompt)) {
            issues.push(
              `Prompt ${prompt.id} canonicalExample "${example}" fails canonicalization.`,
            );
          }
        }
      }
    }
  }

  const minPerType = Math.ceil(MATCH_GAME_COUNT / 2);
  if (selectCount < minPerType) {
    issues.push(
      `Prompt pool must contain at least ${minPerType} select prompts; found ${selectCount}.`,
    );
  }
  if (openTextCount < minPerType) {
    issues.push(
      `Prompt pool must contain at least ${minPerType} open_text prompts; found ${openTextCount}.`,
    );
  }

  return issues;
}

function getRecordIssues(records: readonly PromptCatalogRecord[]): string[] {
  const issues: string[] = [];
  const roots = new Set<PromptRoot>();
  const ids = new Set<number>();
  let calibrationCount = 0;

  for (const record of records) {
    roots.add(record.root);
    ids.add(record.prompt.id);
    if (record.calibration) calibrationCount += 1;
  }

  if (roots.size !== records.length) {
    issues.push(
      'Canonical prompt records must contain exactly one prompt per root.',
    );
  }

  for (const record of records) {
    if (record.prompt.id <= 0) {
      issues.push(`Prompt id must be positive; found ${record.prompt.id}.`);
    }
  }
  if (ids.size !== records.length) {
    issues.push('Canonical prompt records contain duplicate prompt ids.');
  }

  if (calibrationCount < 1) {
    issues.push(
      `Canonical prompt records must contain at least one calibration prompt; found ${calibrationCount}.`,
    );
  }

  return issues;
}

export function getCanonicalPromptPool(): SchellingPrompt[] {
  return cloneJson(getCurrentCanonicalPool());
}

export function getCanonicalPromptRecords(): PromptCatalogRecord[] {
  return cloneJson(CANONICAL_PROMPT_RECORDS);
}

export function getPromptRecordById(
  promptId: number,
): PromptCatalogRecord | undefined {
  return PROMPT_RECORDS_BY_ID.get(promptId);
}

export function selectPromptsForMatch(
  count = MATCH_GAME_COUNT,
  options: { includeOpenText?: boolean } = {},
): SchellingPrompt[] {
  if (options.includeOpenText === false) {
    throw new RangeError(
      'Select-only matches are unsupported with the current prompt catalog',
    );
  }

  if (count <= 0 || count > CANONICAL_PROMPT_RECORDS.length) {
    throw new RangeError(
      `Cannot select ${count} prompts from a catalog of ${CANONICAL_PROMPT_RECORDS.length}`,
    );
  }

  const selectRecords = CANONICAL_PROMPT_RECORDS.filter(
    (r) => r.prompt.type === 'select',
  );
  const openTextRecords = CANONICAL_PROMPT_RECORDS.filter(
    (r) => r.prompt.type === 'open_text',
  );
  const selectNeeded = Math.floor(count / 2);
  const openTextNeeded = count - selectNeeded;

  if (
    selectRecords.length < selectNeeded ||
    openTextRecords.length < openTextNeeded
  ) {
    throw new RangeError(
      `Catalog lacks enough prompts of each type for a balanced ${count}-game match`,
    );
  }

  const picked = [
    ...shuffleInPlace([...selectRecords]).slice(0, selectNeeded),
    ...shuffleInPlace([...openTextRecords]).slice(0, openTextNeeded),
  ];
  return shuffleInPlace(picked).map((record) => cloneJson(record.prompt));
}

export function getPromptPoolQualityIssues(
  pool?: readonly SchellingPrompt[],
): string[] {
  const currentPool = pool ?? getCurrentCanonicalPool();
  const issues = getPromptIssues(currentPool);
  if (pool === undefined) {
    issues.push(...getRecordIssues(CANONICAL_PROMPT_RECORDS));
  }
  return issues;
}

export function validatePromptPool(pool?: readonly SchellingPrompt[]): boolean {
  return getPromptPoolQualityIssues(pool).length === 0;
}

export default getCanonicalPromptPool();

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PROMPT_RECORDS,
  loadPromptCatalogRecords,
} from '../../src/catalog/loader';
import { RAW_CANONICAL_PROMPT_RECORDS } from '../../src/catalog/records';
import type {
  RawOpenTextPrompt,
  RawPromptCatalogRecord,
  RawSelectPrompt,
} from '../../src/catalog/schema';
import {
  getCanonicalPromptPool,
  getCanonicalPromptRecords,
  getPromptPoolQualityIssues,
  getPromptRecordById,
  selectPromptsForMatch,
  validatePromptPool,
} from '../../src/domain/prompts';
import type { OpenTextPrompt, SchellingPrompt } from '../../src/types/domain';

const rawCatalogSource = readFileSync(
  new URL('../../src/catalog/records.ts', import.meta.url),
  'utf8',
);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function restoreRecord<T extends object>(target: T, snapshot: T): void {
  const mutableTarget = target as Record<string, unknown>;
  for (const key of Object.keys(mutableTarget)) {
    delete mutableTarget[key];
  }
  Object.assign(target, cloneJson(snapshot));
}

function getMutableRecord(id: number) {
  const record = getPromptRecordById(id);
  if (!record) {
    throw new Error(`Expected prompt record ${id}`);
  }
  return record;
}

describe('catalog loader', () => {
  it('materializes raw catalog data into the canonical runtime records', () => {
    expect(loadPromptCatalogRecords()).toEqual(CANONICAL_PROMPT_RECORDS);

    const rawOpenTextRecord = RAW_CANONICAL_PROMPT_RECORDS.find(
      (record) => record.prompt.type === 'open_text',
    );
    const loadedOpenTextRecord = CANONICAL_PROMPT_RECORDS.find(
      (record) => record.prompt.type === 'open_text',
    );
    if (!rawOpenTextRecord || !loadedOpenTextRecord) {
      throw new Error('Expected open-text prompt records to exist');
    }
    if (loadedOpenTextRecord.prompt.type !== 'open_text') {
      throw new Error('Expected loaded open-text prompt record');
    }

    expect('aiNormalization' in rawOpenTextRecord.prompt).toBe(false);
    expect(loadedOpenTextRecord.prompt.aiNormalization).toBe('required');
  });

  it('keeps raw researcher-owned catalog data free of domain-builder imports', () => {
    expect(rawCatalogSource).not.toContain('../domain/');
    expect(rawCatalogSource).not.toContain('createSelectPrompt');
    expect(rawCatalogSource).not.toContain('createOpenTextPrompt');
  });

  it('defensively clones mutable raw prompt fields during loading', () => {
    const selectRawPrompt: RawSelectPrompt = {
      id: 2001,
      text: 'Pick a colour.',
      type: 'select',
      category: 'aesthetics',
      options: ['Blue', 'Red'],
    };
    const selectRawRecord: RawPromptCatalogRecord = {
      root: 'colour',
      calibration: false,
      aiBackfill: { promptHints: ['colour hint'] },
      prompt: selectRawPrompt,
    };
    const openTextRawPrompt: RawOpenTextPrompt = {
      id: 2002,
      text: 'Pick a number from 1 to 10.',
      type: 'open_text',
      category: 'number',
      maxLength: 16,
      placeholder: 'Type a number',
      answerSpec: {
        kind: 'integer_range',
        min: 1,
        max: 10,
        allowWords: true,
      },
      canonicalExamples: ['Seven'],
    };
    const openTextRawRecord: RawPromptCatalogRecord = {
      root: 'number_1_to_10',
      calibration: true,
      aiBackfill: { promptHints: ['number hint'] },
      prompt: openTextRawPrompt,
    };
    const rawRecords: RawPromptCatalogRecord[] = [
      selectRawRecord,
      openTextRawRecord,
    ];

    const loadedRecords = loadPromptCatalogRecords(rawRecords);
    const loadedSelectPrompt = loadedRecords[0]?.prompt;
    const loadedOpenTextPrompt = loadedRecords[1]?.prompt;
    if (!loadedSelectPrompt || !loadedOpenTextPrompt) {
      throw new Error('Expected loaded prompt records');
    }
    if (loadedOpenTextPrompt.type !== 'open_text') {
      throw new Error('Expected open-text prompt record');
    }

    selectRawPrompt.options.push('Green');
    selectRawRecord.aiBackfill.promptHints.push('second hint');
    if (openTextRawPrompt.answerSpec.kind !== 'integer_range') {
      throw new Error('Expected integer-range answer spec');
    }
    openTextRawPrompt.answerSpec.allowWords = false;
    openTextRawPrompt.canonicalExamples.push('Eight');

    expect(loadedSelectPrompt).toEqual({
      id: 2001,
      text: 'Pick a colour.',
      type: 'select',
      category: 'aesthetics',
      options: ['Blue', 'Red'],
    });
    expect(loadedRecords[0]?.aiBackfill.promptHints).toEqual(['colour hint']);
    expect(loadedOpenTextPrompt).toEqual({
      id: 2002,
      text: 'Pick a number from 1 to 10.',
      type: 'open_text',
      category: 'number',
      maxLength: 16,
      placeholder: 'Type a number',
      answerSpec: {
        kind: 'integer_range',
        min: 1,
        max: 10,
        allowWords: true,
      },
      aiNormalization: 'required',
      canonicalExamples: ['Seven'],
    });
  });
});

describe('prompt pool', () => {
  const pool = getCanonicalPromptPool();
  const records = getCanonicalPromptRecords();

  it('contains at least 10 prompts', () => {
    expect(pool.length).toBeGreaterThanOrEqual(10);
  });

  it('contains at least 5 select prompts and 5 open-text prompts', () => {
    expect(
      pool.filter((prompt) => prompt.type === 'select').length,
    ).toBeGreaterThanOrEqual(5);
    expect(
      pool.filter((prompt) => prompt.type === 'open_text').length,
    ).toBeGreaterThanOrEqual(5);
  });

  it('has unique positive ids and includes the original 10 seed prompts', () => {
    const ids = records.map((record) => record.prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toBeGreaterThan(0);
    }
    for (let id = 1001; id <= 1010; id++) {
      expect(ids).toContain(id);
    }
  });

  it('contains one prompt per root and at least one calibration prompt', () => {
    expect(new Set(records.map((record) => record.root)).size).toBe(
      records.length,
    );
    const calibrationCount = records.filter(
      (record) => record.calibration,
    ).length;
    expect(calibrationCount).toBeGreaterThanOrEqual(1);
  });

  it('assigns structured metadata to every open-text prompt', () => {
    const openTextPrompts = pool.filter(
      (prompt): prompt is Extract<SchellingPrompt, { type: 'open_text' }> =>
        prompt.type === 'open_text',
    );

    for (const prompt of openTextPrompts) {
      expect(prompt.aiNormalization).toBe('required');
      expect(prompt.answerSpec.kind).toBeTruthy();
      expect(prompt.placeholder.length).toBeGreaterThan(0);
      expect(prompt.maxLength).toBeGreaterThan(0);
    }
  });

  it('assigns AI backfill prompt hints to every canonical prompt', () => {
    for (const record of records) {
      expect(record.aiBackfill.promptHints.length).toBeGreaterThan(0);
    }
  });

  it('passes prompt-pool quality validation', () => {
    expect(validatePromptPool()).toBe(true);
    expect(getPromptPoolQualityIssues()).toEqual([]);
  });

  it('returns defensive clones of the public prompt pool', () => {
    const first = getCanonicalPromptPool();
    const second = getCanonicalPromptPool();
    const firstPrompt = first[0];
    const secondPrompt = second[0];
    if (!firstPrompt || !secondPrompt) {
      throw new Error('Expected canonical prompt pool to be populated');
    }

    firstPrompt.text = 'Mutated prompt text';
    expect(secondPrompt.text).not.toBe('Mutated prompt text');
  });

  it('looks up prompt records by id and returns undefined for missing ids', () => {
    expect(getPromptRecordById(1004)?.prompt.id).toBe(1004);
    expect(getPromptRecordById(-1)).toBeUndefined();
  });

  it('flags missing open-text answerSpec metadata', () => {
    const record = getMutableRecord(1006);
    const snapshot = cloneJson(record);

    try {
      expect(record.prompt.type).toBe('open_text');
      delete (record.prompt as Partial<OpenTextPrompt>).answerSpec;
      expect(
        getPromptPoolQualityIssues().some((issue) =>
          issue.includes('must declare an answerSpec'),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });

  it('flags duplicate roots in the canonical record set', () => {
    const record = getMutableRecord(1010);
    const snapshot = cloneJson(record);

    try {
      record.root = 'city';
      expect(
        getPromptPoolQualityIssues().some((issue) =>
          issue.includes('exactly one prompt per root'),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });

  it('flags empty AI backfill prompt hints', () => {
    const record = getMutableRecord(1003);
    const snapshot = cloneJson(record);

    try {
      record.aiBackfill.promptHints = [''];
      expect(
        getPromptPoolQualityIssues().some((issue) =>
          issue.includes('contains an empty AI backfill prompt hint'),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });
});

describe('prompt pool quality heuristics', () => {
  it('flags duplicate normalized options', () => {
    const duplicatePrompt: SchellingPrompt = {
      id: 4001,
      text: 'Pick a colour.',
      type: 'select',
      category: 'aesthetics',
      options: ['Blue', ' blue ', 'Red'],
    };

    const issues = getPromptPoolQualityIssues([duplicatePrompt]);

    expect(
      issues.some((issue) => issue.includes('duplicate normalized options')),
    ).toBe(true);
  });

  it('flags pools that break the minimum select / open-text balance', () => {
    const pool = getCanonicalPromptPool();
    const selectPrompt = pool.find(
      (prompt): prompt is Extract<SchellingPrompt, { type: 'select' }> =>
        prompt.type === 'select',
    );
    const openTextPrompt = pool.find(
      (prompt): prompt is Extract<SchellingPrompt, { type: 'open_text' }> =>
        prompt.type === 'open_text',
    );
    if (!selectPrompt || !openTextPrompt) {
      throw new Error('Expected both select and open-text prompts');
    }

    const brokenPool = pool.map((prompt) =>
      prompt.id === openTextPrompt.id ? cloneJson(selectPrompt) : prompt,
    );
    const issues = getPromptPoolQualityIssues(brokenPool);

    expect(
      issues.some((issue) => issue.includes('at least 5 open_text prompts')),
    ).toBe(true);
  });
});

describe('selectPromptsForMatch', () => {
  it('returns a balanced match sample', () => {
    const selected = selectPromptsForMatch();
    expect(selected).toHaveLength(10);
    expect(new Set(selected.map((prompt) => prompt.id)).size).toBe(10);
    const selectCount = selected.filter((p) => p.type === 'select').length;
    const openTextCount = selected.filter((p) => p.type === 'open_text').length;
    expect(selectCount).toBe(5);
    expect(openTextCount).toBe(5);
  });

  it('rejects select-only matches for the mixed prompt catalog', () => {
    expect(() => selectPromptsForMatch(10, { includeOpenText: false })).toThrow(
      'Select-only matches are unsupported with the current prompt catalog',
    );
  });

  it('rejects counts larger than the catalog', () => {
    const records = getCanonicalPromptRecords();
    expect(() => selectPromptsForMatch(records.length + 1)).toThrow(
      'Cannot select',
    );
  });

  it('flags open_text prompts with invalid canonicalExamples', () => {
    const record = getMutableRecord(1006);
    const snapshot = cloneJson(record);

    try {
      (record.prompt as OpenTextPrompt).canonicalExamples = [
        'not a valid card',
      ];
      const issues = getPromptPoolQualityIssues();
      expect(
        issues.some((issue) =>
          issue.includes('canonicalExample "not a valid card" fails'),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });
});

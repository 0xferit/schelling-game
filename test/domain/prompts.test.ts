import { describe, expect, it } from 'vitest';
import {
  getCanonicalPromptPool,
  getCanonicalPromptRecords,
  getPromptPoolQualityIssues,
  getPromptRecordById,
  selectPromptsForMatch,
  validatePromptPool,
} from '../../src/domain/prompts';
import type { OpenTextPrompt, SchellingPrompt } from '../../src/types/domain';

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

describe('prompt pool', () => {
  const pool = getCanonicalPromptPool();
  const records = getCanonicalPromptRecords();

  it('contains exactly 10 prompts', () => {
    expect(pool).toHaveLength(10);
  });

  it('contains exactly 5 select prompts and 5 open-text prompts', () => {
    expect(pool.filter((prompt) => prompt.type === 'select')).toHaveLength(5);
    expect(pool.filter((prompt) => prompt.type === 'open_text')).toHaveLength(
      5,
    );
  });

  it('uses ids 1001 through 1010 in seed order', () => {
    expect(records.map((record) => record.prompt.id)).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010,
    ]);
  });

  it('contains exactly one prompt per root and one calibration prompt', () => {
    expect(new Set(records.map((record) => record.root)).size).toBe(10);
    const calibrationIds = records
      .filter((record) => record.calibration)
      .map((record) => record.prompt.id);

    expect(calibrationIds).toEqual([1001]);
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

  it('flags pools that break the 5 select / 5 open-text split', () => {
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
      issues.some((issue) => issue.includes('exactly 5 select prompts')),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.includes('exactly 5 open_text prompts')),
    ).toBe(true);
  });
});

describe('selectPromptsForMatch', () => {
  it('returns all 10 prompts without duplicates', () => {
    const selected = selectPromptsForMatch(10);
    expect(selected).toHaveLength(10);
    expect(new Set(selected.map((prompt) => prompt.id)).size).toBe(10);
    expect(new Set(selected.map((prompt) => prompt.id))).toEqual(
      new Set([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]),
    );
  });

  it('rejects select-only matches for the mixed prompt catalog', () => {
    expect(() => selectPromptsForMatch(10, { includeOpenText: false })).toThrow(
      'Select-only matches are unsupported with the current prompt catalog',
    );
  });

  it('rejects partial prompt selections', () => {
    expect(() => selectPromptsForMatch(5)).toThrow(
      'Current prompt catalog requires selecting all 10 prompts per match',
    );
  });
});

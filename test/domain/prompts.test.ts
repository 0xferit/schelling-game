import { describe, expect, it } from 'vitest';
import {
  getCanonicalPromptPool,
  getCanonicalPromptRecords,
  getPromptPoolQualityIssues,
  getPromptRecordById,
  selectPromptsForMatch,
  validatePromptPool,
} from '../../src/domain/prompts';
import type { SchellingPrompt } from '../../src/types/domain';

function getRootFamily(root: string): string {
  switch (root) {
    case 'fruit':
    case 'fruits':
      return 'fruit';
    case 'animal':
    case 'animals':
      return 'animal';
    case 'car_manufacturer':
    case 'car_manufacturers':
      return 'car_manufacturer';
    default:
      return root;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function restoreRecord(target: unknown, snapshot: unknown): void {
  const mutableTarget = target as Record<string, unknown>;
  for (const key of Object.keys(mutableTarget)) {
    delete mutableTarget[key];
  }
  Object.assign(mutableTarget, cloneJson(snapshot));
}

function getMutableRecord(id: number): Record<string, unknown> {
  const record = getPromptRecordById(id);
  if (!record) {
    throw new Error(`Expected prompt record ${id}`);
  }
  return record as unknown as Record<string, unknown>;
}

function getRecordIdsForRoot(root: string): number[] {
  return getCanonicalPromptRecords()
    .filter((record) => record.root === root)
    .map((record) => record.prompt.id);
}

describe('prompt pool', () => {
  const pool = getCanonicalPromptPool();
  const records = getCanonicalPromptRecords();

  it('contains exactly 100 prompts', () => {
    expect(pool).toHaveLength(100);
  });

  it('contains exactly 80 select prompts and 20 open-text prompts', () => {
    const selectCount = pool.filter(
      (prompt) => prompt.type === 'select',
    ).length;
    const openTextCount = pool.filter(
      (prompt) => prompt.type === 'open_text',
    ).length;

    expect(selectCount).toBe(80);
    expect(openTextCount).toBe(20);
  });

  it('every select prompt has a non-empty options array', () => {
    const selectPrompts = pool.filter(
      (prompt): prompt is Extract<SchellingPrompt, { type: 'select' }> =>
        prompt.type === 'select',
    );

    expect(
      selectPrompts.every(
        (prompt) => Array.isArray(prompt.options) && prompt.options.length > 0,
      ),
    ).toBe(true);
  });

  it('ensures every select root contributes 4 prompts and every open-text root contributes 2 prompts', () => {
    const countsByRoot = new Map<
      string,
      { select: number; openText: number }
    >();
    for (const record of records) {
      const counts = countsByRoot.get(record.root) || {
        select: 0,
        openText: 0,
      };
      if (record.prompt.type === 'select') counts.select += 1;
      else counts.openText += 1;
      countsByRoot.set(record.root, counts);
    }

    for (const [root, counts] of countsByRoot) {
      if (counts.select > 0) expect(counts.select, root).toBe(4);
      if (counts.openText > 0) expect(counts.openText, root).toBe(2);
    }
  });

  it('caps color prompts at four select prompts across the full pool', () => {
    const colorPromptCount = pool.filter(
      (prompt) =>
        prompt.type === 'select' &&
        prompt.category === 'aesthetics' &&
        /\bcolor\b/i.test(prompt.text),
    ).length;

    expect(colorPromptCount).toBeLessThanOrEqual(4);
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
      throw new Error('Expected canonical prompt pool entries');
    }

    firstPrompt.text = 'Mutated prompt text';

    expect(secondPrompt?.text).not.toBe('Mutated prompt text');
  });

  it('looks up prompt records by id and returns undefined for missing ids', () => {
    const knownId = records[0]?.prompt.id;
    if (knownId === undefined) {
      throw new Error('Expected canonical prompt id');
    }

    expect(getPromptRecordById(knownId)?.prompt.id).toBe(knownId);
    expect(getPromptRecordById(-1)).toBeUndefined();
  });

  it('flags missing catalog metadata on the canonical record set', () => {
    const firstRecordId = records[0]?.prompt.id;
    if (firstRecordId === undefined) {
      throw new Error('Expected canonical prompt id');
    }
    const record = getMutableRecord(firstRecordId);
    const snapshot = cloneJson(record);

    try {
      record.frame = '';
      expect(
        getPromptPoolQualityIssues().some((issue) =>
          issue.includes('missing required catalog metadata'),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });

  it('flags canonical select-root count mismatches', () => {
    const firstRecordId = records[0]?.prompt.id;
    if (firstRecordId === undefined) {
      throw new Error('Expected canonical prompt id');
    }
    const record = getMutableRecord(firstRecordId);
    const snapshot = cloneJson(record);

    try {
      record.root = 'sports';
      const issues = getPromptPoolQualityIssues();

      expect(
        issues.some((issue) =>
          issue.includes(
            'Select root "day_of_week" must contribute exactly 4 prompts',
          ),
        ),
      ).toBe(true);
      expect(
        issues.some((issue) =>
          issue.includes(
            'Select root "sports" must contribute exactly 4 prompts',
          ),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });

  it('flags canonical open-text-root count mismatches', () => {
    const openTextId = records.find(
      (record) => record.prompt.type === 'open_text',
    )?.prompt.id;
    if (openTextId === undefined) {
      throw new Error('Expected canonical open-text prompt id');
    }
    const record = getMutableRecord(openTextId);
    const snapshot = cloneJson(record);

    try {
      record.root = 'animal';
      const issues = getPromptPoolQualityIssues();

      expect(
        issues.some((issue) =>
          issue.includes(
            'Open-text root "day_of_week" must contribute exactly 2 prompts',
          ),
        ),
      ).toBe(true);
      expect(
        issues.some((issue) =>
          issue.includes(
            'Open-text root "animal" must contribute exactly 2 prompts',
          ),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });

  it('flags canonical select/open-text pool count mismatches', () => {
    const firstRecordId = records[0]?.prompt.id;
    if (firstRecordId === undefined) {
      throw new Error('Expected canonical prompt id');
    }
    const record = getMutableRecord(firstRecordId);
    const snapshot = cloneJson(record);

    try {
      const prompt = record.prompt as Record<string, unknown>;
      prompt.type = 'open_text';
      prompt.maxLength = 30;
      prompt.placeholder = 'Type one answer';
      const issues = getPromptPoolQualityIssues();

      expect(
        issues.some((issue) =>
          issue.includes(
            'Canonical pool must contain exactly 80 select prompts',
          ),
        ),
      ).toBe(true);
      expect(
        issues.some((issue) =>
          issue.includes(
            'Canonical pool must contain exactly 20 open_text prompts',
          ),
        ),
      ).toBe(true);
    } finally {
      restoreRecord(record, snapshot);
    }
  });
});

describe('prompt pool quality heuristics', () => {
  it('flags fragmented color families', () => {
    const fragmentedColorPrompt: SchellingPrompt = {
      id: 999,
      text: 'Pick the color of money.',
      type: 'select',
      category: 'aesthetics',
      options: ['Light green', 'Green', 'Dark green', 'Gold'],
    };

    const issues = getPromptPoolQualityIssues([fragmentedColorPrompt]);

    expect(issues.some((issue) => issue.includes('"green"'))).toBe(true);
  });

  it('flags fragmented season families', () => {
    const fragmentedSeasonPrompt: SchellingPrompt = {
      id: 1000,
      text: 'Pick the best season.',
      type: 'select',
      category: 'aesthetics',
      options: ['Early autumn', 'Mid autumn', 'Late autumn', 'Winter'],
    };

    const issues = getPromptPoolQualityIssues([fragmentedSeasonPrompt]);

    expect(issues.some((issue) => issue.includes('"autumn"'))).toBe(true);
  });

  it('flags duplicate normalized options', () => {
    const duplicatePrompt: SchellingPrompt = {
      id: 1001,
      text: 'Pick the warmest color.',
      type: 'select',
      category: 'aesthetics',
      options: ['Blue', ' blue ', 'Red'],
    };

    const issues = getPromptPoolQualityIssues([duplicatePrompt]);

    expect(
      issues.some((issue) => issue.includes('duplicate normalized options')),
    ).toBe(true);
  });
});

describe('selectPromptsForMatch', () => {
  const records = getCanonicalPromptRecords();
  const rootById = new Map(
    records.map((record) => [record.prompt.id, record.root]),
  );

  it('returns unique prompts (no duplicates)', () => {
    const selected = selectPromptsForMatch(10);
    const ids = selected.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(10);
  });

  it('returns ten prompts with at least eight distinct root families', () => {
    const selected = selectPromptsForMatch(10);
    const families = new Set(
      selected.map((prompt) => getRootFamily(rootById.get(prompt.id) || '')),
    );

    expect(selected).toHaveLength(10);
    expect(families.size).toBeGreaterThanOrEqual(8);
  });

  it('caps open-text prompts at two per match', () => {
    const selected = selectPromptsForMatch(10);
    const openTextCount = selected.filter(
      (prompt) => prompt.type === 'open_text',
    ).length;

    expect(openTextCount).toBeLessThanOrEqual(2);
  });

  it('never includes both select and open-text prompts from the same semantic root family', () => {
    const selected = selectPromptsForMatch(10);
    const seenFamilies = new Set<string>();

    for (const prompt of selected) {
      const family = getRootFamily(rootById.get(prompt.id) || '');
      expect(seenFamilies.has(family)).toBe(false);
      seenFamilies.add(family);
    }
  });

  it('returns only select prompts when open text is disabled', () => {
    const selected = selectPromptsForMatch(10, { includeOpenText: false });

    expect(selected.every((prompt) => prompt.type === 'select')).toBe(true);
  });

  it('throws RangeError when requesting more prompts than distinct families', () => {
    expect(() => selectPromptsForMatch(21)).toThrow(RangeError);
  });

  it('throws when the open-text cap makes a balanced 20-prompt selection impossible', () => {
    const roots = ['sports', 'furniture', 'drinks'];
    const snapshots = roots.flatMap((root) =>
      getRecordIdsForRoot(root).map((id) => {
        const record = getMutableRecord(id);
        return { id, snapshot: cloneJson(record) };
      }),
    );

    try {
      for (const { id } of snapshots) {
        const record = getMutableRecord(id);
        const prompt = record.prompt as Record<string, unknown>;
        prompt.type = 'open_text';
        prompt.maxLength = 40;
        prompt.placeholder = 'Type one answer';
      }

      expect(() => selectPromptsForMatch(20)).toThrow(
        'Unable to satisfy a 20-prompt balanced selection from the canonical pool',
      );
    } finally {
      for (const { id, snapshot } of snapshots) {
        restoreRecord(getPromptRecordById(id), snapshot);
      }
    }
  });

  it('throws when the calibration cap makes a balanced select-only 20-prompt selection impossible', () => {
    const roots = ['sports', 'furniture'];
    const snapshots = roots.flatMap((root) =>
      getRecordIdsForRoot(root).map((id) => {
        const record = getMutableRecord(id);
        return { id, snapshot: cloneJson(record) };
      }),
    );

    try {
      for (const { id } of snapshots) {
        const record = getMutableRecord(id);
        record.calibration = true;
      }

      expect(() =>
        selectPromptsForMatch(20, { includeOpenText: false }),
      ).toThrow(
        'Unable to satisfy a 20-prompt balanced selection from the canonical pool',
      );
    } finally {
      for (const { id, snapshot } of snapshots) {
        restoreRecord(getPromptRecordById(id), snapshot);
      }
    }
  });
});

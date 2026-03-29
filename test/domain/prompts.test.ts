import { describe, expect, it } from 'vitest';
import {
  getCanonicalPromptPool,
  getCanonicalPromptRecords,
  getPromptPoolQualityIssues,
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
});

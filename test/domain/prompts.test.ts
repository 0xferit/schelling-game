import { describe, expect, it } from 'vitest';
import {
  getCanonicalPromptPool,
  getPromptPoolQualityIssues,
  selectPromptsForMatch,
  validatePromptPool,
} from '../../src/domain/prompts';
import type { SchellingPrompt } from '../../src/types/domain';

describe('prompt pool', () => {
  const pool = getCanonicalPromptPool();

  it('contains exactly 45 prompts', () => {
    expect(pool).toHaveLength(45);
  });

  it('contains only select-type prompts', () => {
    expect(pool.every((prompt) => prompt.type === 'select')).toBe(true);
  });

  it('every prompt has a non-empty options array', () => {
    expect(
      pool.every(
        (prompt) => Array.isArray(prompt.options) && prompt.options.length > 0,
      ),
    ).toBe(true);
  });

  it('caps active color-symbolism prompts at four', () => {
    const colorPromptCount = pool.filter(
      (prompt) =>
        prompt.category === 'aesthetics' && /\bcolor\b/i.test(prompt.text),
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
  it('returns the requested count', () => {
    const selected = selectPromptsForMatch(5);
    expect(selected).toHaveLength(5);
  });

  it('returns unique prompts (no duplicates)', () => {
    const selected = selectPromptsForMatch(5);
    const ids = selected.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('throws RangeError when requesting more than pool size', () => {
    const pool = getCanonicalPromptPool();
    expect(() => selectPromptsForMatch(pool.length + 1)).toThrow(RangeError);
  });
});

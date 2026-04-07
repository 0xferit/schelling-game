import { CANONICAL_PROMPT_RECORDS } from '../catalog/loader';
import type { PromptCatalogRecord, SchellingPrompt } from '../types/domain';
import { validateAnswerText } from './commitReveal';
import { MATCH_GAME_COUNT, MIN_PROMPTS_PER_TYPE } from './constants';
import { canonicalizeOpenTextAnswer } from './openText';

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

  if (selectCount < MIN_PROMPTS_PER_TYPE) {
    issues.push(
      `Prompt pool must contain at least ${MIN_PROMPTS_PER_TYPE} select prompts; found ${selectCount}.`,
    );
  }
  if (openTextCount < MIN_PROMPTS_PER_TYPE) {
    issues.push(
      `Prompt pool must contain at least ${MIN_PROMPTS_PER_TYPE} open_text prompts; found ${openTextCount}.`,
    );
  }

  return issues;
}

function getRecordIssues(records: readonly PromptCatalogRecord[]): string[] {
  const issues: string[] = [];
  const roots = new Set<PromptCatalogRecord['root']>();
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

  for (const record of records) {
    if (record.aiBackfill.promptHints.length === 0) {
      issues.push(
        `Prompt ${record.prompt.id} must declare at least one AI backfill prompt hint.`,
      );
    } else if (record.aiBackfill.promptHints.some((hint) => !hint.trim())) {
      issues.push(
        `Prompt ${record.prompt.id} contains an empty AI backfill prompt hint.`,
      );
    }
  }

  return issues;
}

export function getPromptPoolQualityIssues(
  pool?: readonly SchellingPrompt[],
): string[] {
  const currentPool =
    pool ?? CANONICAL_PROMPT_RECORDS.map((record) => record.prompt);
  const issues = getPromptIssues(currentPool);
  if (pool === undefined) {
    issues.push(...getRecordIssues(CANONICAL_PROMPT_RECORDS));
  }
  return issues;
}

export function validatePromptPool(pool?: readonly SchellingPrompt[]): boolean {
  return getPromptPoolQualityIssues(pool).length === 0;
}

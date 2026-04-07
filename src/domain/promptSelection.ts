import crypto from 'node:crypto';
import { CANONICAL_PROMPT_RECORDS } from '../catalog/loader';
import type { PromptCatalogRecord, SchellingPrompt } from '../types/domain';
import { MATCH_GAME_COUNT } from './constants';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const PROMPT_RECORDS_BY_ID = new Map(
  CANONICAL_PROMPT_RECORDS.map((record) => [record.prompt.id, record]),
);

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
    (record) => record.prompt.type === 'select',
  );
  const openTextRecords = CANONICAL_PROMPT_RECORDS.filter(
    (record) => record.prompt.type === 'open_text',
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

import type {
  OpenTextAnswerSpec,
  OpenTextPrompt,
  PromptCatalogRecord,
  SchellingPrompt,
  SelectPrompt,
} from '../types/domain';
import { RAW_CANONICAL_PROMPT_RECORDS } from './records';
import type { RawCatalogPrompt, RawPromptCatalogRecord } from './schema';

function cloneAnswerSpec(spec: OpenTextAnswerSpec): OpenTextAnswerSpec {
  return { ...spec };
}

function buildPrompt(rawPrompt: RawCatalogPrompt): SchellingPrompt {
  if (rawPrompt.type === 'select') {
    const prompt: SelectPrompt = {
      id: rawPrompt.id,
      text: rawPrompt.text,
      type: 'select',
      category: rawPrompt.category,
      options: [...rawPrompt.options],
    };
    return prompt;
  }

  const prompt: OpenTextPrompt = {
    id: rawPrompt.id,
    text: rawPrompt.text,
    type: 'open_text',
    category: rawPrompt.category,
    maxLength: rawPrompt.maxLength,
    placeholder: rawPrompt.placeholder,
    answerSpec: cloneAnswerSpec(rawPrompt.answerSpec),
    aiNormalization: 'required',
    canonicalExamples: [...rawPrompt.canonicalExamples],
  };
  return prompt;
}

export function loadPromptCatalogRecords(
  rawRecords: readonly RawPromptCatalogRecord[] = RAW_CANONICAL_PROMPT_RECORDS,
): PromptCatalogRecord[] {
  return rawRecords.map((record) => ({
    root: record.root,
    calibration: record.calibration,
    aiBackfill: {
      promptHints: [...record.aiBackfill.promptHints],
    },
    prompt: buildPrompt(record.prompt),
  }));
}

export const CANONICAL_PROMPT_RECORDS = loadPromptCatalogRecords();

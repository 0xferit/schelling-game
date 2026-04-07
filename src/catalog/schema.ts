import type {
  OpenTextAnswerSpec,
  PromptAiBackfillProfile,
  PromptCategory,
  PromptRoot,
} from '../types/domain';

interface RawBasePrompt {
  id: number;
  text: string;
  category: PromptCategory;
}

export interface RawSelectPrompt extends RawBasePrompt {
  type: 'select';
  options: string[];
}

export interface RawOpenTextPrompt extends RawBasePrompt {
  type: 'open_text';
  maxLength: number;
  placeholder: string;
  answerSpec: OpenTextAnswerSpec;
  canonicalExamples: string[];
}

export type RawCatalogPrompt = RawSelectPrompt | RawOpenTextPrompt;

export interface RawPromptCatalogRecord {
  prompt: RawCatalogPrompt;
  root: PromptRoot;
  calibration: boolean;
  aiBackfill: PromptAiBackfillProfile;
}

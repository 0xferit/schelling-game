import type {
  OpenTextPrompt,
  PromptCategory,
  SelectPrompt,
} from '../types/domain';

export function createSelectPrompt(
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

export function createOpenTextPrompt(
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

import type { IntegerRangeAnswerSpec, OpenTextPrompt } from '../types/domain';

const TERMINAL_PUNCTUATION_RE = /[.!?,;:]+(?=(?:['"])?$)/;
const SINGLE_SPACE_RE = /\s+/g;
const EN_DASH_RE = /[\u2010-\u2015]/g;
const WORD_NUMBER_MAP = new Map<string, number>([
  ['zero', 0],
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
]);
const TENS_NUMBER_MAP = new Map<string, number>([
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
]);

const CARD_RANK_LABELS = new Map<string, string>([
  ['a', 'Ace'],
  ['ace', 'Ace'],
  ['2', '2'],
  ['two', '2'],
  ['3', '3'],
  ['three', '3'],
  ['4', '4'],
  ['four', '4'],
  ['5', '5'],
  ['five', '5'],
  ['6', '6'],
  ['six', '6'],
  ['7', '7'],
  ['seven', '7'],
  ['8', '8'],
  ['eight', '8'],
  ['9', '9'],
  ['nine', '9'],
  ['10', '10'],
  ['ten', '10'],
  ['j', 'Jack'],
  ['jack', 'Jack'],
  ['q', 'Queen'],
  ['queen', 'Queen'],
  ['k', 'King'],
  ['king', 'King'],
]);

const CARD_SUIT_LABELS = new Map<string, string>([
  ['c', 'Clubs'],
  ['club', 'Clubs'],
  ['clubs', 'Clubs'],
  ['♣', 'Clubs'],
  ['d', 'Diamonds'],
  ['diamond', 'Diamonds'],
  ['diamonds', 'Diamonds'],
  ['♦', 'Diamonds'],
  ['h', 'Hearts'],
  ['heart', 'Hearts'],
  ['hearts', 'Hearts'],
  ['♥', 'Hearts'],
  ['s', 'Spades'],
  ['spade', 'Spades'],
  ['spades', 'Spades'],
  ['♠', 'Spades'],
]);

export interface CanonicalOpenTextAnswer {
  normalizedRevealText: string;
  canonicalCommitText: string;
  canonicalCandidate: string;
  bucketLabelCandidate: string;
}

export function normalizeRevealText(answerText: string): string {
  return answerText
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u2032`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(EN_DASH_RE, '-')
    .trim()
    .replace(SINGLE_SPACE_RE, ' ')
    .toLowerCase()
    .replace(TERMINAL_PUNCTUATION_RE, '')
    .trim();
}

function normalizeNumberWords(value: string): string {
  return value
    .replace(/-/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\bdollars?\b/g, ' ')
    .replace(/\$/g, ' ')
    .replace(/,/g, '')
    .replace(SINGLE_SPACE_RE, ' ')
    .trim();
}

function parseEnglishInteger(value: string): number | null {
  const normalized = normalizeNumberWords(value);
  if (!normalized) return null;
  if (WORD_NUMBER_MAP.has(normalized)) {
    return WORD_NUMBER_MAP.get(normalized) ?? null;
  }
  if (TENS_NUMBER_MAP.has(normalized)) {
    return TENS_NUMBER_MAP.get(normalized) ?? null;
  }
  if (normalized === 'one hundred') {
    return 100;
  }

  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length === 2) {
    const tens = TENS_NUMBER_MAP.get(parts[0] || '');
    const ones = WORD_NUMBER_MAP.get(parts[1] || '');
    if (tens !== undefined && ones !== undefined && ones < 10) {
      return tens + ones;
    }
  }

  return null;
}

function parseIntegerRange(
  normalizedRevealText: string,
  spec: IntegerRangeAnswerSpec,
): number | null {
  const currencyTrimmed = normalizeNumberWords(normalizedRevealText);
  if (!currencyTrimmed) return null;

  if (/^\d+$/.test(currencyTrimmed)) {
    const parsed = Number.parseInt(currencyTrimmed, 10);
    if (Number.isFinite(parsed)) {
      return parsed >= spec.min && parsed <= spec.max ? parsed : null;
    }
    return null;
  }

  if (!spec.allowWords) {
    return null;
  }

  const parsed = parseEnglishInteger(currencyTrimmed);
  if (parsed === null) return null;
  return parsed >= spec.min && parsed <= spec.max ? parsed : null;
}

function normalizePlayingCardText(normalizedRevealText: string): string {
  return normalizedRevealText
    .replace(/10/g, '10 ')
    .replace(/[♣♦♥♠]/g, ' $& ')
    .replace(/\bof\b/g, ' ')
    .replace(SINGLE_SPACE_RE, ' ')
    .trim();
}

function parsePlayingCard(normalizedRevealText: string): string | null {
  const compact = normalizedRevealText.replace(/\s+/g, '');
  const compactMatch = compact.match(/^(10|[2-9]|[ajqk])([cdhs♣♦♥♠])$/i);
  if (compactMatch) {
    const rankLabel = CARD_RANK_LABELS.get(
      (compactMatch[1] || '').toLowerCase(),
    );
    const suitLabel = CARD_SUIT_LABELS.get(
      (compactMatch[2] || '').toLowerCase(),
    );
    if (rankLabel && suitLabel) {
      return `${rankLabel} of ${suitLabel}`;
    }
  }

  const tokens = normalizePlayingCardText(normalizedRevealText)
    .split(' ')
    .filter(Boolean);
  if (tokens.length !== 2) return null;

  const rankLabel = CARD_RANK_LABELS.get((tokens[0] || '').toLowerCase());
  const suitLabel = CARD_SUIT_LABELS.get((tokens[1] || '').toLowerCase());
  if (!rankLabel || !suitLabel) return null;
  return `${rankLabel} of ${suitLabel}`;
}

export function canonicalizeOpenTextAnswer(
  answerText: unknown,
  prompt: OpenTextPrompt,
): CanonicalOpenTextAnswer | null {
  if (typeof answerText !== 'string') return null;
  if (answerText.length === 0 || answerText.length > prompt.maxLength) {
    return null;
  }
  if (/[\r\n]/.test(answerText)) return null;

  const normalizedRevealText = normalizeRevealText(answerText);
  if (!normalizedRevealText) return null;
  const answerSpec = prompt.answerSpec || { kind: 'free_text' };

  switch (answerSpec.kind) {
    case 'integer_range': {
      const parsed = parseIntegerRange(normalizedRevealText, answerSpec);
      if (parsed === null) return null;
      const canonical = String(parsed);
      const bucketLabelCandidate = answerSpec.allowCurrency
        ? `$${canonical}`
        : canonical;
      return {
        normalizedRevealText,
        canonicalCommitText: canonical,
        canonicalCandidate: canonical,
        bucketLabelCandidate,
      };
    }
    case 'playing_card': {
      const parsed = parsePlayingCard(normalizedRevealText);
      if (!parsed) return null;
      return {
        normalizedRevealText,
        canonicalCommitText: parsed,
        canonicalCandidate: parsed,
        bucketLabelCandidate: parsed,
      };
    }
    case 'single_word': {
      if (normalizedRevealText.includes(' ')) return null;
      return {
        normalizedRevealText,
        canonicalCommitText: normalizedRevealText,
        canonicalCandidate: normalizedRevealText,
        bucketLabelCandidate: normalizedRevealText,
      };
    }
    case 'free_text':
      return {
        normalizedRevealText,
        canonicalCommitText: normalizedRevealText,
        canonicalCandidate: normalizedRevealText,
        bucketLabelCandidate: normalizedRevealText,
      };
    default:
      return null;
  }
}

export function validateOpenTextAnswer(
  answerText: unknown,
  prompt: OpenTextPrompt,
): answerText is string {
  return canonicalizeOpenTextAnswer(answerText, prompt) !== null;
}

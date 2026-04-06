function normalizeRevealText(answerText) {
  return answerText
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u2032`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.!?,;:]+(?=(?:['"])?$)/g, '')
    .trim();
}

const WORD_NUMBER_MAP = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_NUMBER_MAP = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const CARD_RANK_LABELS = {
  a: 'Ace',
  ace: 'Ace',
  2: '2',
  two: '2',
  3: '3',
  three: '3',
  4: '4',
  four: '4',
  5: '5',
  five: '5',
  6: '6',
  six: '6',
  7: '7',
  seven: '7',
  8: '8',
  eight: '8',
  9: '9',
  nine: '9',
  10: '10',
  ten: '10',
  j: 'Jack',
  jack: 'Jack',
  q: 'Queen',
  queen: 'Queen',
  k: 'King',
  king: 'King',
};

const CARD_SUIT_LABELS = {
  c: 'Clubs',
  club: 'Clubs',
  clubs: 'Clubs',
  '♣': 'Clubs',
  d: 'Diamonds',
  diamond: 'Diamonds',
  diamonds: 'Diamonds',
  '♦': 'Diamonds',
  h: 'Hearts',
  heart: 'Hearts',
  hearts: 'Hearts',
  '♥': 'Hearts',
  s: 'Spades',
  spade: 'Spades',
  spades: 'Spades',
  '♠': 'Spades',
};

const CARD_RANK_OPTIONS = [
  'Ace',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'Jack',
  'Queen',
  'King',
];

const CARD_SUIT_OPTIONS = [
  { value: 'Clubs', label: 'Clubs ♣' },
  { value: 'Diamonds', label: 'Diamonds ♦' },
  { value: 'Hearts', label: 'Hearts ♥' },
  { value: 'Spades', label: 'Spades ♠' },
];

function normalizeNumberWords(value) {
  return value
    .replace(/-/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\bdollars?\b/g, ' ')
    .replace(/\$/g, ' ')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEnglishInteger(value) {
  const normalized = normalizeNumberWords(value);
  if (!normalized) return null;
  if (WORD_NUMBER_MAP[normalized] !== undefined) return WORD_NUMBER_MAP[normalized];
  if (TENS_NUMBER_MAP[normalized] !== undefined) return TENS_NUMBER_MAP[normalized];
  if (normalized === 'one hundred') return 100;

  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length === 2) {
    const tens = TENS_NUMBER_MAP[parts[0]];
    const ones = WORD_NUMBER_MAP[parts[1]];
    if (tens !== undefined && ones !== undefined && ones < 10) {
      return tens + ones;
    }
  }
  return null;
}

function parseIntegerRangeAnswer(normalizedRevealText, spec) {
  const trimmed = normalizeNumberWords(normalizedRevealText);
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const parsed = parseInt(trimmed, 10);
    return parsed >= spec.min && parsed <= spec.max ? parsed : null;
  }
  if (!spec.allowWords) return null;
  const parsed = parseEnglishInteger(trimmed);
  if (parsed === null) return null;
  return parsed >= spec.min && parsed <= spec.max ? parsed : null;
}

function parsePlayingCardAnswer(normalizedRevealText) {
  const compact = normalizedRevealText.replace(/\s+/g, '');
  const compactMatch = compact.match(/^(10|[2-9]|[ajqk])([cdhs♣♦♥♠])$/i);
  if (compactMatch) {
    const rank = CARD_RANK_LABELS[(compactMatch[1] || '').toLowerCase()];
    const suit = CARD_SUIT_LABELS[(compactMatch[2] || '').toLowerCase()];
    if (rank && suit) {
      return `${rank} of ${suit}`;
    }
  }

  const tokens = normalizedRevealText
    .replace(/10/g, '10 ')
    .replace(/[♣♦♥♠]/g, ' $& ')
    .replace(/\bof\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (tokens.length !== 2) return null;

  const rank = CARD_RANK_LABELS[(tokens[0] || '').toLowerCase()];
  const suit = CARD_SUIT_LABELS[(tokens[1] || '').toLowerCase()];
  if (!rank || !suit) return null;
  return `${rank} of ${suit}`;
}

function getPlayingCardSelection(answerText) {
  if (typeof answerText !== 'string') {
    return { rank: '', suit: '', label: '' };
  }
  const normalizedRevealText = normalizeRevealText(answerText);
  if (!normalizedRevealText) {
    return { rank: '', suit: '', label: '' };
  }
  const label = parsePlayingCardAnswer(normalizedRevealText);
  if (!label) {
    return { rank: '', suit: '', label: '' };
  }
  const [rank = '', suit = ''] = label.split(' of ');
  return { rank, suit, label };
}

function canonicalizeOpenTextAnswer(answerText, prompt) {
  if (!prompt || prompt.type !== 'open_text') return null;
  if (typeof answerText !== 'string') return null;
  if (answerText.length === 0 || answerText.length > prompt.maxLength) return null;
  if (/[\r\n]/.test(answerText)) return null;

  const normalizedRevealText = normalizeRevealText(answerText);
  if (!normalizedRevealText) return null;

  switch (prompt.answerSpec.kind) {
    case 'integer_range': {
      const parsed = parseIntegerRangeAnswer(normalizedRevealText, prompt.answerSpec);
      if (parsed === null) return null;
      const canonical = String(parsed);
      return {
        normalizedRevealText,
        canonicalCommitText: canonical,
        canonicalCandidate: canonical,
        bucketLabelCandidate: prompt.answerSpec.allowCurrency ? `$${canonical}` : canonical,
      };
    }
    case 'playing_card': {
      const parsed = parsePlayingCardAnswer(normalizedRevealText);
      if (!parsed) return null;
      return {
        normalizedRevealText,
        canonicalCommitText: parsed,
        canonicalCandidate: parsed,
        bucketLabelCandidate: parsed,
      };
    }
    case 'single_word':
      if (normalizedRevealText.includes(' ')) return null;
      return {
        normalizedRevealText,
        canonicalCommitText: normalizedRevealText,
        canonicalCandidate: normalizedRevealText,
        bucketLabelCandidate: normalizedRevealText,
      };
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

function validateOpenTextAnswer(answerText, prompt) {
  return canonicalizeOpenTextAnswer(answerText, prompt) !== null;
}

export {
  CARD_RANK_OPTIONS,
  CARD_SUIT_OPTIONS,
  canonicalizeOpenTextAnswer,
  getPlayingCardSelection,
  normalizeRevealText,
  validateOpenTextAnswer,
};

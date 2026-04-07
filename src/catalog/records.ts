import type { RawPromptCatalogRecord } from './schema';

// Researcher-owned prompt catalog data. Add or edit records here; the domain
// modules own selection and validation behavior.
export const RAW_CANONICAL_PROMPT_RECORDS: RawPromptCatalogRecord[] = [
  {
    root: 'coin_side',
    calibration: true,
    aiBackfill: {
      promptHints: [
        'Treat this as a classic immediate focal-point prompt and prefer the side people blurt out first.',
      ],
    },
    prompt: {
      id: 1001,
      text: 'Pick a side of a coin.',
      type: 'select',
      category: 'culture',
      options: ['Heads', 'Tails'],
    },
  },
  {
    root: 'number_1_to_10',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a memorable number that many people pick immediately over a calculated midpoint.',
      ],
    },
    prompt: {
      id: 1002,
      text: 'Pick a number between 1 and 10.',
      type: 'open_text',
      category: 'number',
      maxLength: 16,
      placeholder: 'e.g. 7',
      answerSpec: { kind: 'integer_range', min: 1, max: 10, allowWords: true },
      canonicalExamples: ['7', 'seven', '10', 'ten'],
    },
  },
  {
    root: 'fruit',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer the most prototypical everyday fruit rather than something exotic or personally favorite.',
      ],
    },
    prompt: {
      id: 1003,
      text: 'Pick a fruit.',
      type: 'select',
      category: 'lifestyle',
      options: ['Apple', 'Banana', 'Orange', 'Grape', 'Strawberry', 'Mango'],
    },
  },
  {
    root: 'colour',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a basic colour with obvious cultural prominence instead of a neutral or secondary shade.',
      ],
    },
    prompt: {
      id: 1004,
      text: 'Pick a colour.',
      type: 'select',
      category: 'aesthetics',
      options: ['Red', 'Blue', 'Green', 'Yellow', 'Black', 'White'],
    },
  },
  {
    root: 'day_of_week',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer the day that stands out most in everyday culture and conversation rather than a random midpoint day.',
      ],
    },
    prompt: {
      id: 1005,
      text: 'Pick a day of the week.',
      type: 'select',
      category: 'lifestyle',
      options: [
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
        'Sunday',
      ],
    },
  },
  {
    root: 'playing_card',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer an iconic card that even casual players recognize immediately.',
      ],
    },
    prompt: {
      id: 1006,
      text: 'Pick a playing card.',
      type: 'open_text',
      category: 'culture',
      maxLength: 24,
      placeholder: 'e.g. Ace of Spades',
      answerSpec: { kind: 'playing_card' },
      canonicalExamples: ['Ace of Spades', 'A♠', 'AS', '10 of Hearts'],
    },
  },
  {
    root: 'fair_split_keep_amount',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Treat this as a fairness focal-point prompt where an equal split is the mainstream anchor.',
      ],
    },
    prompt: {
      id: 1007,
      text: 'Split $100 with a stranger. How much do you keep?',
      type: 'open_text',
      category: 'philosophy',
      maxLength: 24,
      placeholder: 'e.g. 50',
      answerSpec: {
        kind: 'integer_range',
        min: 0,
        max: 100,
        allowWords: true,
        allowCurrency: true,
      },
      canonicalExamples: ['$50', '50', 'fifty', '$60'],
    },
  },
  {
    root: 'planet',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer the planet that feels most obvious to an ordinary non-expert without astronomy-style reasoning.',
      ],
    },
    prompt: {
      id: 1008,
      text: 'Pick a planet.',
      type: 'select',
      category: 'culture',
      options: ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn'],
    },
  },
  {
    root: 'city',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a globally famous city that many people mention first, not a local or niche favorite.',
      ],
    },
    prompt: {
      id: 1009,
      text: 'Pick a city.',
      type: 'open_text',
      category: 'culture',
      maxLength: 64,
      placeholder: 'e.g. New York',
      answerSpec: { kind: 'free_text' },
      canonicalExamples: ['New York', 'NYC', 'London', 'Paris'],
    },
  },
  {
    root: 'word',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a short, emotionally basic word that people reach for immediately.',
      ],
    },
    prompt: {
      id: 1010,
      text: 'Pick a word.',
      type: 'open_text',
      category: 'psychology',
      maxLength: 32,
      placeholder: 'e.g. love',
      answerSpec: { kind: 'single_word' },
      canonicalExamples: ['love', 'home', 'peace', 'money'],
    },
  },
];

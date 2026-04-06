import {
  createOpenTextPrompt,
  createSelectPrompt,
} from '../domain/promptBuilders';
import type { PromptCatalogRecord } from '../types/domain';

// Researcher-owned prompt catalog data. Add or edit records here; the domain
// modules own selection and validation behavior.
export const CANONICAL_PROMPT_RECORDS: PromptCatalogRecord[] = [
  {
    root: 'coin_side',
    calibration: true,
    aiBackfill: {
      promptHints: [
        'Treat this as a classic immediate focal-point prompt and prefer the side people blurt out first.',
      ],
    },
    prompt: createSelectPrompt(1001, 'Pick a side of a coin.', 'culture', [
      'Heads',
      'Tails',
    ]),
  },
  {
    root: 'number_1_to_10',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a memorable number that many people pick immediately over a calculated midpoint.',
      ],
    },
    prompt: createOpenTextPrompt(
      1002,
      'Pick a number between 1 and 10.',
      'number',
      16,
      'e.g. 7',
      { kind: 'integer_range', min: 1, max: 10, allowWords: true },
      ['7', 'seven', '10', 'ten'],
    ),
  },
  {
    root: 'fruit',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer the most prototypical everyday fruit rather than something exotic or personally favorite.',
      ],
    },
    prompt: createSelectPrompt(1003, 'Pick a fruit.', 'lifestyle', [
      'Apple',
      'Banana',
      'Orange',
      'Grape',
      'Strawberry',
      'Mango',
    ]),
  },
  {
    root: 'colour',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a basic colour with obvious cultural prominence instead of a neutral or secondary shade.',
      ],
    },
    prompt: createSelectPrompt(1004, 'Pick a colour.', 'aesthetics', [
      'Red',
      'Blue',
      'Green',
      'Yellow',
      'Black',
      'White',
    ]),
  },
  {
    root: 'day_of_week',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer the day that stands out most in everyday culture and conversation rather than a random midpoint day.',
      ],
    },
    prompt: createSelectPrompt(1005, 'Pick a day of the week.', 'lifestyle', [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]),
  },
  {
    root: 'playing_card',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer an iconic card that even casual players recognize immediately.',
      ],
    },
    prompt: createOpenTextPrompt(
      1006,
      'Pick a playing card.',
      'culture',
      24,
      'e.g. Ace of Spades',
      { kind: 'playing_card' },
      ['Ace of Spades', 'A♠', 'AS', '10 of Hearts'],
    ),
  },
  {
    root: 'fair_split_keep_amount',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Treat this as a fairness focal-point prompt where an equal split is the mainstream anchor.',
      ],
    },
    prompt: createOpenTextPrompt(
      1007,
      'Split $100 with a stranger. How much do you keep?',
      'philosophy',
      24,
      'e.g. 50',
      {
        kind: 'integer_range',
        min: 0,
        max: 100,
        allowWords: true,
        allowCurrency: true,
      },
      ['$50', '50', 'fifty', '$60'],
    ),
  },
  {
    root: 'planet',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer the planet that feels most obvious to an ordinary non-expert without astronomy-style reasoning.',
      ],
    },
    prompt: createSelectPrompt(1008, 'Pick a planet.', 'culture', [
      'Mercury',
      'Venus',
      'Earth',
      'Mars',
      'Jupiter',
      'Saturn',
    ]),
  },
  {
    root: 'city',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a globally famous city that many people mention first, not a local or niche favorite.',
      ],
    },
    prompt: createOpenTextPrompt(
      1009,
      'Pick a city.',
      'culture',
      64,
      'e.g. New York',
      { kind: 'free_text' },
      ['New York', 'NYC', 'London', 'Paris'],
    ),
  },
  {
    root: 'word',
    calibration: false,
    aiBackfill: {
      promptHints: [
        'Prefer a short, emotionally basic word that people reach for immediately.',
      ],
    },
    prompt: createOpenTextPrompt(
      1010,
      'Pick a word.',
      'psychology',
      32,
      'e.g. love',
      { kind: 'single_word' },
      ['love', 'home', 'peace', 'money'],
    ),
  },
];

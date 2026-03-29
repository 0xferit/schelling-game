import crypto from 'node:crypto';
import type { SchellingPrompt } from '../types/domain';

const COARSE_COLOR_OPTIONS = [
  'Red',
  'Orange',
  'Yellow',
  'Green',
  'Blue',
  'Purple',
  'White',
  'Black',
  'Gray',
  'Gold',
  'Silver',
] as const;

const FAMILY_ROOTS = new Set([
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'white',
  'black',
  'gray',
  'grey',
  'gold',
  'silver',
  'spring',
  'summer',
  'autumn',
  'fall',
  'winter',
]);

const PROMPT_POOL: SchellingPrompt[] = [
  {
    id: 1,
    text: 'Pick a number.',
    type: 'select',
    category: 'number',
    options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  },
  {
    id: 2,
    text: 'Pick a Fibonacci number.',
    type: 'select',
    category: 'number',
    options: ['1', '2', '3', '5', '8', '13', '21', '34', '55', '89'],
  },
  {
    id: 3,
    text: 'Pick a perfect square.',
    type: 'select',
    category: 'number',
    options: ['1', '4', '9', '16', '25', '36', '49', '64', '81', '100'],
  },
  {
    id: 4,
    text: 'Pick a prime number.',
    type: 'select',
    category: 'number',
    options: [
      '2',
      '3',
      '5',
      '7',
      '11',
      '13',
      '17',
      '19',
      '23',
      '29',
      '31',
      '37',
    ],
  },
  {
    id: 5,
    text: 'Pick a multiple of ten.',
    type: 'select',
    category: 'number',
    options: ['10', '20', '30', '40', '50', '60', '70', '80', '90', '100'],
  },
  {
    id: 6,
    text: 'Pick a digit.',
    type: 'select',
    category: 'number',
    options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  },
  {
    id: 7,
    text: 'Pick a number.',
    type: 'select',
    category: 'number',
    options: [
      '3',
      '7',
      '12',
      '22',
      '35',
      '42',
      '58',
      '69',
      '77',
      '88',
      '91',
      '100',
    ],
  },
  {
    id: 8,
    text: 'Pick a probability.',
    type: 'select',
    category: 'number',
    options: [
      '0.01',
      '0.05',
      '0.10',
      '0.25',
      '0.33',
      '0.50',
      '0.67',
      '0.75',
      '0.90',
      '0.95',
      '0.99',
    ],
  },
  {
    id: 9,
    text: 'Pick a power of two.',
    type: 'select',
    category: 'number',
    options: [
      '1',
      '2',
      '4',
      '8',
      '16',
      '32',
      '64',
      '128',
      '256',
      '512',
      '1024',
    ],
  },
  {
    id: 10,
    text: 'Pick a number.',
    type: 'select',
    category: 'number',
    options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '1000'],
  },
  {
    id: 11,
    text: 'Pick a number.',
    type: 'select',
    category: 'number',
    options: ['-50', '-20', '-10', '-5', '-1', '0', '1', '5', '10', '20', '50'],
  },
  {
    id: 12,
    text: 'Pick a repeating number.',
    type: 'select',
    category: 'number',
    options: ['11', '22', '33', '44', '55', '66', '77', '88', '99', '111'],
  },
  {
    id: 13,
    text: 'Pick a decimal.',
    type: 'select',
    category: 'number',
    options: [
      '0.0',
      '0.1',
      '0.2',
      '0.3',
      '0.4',
      '0.5',
      '0.6',
      '0.7',
      '0.8',
      '0.9',
      '1.0',
    ],
  },
  {
    id: 14,
    text: 'Pick a constant.',
    type: 'select',
    category: 'number',
    options: [
      '0',
      '1',
      'e (2.72)',
      'pi (3.14)',
      'phi (1.62)',
      'sqrt2 (1.41)',
      'ln2 (0.69)',
      '42',
      'infinity',
      '-1',
    ],
  },
  {
    id: 15,
    text: 'Pick a percentage.',
    type: 'select',
    category: 'number',
    options: [
      '0%',
      '10%',
      '20%',
      '30%',
      '40%',
      '50%',
      '60%',
      '70%',
      '80%',
      '90%',
      '100%',
    ],
  },
  {
    id: 16,
    text: 'Pick the best age to be.',
    type: 'select',
    category: 'lifestyle',
    options: ['5', '10', '16', '18', '21', '25', '30', '40', '50', '65', '80'],
  },
  {
    id: 17,
    text: 'Pick the best time of day.',
    type: 'select',
    category: 'lifestyle',
    options: [
      '06:00',
      '07:00',
      '08:00',
      '10:00',
      '12:00',
      '14:00',
      '17:00',
      '19:00',
      '20:00',
      '22:00',
      '00:00',
    ],
  },
  {
    id: 18,
    text: 'Pick the best month.',
    type: 'select',
    category: 'lifestyle',
    options: [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ],
  },
  {
    id: 19,
    text: 'Pick the best day of the week.',
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
  {
    id: 20,
    text: 'Pick the decade with the best music.',
    type: 'select',
    category: 'culture',
    options: [
      '1920s',
      '1930s',
      '1940s',
      '1950s',
      '1960s',
      '1970s',
      '1980s',
      '1990s',
      '2000s',
      '2010s',
      '2020s',
    ],
  },
  {
    id: 21,
    text: 'How long should a perfect vacation last?',
    type: 'select',
    category: 'lifestyle',
    options: [
      '1 day',
      '3 days',
      '1 week',
      '2 weeks',
      '1 month',
      '3 months',
      '6 months',
      '1 year',
      '5 years',
      'Forever',
    ],
  },
  {
    id: 22,
    text: 'Pick the most powerful human emotion.',
    type: 'select',
    category: 'psychology',
    options: [
      'Joy',
      'Sadness',
      'Anger',
      'Fear',
      'Surprise',
      'Disgust',
      'Love',
      'Hope',
      'Curiosity',
      'Peace',
    ],
  },
  {
    id: 23,
    text: 'Pick the best superpower.',
    type: 'select',
    category: 'fantasy',
    options: [
      'Flight',
      'Invisibility',
      'Teleportation',
      'Time travel',
      'Mind reading',
      'Super strength',
      'Immortality',
      'Shapeshifting',
      'Telekinesis',
      'Healing others',
    ],
  },
  {
    id: 24,
    text: 'If you could eat only one food forever, which?',
    type: 'select',
    category: 'lifestyle',
    options: [
      'Rice',
      'Bread',
      'Potato',
      'Pasta',
      'Corn',
      'Chicken',
      'Beef',
      'Fish',
      'Eggs',
      'Cheese',
    ],
  },
  {
    id: 25,
    text: 'Which sense is most important?',
    type: 'select',
    category: 'psychology',
    options: ['Smell', 'Taste', 'Touch', 'Hearing', 'Sight'],
  },
  {
    id: 26,
    text: 'Pick the most interesting number.',
    type: 'select',
    category: 'number',
    options: [
      'Zero',
      'One',
      'Two',
      'Three',
      'Five',
      'Seven',
      'Ten',
      'Twelve',
      'Thirteen',
      'Forty-two',
      'Hundred',
      'Infinity',
    ],
  },
  {
    id: 27,
    text: 'Pick the most important virtue.',
    type: 'select',
    category: 'philosophy',
    options: [
      'Courage',
      'Wisdom',
      'Justice',
      'Temperance',
      'Honesty',
      'Compassion',
      'Loyalty',
      'Humility',
      'Patience',
      'Gratitude',
    ],
  },
  {
    id: 28,
    text: 'Pick the most universal human fear.',
    type: 'select',
    category: 'psychology',
    options: [
      'Heights',
      'Darkness',
      'Spiders',
      'Snakes',
      'Death',
      'Loneliness',
      'Failure',
      'Deep water',
      'Public speaking',
      'The unknown',
    ],
  },
  {
    id: 31,
    text: 'Pick the most beautiful-sounding instrument.',
    type: 'select',
    category: 'aesthetics',
    options: [
      'Piano',
      'Guitar',
      'Violin',
      'Cello',
      'Flute',
      'Trumpet',
      'Saxophone',
      'Harp',
      'Drums',
      'Human voice',
    ],
  },
  {
    id: 32,
    text: 'Pick the word that best describes life.',
    type: 'select',
    category: 'philosophy',
    options: [
      'Always',
      'Never',
      'Sometimes',
      'Maybe',
      'Definitely',
      'Probably',
      'Rarely',
      'Often',
      'Impossible',
      'Unpredictable',
    ],
  },
  {
    id: 33,
    text: 'Pick what matters most.',
    type: 'select',
    category: 'philosophy',
    options: [
      'Freedom',
      'Security',
      'Love',
      'Power',
      'Knowledge',
      'Peace',
      'Wealth',
      'Health',
      'Truth',
      'Beauty',
    ],
  },
  {
    id: 34,
    text: 'Pick the fundamental principle of the universe.',
    type: 'select',
    category: 'philosophy',
    options: [
      'Order',
      'Chaos',
      'Balance',
      'Change',
      'Stillness',
      'Growth',
      'Decay',
      'Cycles',
      'Entropy',
      'Emergence',
    ],
  },
  {
    id: 35,
    text: 'Pick the most important concept.',
    type: 'select',
    category: 'philosophy',
    options: [
      'Past',
      'Present',
      'Future',
      'Moment',
      'Eternity',
      'Memory',
      'Dream',
      'Now',
      'Change',
      'Permanence',
    ],
  },
  {
    id: 46,
    text: 'Pick the best season.',
    type: 'select',
    category: 'aesthetics',
    options: ['Spring', 'Summer', 'Autumn', 'Winter'],
  },
  {
    id: 47,
    text: 'Pick the most beautiful color.',
    type: 'select',
    category: 'aesthetics',
    options: [...COARSE_COLOR_OPTIONS],
  },
  {
    id: 48,
    text: 'Pick the color of trust.',
    type: 'select',
    category: 'aesthetics',
    options: [...COARSE_COLOR_OPTIONS],
  },
  {
    id: 49,
    text: 'Pick the color of danger.',
    type: 'select',
    category: 'aesthetics',
    options: [...COARSE_COLOR_OPTIONS],
  },
  {
    id: 50,
    text: 'Pick the color most associated with money in English-speaking culture.',
    type: 'select',
    category: 'aesthetics',
    options: [...COARSE_COLOR_OPTIONS],
  },
  {
    id: 51,
    text: 'Pick the most comforting weather.',
    type: 'select',
    category: 'aesthetics',
    options: ['Sunny', 'Rainy', 'Snowy', 'Cloudy', 'Breezy', 'Foggy', 'Stormy'],
  },
  {
    id: 52,
    text: 'Pick the most dramatic weather.',
    type: 'select',
    category: 'aesthetics',
    options: [
      'Sunshine',
      'Rain',
      'Snow',
      'Thunderstorm',
      'Fog',
      'Strong wind',
      'Hail',
    ],
  },
  {
    id: 53,
    text: 'Pick the best pet.',
    type: 'select',
    category: 'lifestyle',
    options: ['Dog', 'Cat', 'Bird', 'Fish', 'Rabbit', 'Turtle', 'Horse'],
  },
  {
    id: 54,
    text: 'Pick the most relaxing natural sound.',
    type: 'select',
    category: 'aesthetics',
    options: [
      'Rain',
      'Ocean waves',
      'Wind in trees',
      'Crackling fire',
      'Birds at dawn',
      'Flowing river',
      'Silence',
    ],
  },
  {
    id: 55,
    text: 'Pick the most iconic flower.',
    type: 'select',
    category: 'aesthetics',
    options: [
      'Rose',
      'Tulip',
      'Lily',
      'Sunflower',
      'Daisy',
      'Orchid',
      'Cherry blossom',
    ],
  },
  {
    id: 56,
    text: 'Pick the clearest symbol of peace.',
    type: 'select',
    category: 'philosophy',
    options: [
      'Dove',
      'Olive branch',
      'White flag',
      'Handshake',
      'Candle',
      'Rainbow',
      'Open hands',
    ],
  },
  {
    id: 57,
    text: 'Pick the most iconic fruit.',
    type: 'select',
    category: 'lifestyle',
    options: [
      'Apple',
      'Banana',
      'Orange',
      'Strawberry',
      'Watermelon',
      'Grapes',
      'Mango',
    ],
  },
];

function normalizeOptionIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ');
}

function normalizeWords(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getFamilyRoot(normalized: string): string | null {
  if (FAMILY_ROOTS.has(normalized)) {
    return normalized;
  }

  const tokens = normalized.split(' ');
  const lastToken = tokens.at(-1);
  if (!lastToken) {
    return null;
  }

  return FAMILY_ROOTS.has(lastToken) ? lastToken : null;
}

function getFamilyFragmentationIssues(prompt: SchellingPrompt): string[] {
  const familyOptions = new Map<string, string[]>();

  for (const option of prompt.options) {
    const normalized = normalizeWords(option);
    const root = getFamilyRoot(normalized);
    if (!root) continue;

    const existing = familyOptions.get(root) ?? [];
    existing.push(option);
    familyOptions.set(root, existing);
  }

  const issues: string[] = [];
  for (const [root, options] of familyOptions.entries()) {
    if (options.length <= 1) continue;
    issues.push(
      `Prompt ${prompt.id} fragments the "${root}" family across multiple options (${options.join(', ')}), which breaks exact-match plurality and mixes abstraction levels.`,
    );
  }

  return issues;
}

function isColorSymbolismPrompt(prompt: SchellingPrompt): boolean {
  return prompt.category === 'aesthetics' && /\bcolor\b/i.test(prompt.text);
}

export function getPromptPoolQualityIssues(
  pool: readonly SchellingPrompt[] = PROMPT_POOL,
): string[] {
  const issues: string[] = [];
  const seenIds = new Set<number>();

  if (pool.length !== 45) {
    issues.push(
      `Canonical prompt pool must contain exactly 45 prompts; found ${pool.length}.`,
    );
  }

  for (const prompt of pool) {
    if (seenIds.has(prompt.id)) {
      issues.push(`Prompt id ${prompt.id} is duplicated.`);
    }
    seenIds.add(prompt.id);

    if (prompt.type !== 'select') {
      issues.push(`Prompt ${prompt.id} must use type "select".`);
    }
    if (!Array.isArray(prompt.options) || prompt.options.length === 0) {
      issues.push(`Prompt ${prompt.id} must define a non-empty options array.`);
      continue;
    }

    const normalizedCounts = new Map<string, number>();
    for (const option of prompt.options) {
      const normalized = normalizeOptionIdentity(option);
      normalizedCounts.set(
        normalized,
        (normalizedCounts.get(normalized) ?? 0) + 1,
      );
    }

    const duplicateOptions = [...normalizedCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([option]) => option);
    if (duplicateOptions.length > 0) {
      issues.push(
        `Prompt ${prompt.id} contains duplicate normalized options: ${duplicateOptions.join(', ')}.`,
      );
    }

    issues.push(...getFamilyFragmentationIssues(prompt));
  }

  const colorPromptCount = pool.filter(isColorSymbolismPrompt).length;
  if (colorPromptCount > 4) {
    issues.push(
      `Canonical prompt pool may contain at most 4 color-symbolism prompts; found ${colorPromptCount}.`,
    );
  }

  return issues;
}

export function getCanonicalPromptPool(): SchellingPrompt[] {
  return JSON.parse(JSON.stringify(PROMPT_POOL));
}

export function selectPromptsForMatch(count = 10): SchellingPrompt[] {
  const pool = getCanonicalPromptPool();
  if (count > pool.length) {
    throw new RangeError(
      `Requested ${count} prompts but pool only has ${pool.length}`,
    );
  }

  for (let i = pool.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const randomValue = buf[0];
    if (randomValue === undefined) {
      throw new RangeError('Missing random value during prompt shuffle');
    }
    const j = randomValue % (i + 1);
    const current = pool[i];
    const swap = pool[j];
    if (current === undefined || swap === undefined) {
      throw new RangeError('Prompt shuffle index out of bounds');
    }
    pool[i] = swap;
    pool[j] = current;
  }

  return pool.slice(0, count);
}

export function validatePromptPool(
  pool: readonly SchellingPrompt[] = PROMPT_POOL,
): boolean {
  return getPromptPoolQualityIssues(pool).length === 0;
}

export default PROMPT_POOL;

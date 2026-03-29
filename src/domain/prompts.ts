import crypto from 'node:crypto';
import type {
  OpenTextPrompt,
  PromptCategory,
  SchellingPrompt,
  SelectPrompt,
} from '../types/domain';

export type PromptSourceSet = 'classic' | 'later_experiment';
export type PromptAudienceScope = 'broad_anglophone';
export type PromptRoot =
  | 'day_of_week'
  | 'coin_side'
  | 'positive_number'
  | 'flower'
  | 'colour'
  | 'year'
  | 'city_in_england'
  | 'nyc_meeting_place'
  | 'nyc_meeting_time'
  | 'fair_split'
  | 'fruits'
  | 'sports'
  | 'furniture'
  | 'car_manufacturers'
  | 'fast_food_chains'
  | 'animals'
  | 'metals'
  | 'means_of_transport'
  | 'drinks'
  | 'superheroes'
  | 'fruit'
  | 'animal'
  | 'car_manufacturer';

export interface PromptCatalogRecord {
  prompt: SchellingPrompt;
  root: PromptRoot;
  sourceSet: PromptSourceSet;
  frame: string;
  audienceScope: PromptAudienceScope;
  calibration: boolean;
}

interface SelectRootConfig {
  root: PromptRoot;
  sourceSet: PromptSourceSet;
  category: PromptCategory;
  options: string[];
  texts: string[];
  calibrationIndexes?: number[];
}

interface OpenTextRootConfig {
  root: PromptRoot;
  sourceSet: PromptSourceSet;
  category: PromptCategory;
  texts: string[];
  maxLength: number;
  placeholder: string;
  calibrationIndexes?: number[];
}

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

const SELECT_ROOTS: SelectRootConfig[] = [
  {
    root: 'day_of_week',
    sourceSet: 'classic',
    category: 'lifestyle',
    options: ['Monday', 'Friday', 'Saturday', 'Sunday'],
    texts: [
      'Pick the best day of the week.',
      'Pick the most iconic day of the week.',
      'Pick the day of the week people mention first.',
      'Pick the most typical answer for the best day of the week.',
    ],
  },
  {
    root: 'coin_side',
    sourceSet: 'classic',
    category: 'culture',
    options: ['Heads', 'Tails'],
    texts: [
      'Pick one side of a coin.',
      'Pick the side of a coin most people say first.',
      'Pick the most iconic side of a coin.',
      'Pick the default side of a coin.',
    ],
    calibrationIndexes: [0],
  },
  {
    root: 'positive_number',
    sourceSet: 'classic',
    category: 'number',
    options: ['1', '2', '3', '5', '10', '100'],
    texts: [
      'Pick the best positive number.',
      'Pick the most iconic positive number.',
      'Pick the positive number people mention first.',
      'Pick the most typical positive number.',
    ],
    calibrationIndexes: [0],
  },
  {
    root: 'flower',
    sourceSet: 'classic',
    category: 'aesthetics',
    options: ['Rose', 'Tulip', 'Lily', 'Sunflower', 'Daisy', 'Orchid'],
    texts: [
      'Pick the most iconic flower.',
      'Pick the best-known flower.',
      'Pick the most typical flower.',
      'Pick the favourite flower.',
    ],
  },
  {
    root: 'colour',
    sourceSet: 'classic',
    category: 'aesthetics',
    options: ['Red', 'Blue', 'Green', 'Yellow', 'Black', 'White'],
    texts: [
      'Pick the most iconic color.',
      'Pick the best-known color.',
      'Pick the most typical color.',
      'Pick the favourite color.',
    ],
  },
  {
    root: 'year',
    sourceSet: 'classic',
    category: 'culture',
    options: ['1900', '1914', '1945', '1969', '2000', '2020'],
    texts: [
      'Pick the most iconic year.',
      'Pick the year people mention first.',
      'Pick the most memorable year.',
      'Pick the most typical answer for a famous year.',
    ],
  },
  {
    root: 'city_in_england',
    sourceSet: 'classic',
    category: 'culture',
    options: [
      'London',
      'Manchester',
      'Liverpool',
      'Birmingham',
      'Oxford',
      'Cambridge',
    ],
    texts: [
      'Pick the most iconic city in England.',
      'Pick the best-known city in England.',
      'Pick the city in England people mention first.',
      'Pick the most typical answer for a city in England.',
    ],
  },
  {
    root: 'nyc_meeting_place',
    sourceSet: 'classic',
    category: 'culture',
    options: [
      'Grand Central Terminal',
      'Times Square',
      'Central Park',
      'Empire State Building',
      'Penn Station',
    ],
    texts: [
      'Pick where two strangers should meet in New York City.',
      'Pick the most obvious meeting place in New York City.',
      'Pick the New York City landmark strangers would coordinate on.',
      'Pick the default place to meet a stranger in New York City.',
    ],
    calibrationIndexes: [0],
  },
  {
    root: 'nyc_meeting_time',
    sourceSet: 'classic',
    category: 'culture',
    options: ['9:00 AM', '12:00 PM', '3:00 PM', '6:00 PM', '9:00 PM'],
    texts: [
      'Pick the best time to meet a stranger.',
      'Pick the most obvious time to meet a stranger.',
      'Pick the time strangers would coordinate on first.',
      'Pick the default time to meet a stranger.',
    ],
  },
  {
    root: 'fair_split',
    sourceSet: 'classic',
    category: 'philosophy',
    options: ['40/60', '45/55', '50/50', '55/45', '60/40'],
    texts: [
      'Pick the fairest way to split 100.',
      'Pick the most natural way to split 100.',
      'Pick the split strangers would coordinate on first.',
      'Pick the default split of 100.',
    ],
    calibrationIndexes: [0],
  },
  {
    root: 'fruits',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    options: ['Apple', 'Orange', 'Banana', 'Mango', 'Pear'],
    texts: [
      'Pick the most iconic fruit.',
      'Pick the best-known fruit.',
      'Pick the most typical fruit.',
      'Pick the favourite fruit.',
    ],
  },
  {
    root: 'sports',
    sourceSet: 'later_experiment',
    category: 'culture',
    options: ['Football', 'Swimming', 'Cricket', 'Tennis', 'Rugby'],
    texts: [
      'Pick the most iconic sport.',
      'Pick the best-known sport.',
      'Pick the most typical sport.',
      'Pick the favourite sport.',
    ],
  },
  {
    root: 'furniture',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    options: ['Bed', 'Sofa', 'Table', 'Chair', 'Desk'],
    texts: [
      'Pick the most iconic piece of furniture.',
      'Pick the best-known piece of furniture.',
      'Pick the most typical piece of furniture.',
      'Pick the favourite piece of furniture.',
    ],
  },
  {
    root: 'car_manufacturers',
    sourceSet: 'later_experiment',
    category: 'culture',
    options: ['Ferrari', 'Ford', 'Mercedes', 'BMW', 'Honda'],
    texts: [
      'Pick the most iconic car manufacturer.',
      'Pick the best-known car manufacturer.',
      'Pick the most typical car manufacturer.',
      'Pick the favourite car manufacturer.',
    ],
  },
  {
    root: 'fast_food_chains',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    options: ["McDonald's", 'Subway', 'Burger King', 'Pizza Hut', 'KFC'],
    texts: [
      'Pick the most iconic fast-food chain.',
      'Pick the best-known fast-food chain.',
      'Pick the most typical fast-food chain.',
      'Pick the favourite fast-food chain.',
    ],
  },
  {
    root: 'animals',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    options: ['Dog', 'Cat', 'Lion', 'Tiger', 'Monkey'],
    texts: [
      'Pick the most iconic animal.',
      'Pick the best-known animal.',
      'Pick the most typical animal.',
      'Pick the favourite animal.',
    ],
  },
  {
    root: 'metals',
    sourceSet: 'later_experiment',
    category: 'aesthetics',
    options: ['Gold', 'Steel', 'Aluminium', 'Silver', 'Iron'],
    texts: [
      'Pick the most iconic metal.',
      'Pick the best-known metal.',
      'Pick the most typical metal.',
      'Pick the favourite metal.',
    ],
  },
  {
    root: 'means_of_transport',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    options: ['Car', 'Bus', 'Aeroplane', 'Bike', 'Train'],
    texts: [
      'Pick the most iconic means of transport.',
      'Pick the best-known means of transport.',
      'Pick the most typical means of transport.',
      'Pick the favourite means of transport.',
    ],
  },
  {
    root: 'drinks',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    options: ['Beer', 'Tea', 'Water', 'Coke', 'Juice'],
    texts: [
      'Pick the most iconic drink.',
      'Pick the best-known drink.',
      'Pick the most typical drink.',
      'Pick the favourite drink.',
    ],
  },
  {
    root: 'superheroes',
    sourceSet: 'later_experiment',
    category: 'fantasy',
    options: ['Superman', 'Batman', 'Spider-Man', 'Hulk', 'Iron Man'],
    texts: [
      'Pick the most iconic superhero.',
      'Pick the best-known superhero.',
      'Pick the most typical superhero.',
      'Pick the favourite superhero.',
    ],
  },
];

const OPEN_TEXT_ROOTS: OpenTextRootConfig[] = [
  {
    root: 'day_of_week',
    sourceSet: 'classic',
    category: 'lifestyle',
    texts: [
      'Type the answer most players will type first for the best day of the week.',
      'Type the most iconic answer for the best day of the week.',
    ],
    maxLength: 32,
    placeholder: 'e.g. Monday',
  },
  {
    root: 'positive_number',
    sourceSet: 'classic',
    category: 'number',
    texts: [
      'Type the answer most players will type first for the best positive number.',
      'Type the most iconic positive number.',
    ],
    maxLength: 32,
    placeholder: 'e.g. 1',
  },
  {
    root: 'year',
    sourceSet: 'classic',
    category: 'culture',
    texts: [
      'Type the answer most players will type first for the most iconic year.',
      'Type the most iconic year.',
    ],
    maxLength: 32,
    placeholder: 'e.g. 2000',
  },
  {
    root: 'flower',
    sourceSet: 'classic',
    category: 'aesthetics',
    texts: [
      'Type the answer most players will type first for the most iconic flower.',
      'Type the most iconic flower.',
    ],
    maxLength: 48,
    placeholder: 'e.g. Rose',
  },
  {
    root: 'colour',
    sourceSet: 'classic',
    category: 'aesthetics',
    texts: [
      'Type the answer most players will type first for the most iconic color.',
      'Type the most iconic color.',
    ],
    maxLength: 32,
    placeholder: 'e.g. Red',
  },
  {
    root: 'city_in_england',
    sourceSet: 'classic',
    category: 'culture',
    texts: [
      'Type the answer most players will type first for the most iconic city in England.',
      'Type the most iconic city in England.',
    ],
    maxLength: 64,
    placeholder: 'e.g. London',
  },
  {
    root: 'fruit',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    texts: [
      'Type the answer most players will type first for the most iconic fruit.',
      'Type the most iconic fruit.',
    ],
    maxLength: 48,
    placeholder: 'e.g. Apple',
  },
  {
    root: 'animal',
    sourceSet: 'later_experiment',
    category: 'lifestyle',
    texts: [
      'Type the answer most players will type first for the most iconic animal.',
      'Type the most iconic animal.',
    ],
    maxLength: 48,
    placeholder: 'e.g. Dog',
  },
  {
    root: 'car_manufacturer',
    sourceSet: 'later_experiment',
    category: 'culture',
    texts: [
      'Type the answer most players will type first for the most iconic car manufacturer.',
      'Type the most iconic car manufacturer.',
    ],
    maxLength: 64,
    placeholder: 'e.g. Ford',
  },
  {
    root: 'nyc_meeting_place',
    sourceSet: 'classic',
    category: 'culture',
    texts: [
      'Type the answer most players will type first for where two strangers should meet in New York City.',
      'Type the most iconic meeting place in New York City.',
    ],
    maxLength: 80,
    placeholder: 'e.g. Grand Central Terminal',
    calibrationIndexes: [0],
  },
];

function createSelectPrompt(
  id: number,
  config: SelectRootConfig,
  frameIndex: number,
): PromptCatalogRecord {
  const prompt: SelectPrompt = {
    id,
    text: config.texts[frameIndex] || config.texts[0] || 'Pick one.',
    type: 'select',
    category: config.category,
    options: [...config.options],
  };

  return {
    prompt,
    root: config.root,
    sourceSet: config.sourceSet,
    frame: config.texts[frameIndex] || config.texts[0] || '',
    audienceScope: 'broad_anglophone',
    calibration: !!config.calibrationIndexes?.includes(frameIndex),
  };
}

function createOpenTextPrompt(
  id: number,
  config: OpenTextRootConfig,
  frameIndex: number,
): PromptCatalogRecord {
  const prompt: OpenTextPrompt = {
    id,
    text: config.texts[frameIndex] || config.texts[0] || 'Type one answer.',
    type: 'open_text',
    category: config.category,
    maxLength: config.maxLength,
    placeholder: config.placeholder,
  };

  return {
    prompt,
    root: config.root,
    sourceSet: config.sourceSet,
    frame: config.texts[frameIndex] || config.texts[0] || '',
    audienceScope: 'broad_anglophone',
    calibration: !!config.calibrationIndexes?.includes(frameIndex),
  };
}

function buildCatalog(): PromptCatalogRecord[] {
  const records: PromptCatalogRecord[] = [];
  let nextId = 101;

  for (const root of SELECT_ROOTS) {
    for (let frameIndex = 0; frameIndex < root.texts.length; frameIndex += 1) {
      records.push(createSelectPrompt(nextId, root, frameIndex));
      nextId += 1;
    }
  }

  for (const root of OPEN_TEXT_ROOTS) {
    for (let frameIndex = 0; frameIndex < root.texts.length; frameIndex += 1) {
      records.push(createOpenTextPrompt(nextId, root, frameIndex));
      nextId += 1;
    }
  }

  return records;
}

const CANONICAL_PROMPT_RECORDS = buildCatalog();
const PUBLIC_PROMPT_POOL = CANONICAL_PROMPT_RECORDS.map(
  (record) => JSON.parse(JSON.stringify(record.prompt)) as SchellingPrompt,
);
const PROMPT_RECORDS_BY_ID = new Map(
  CANONICAL_PROMPT_RECORDS.map((record) => [record.prompt.id, record]),
);

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

function getFamilyFragmentationIssues(prompt: SelectPrompt): string[] {
  const optionRoots = new Map<string, string[]>();

  for (const option of prompt.options) {
    const words = normalizeWords(option).split(' ').filter(Boolean);
    for (const word of words) {
      const canonicalRoot =
        word === 'grey' ? 'gray' : word === 'fall' ? 'autumn' : word;
      if (!FAMILY_ROOTS.has(canonicalRoot)) continue;
      optionRoots.set(canonicalRoot, [
        ...(optionRoots.get(canonicalRoot) || []),
        option,
      ]);
    }
  }

  const issues: string[] = [];
  for (const [root, options] of optionRoots) {
    if (new Set(options).size < 2) continue;
    issues.push(
      `Prompt ${prompt.id} fragments the "${root}" family across multiple options (${options.join(', ')}), which breaks exact-match plurality and mixes abstraction levels.`,
    );
  }
  return issues;
}

function getPromptIssues(pool: readonly SchellingPrompt[]): string[] {
  const issues: string[] = [];

  if (pool.length !== 100) {
    issues.push(
      `Canonical prompt pool must contain exactly 100 prompts; found ${pool.length}.`,
    );
  }

  const ids = new Set<number>();
  for (const prompt of pool) {
    if (ids.has(prompt.id)) {
      issues.push(`Duplicate prompt id detected: ${prompt.id}.`);
    }
    ids.add(prompt.id);

    if (prompt.type === 'select') {
      if (prompt.options.length === 0) {
        issues.push(`Prompt ${prompt.id} must have at least one option.`);
      }

      const seenNormalized = new Map<string, string>();
      const duplicateOptions: string[] = [];
      for (const option of prompt.options) {
        const normalized = normalizeOptionIdentity(option);
        const previous = seenNormalized.get(normalized);
        if (previous) {
          duplicateOptions.push(`${previous} / ${option}`);
        } else {
          seenNormalized.set(normalized, option);
        }
      }
      if (duplicateOptions.length > 0) {
        issues.push(
          `Prompt ${prompt.id} contains duplicate normalized options: ${duplicateOptions.join(', ')}.`,
        );
      }

      issues.push(...getFamilyFragmentationIssues(prompt));
    } else {
      if (!prompt.maxLength || prompt.maxLength <= 0) {
        issues.push(`Prompt ${prompt.id} must declare a positive maxLength.`);
      }
      if (!prompt.placeholder.trim()) {
        issues.push(
          `Prompt ${prompt.id} must declare a non-empty placeholder.`,
        );
      }
    }
  }

  return issues;
}

function getRecordIssues(records: readonly PromptCatalogRecord[]): string[] {
  const issues: string[] = [];

  const selectCount = records.filter(
    (record) => record.prompt.type === 'select',
  ).length;
  const openTextCount = records.filter(
    (record) => record.prompt.type === 'open_text',
  ).length;

  if (selectCount !== 80) {
    issues.push(
      `Canonical pool must contain exactly 80 select prompts; found ${selectCount}.`,
    );
  }
  if (openTextCount !== 20) {
    issues.push(
      `Canonical pool must contain exactly 20 open_text prompts; found ${openTextCount}.`,
    );
  }

  for (const record of records) {
    if (
      !record.root ||
      !record.sourceSet ||
      !record.frame ||
      !record.audienceScope
    ) {
      issues.push(
        `Prompt ${record.prompt.id} is missing required catalog metadata.`,
      );
    }
  }

  const countsByRoot = new Map<
    PromptRoot,
    { select: number; openText: number }
  >();
  for (const record of records) {
    const entry = countsByRoot.get(record.root) || { select: 0, openText: 0 };
    if (record.prompt.type === 'select') entry.select += 1;
    else entry.openText += 1;
    countsByRoot.set(record.root, entry);
  }

  for (const config of SELECT_ROOTS) {
    const counts = countsByRoot.get(config.root);
    if ((counts?.select || 0) !== 4) {
      issues.push(
        `Select root "${config.root}" must contribute exactly 4 prompts; found ${counts?.select || 0}.`,
      );
    }
  }

  for (const config of OPEN_TEXT_ROOTS) {
    const counts = countsByRoot.get(config.root);
    if ((counts?.openText || 0) !== 2) {
      issues.push(
        `Open-text root "${config.root}" must contribute exactly 2 prompts; found ${counts?.openText || 0}.`,
      );
    }
  }

  return issues;
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

const CONTEXTUAL_ROOTS = new Set<PromptRoot>([
  'city_in_england',
  'nyc_meeting_place',
  'nyc_meeting_time',
]);

function getSelectionFamily(root: PromptRoot): string {
  switch (root) {
    case 'fruit':
    case 'fruits':
      return 'fruit';
    case 'animal':
    case 'animals':
      return 'animal';
    case 'car_manufacturer':
    case 'car_manufacturers':
      return 'car_manufacturer';
    default:
      return root;
  }
}

export function getCanonicalPromptPool(): SchellingPrompt[] {
  return JSON.parse(JSON.stringify(PUBLIC_PROMPT_POOL));
}

export function getCanonicalPromptRecords(): PromptCatalogRecord[] {
  return JSON.parse(JSON.stringify(CANONICAL_PROMPT_RECORDS));
}

export function getPromptRecordById(
  promptId: number,
): PromptCatalogRecord | undefined {
  return PROMPT_RECORDS_BY_ID.get(promptId);
}

export function selectPromptsForMatch(
  count = 10,
  options: { includeOpenText?: boolean } = {},
): SchellingPrompt[] {
  const includeOpenText = options.includeOpenText ?? true;
  const eligibleRecords = CANONICAL_PROMPT_RECORDS.filter(
    (record) => includeOpenText || record.prompt.type === 'select',
  );

  const families = shuffleInPlace([
    ...new Set(
      eligibleRecords.map((record) => getSelectionFamily(record.root)),
    ),
  ]);

  if (count > families.length) {
    throw new RangeError(
      `Requested ${count} prompts but only ${families.length} distinct prompt families are available`,
    );
  }

  const recordsByFamily = new Map<string, PromptCatalogRecord[]>();
  for (const record of eligibleRecords) {
    const family = getSelectionFamily(record.root);
    recordsByFamily.set(family, [
      ...(recordsByFamily.get(family) || []),
      record,
    ]);
  }

  const selected: PromptCatalogRecord[] = [];
  let openTextCount = 0;
  let calibrationCount = 0;
  const contextualFamiliesPicked = new Set<string>();

  for (const family of families) {
    if (selected.length >= count) break;

    const group = shuffleInPlace([...(recordsByFamily.get(family) || [])]);
    const candidate = group.find((record) => {
      if (record.prompt.type === 'open_text' && openTextCount >= 2) {
        return false;
      }
      if (record.calibration && calibrationCount >= 1) {
        return false;
      }
      if (CONTEXTUAL_ROOTS.has(record.root)) {
        return !contextualFamiliesPicked.has(family);
      }
      return true;
    });

    if (!candidate) continue;
    selected.push(candidate);
    if (candidate.prompt.type === 'open_text') openTextCount += 1;
    if (candidate.calibration) calibrationCount += 1;
    if (CONTEXTUAL_ROOTS.has(candidate.root)) {
      contextualFamiliesPicked.add(family);
    }
  }

  if (selected.length !== count) {
    throw new RangeError(
      `Unable to satisfy a ${count}-prompt balanced selection from the canonical pool`,
    );
  }

  return shuffleInPlace([...selected]).map(
    (record) => JSON.parse(JSON.stringify(record.prompt)) as SchellingPrompt,
  );
}

export function getPromptPoolQualityIssues(
  pool: readonly SchellingPrompt[] = PUBLIC_PROMPT_POOL,
): string[] {
  const issues = getPromptIssues(pool);
  if (pool === PUBLIC_PROMPT_POOL) {
    issues.push(...getRecordIssues(CANONICAL_PROMPT_RECORDS));
  }
  return issues;
}

export function validatePromptPool(
  pool: readonly SchellingPrompt[] = PUBLIC_PROMPT_POOL,
): boolean {
  return getPromptPoolQualityIssues(pool).length === 0;
}

export default PUBLIC_PROMPT_POOL;

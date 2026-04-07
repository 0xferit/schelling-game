import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WRANGLER_TOML_PATH = join(REPO_ROOT, 'wrangler.toml');
const DEFAULT_TARGET_TASKS = [
  'Text Generation',
  'Text Classification',
  'Translation',
];
const DEFAULT_POOL_SIZE = 4;
const SUPPORTED_AI_BOT_MODELS = new Map([
  ['@cf/openai/gpt-oss-20b', 'prompt_only'],
  ['@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'response_format'],
  ['@cf/qwen/qwq-32b', 'guided_json'],
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'guided_json'],
]);

function getTargetTasks() {
  const raw = process.env.AI_BOT_CATALOG_TASKS?.trim();
  if (!raw) return DEFAULT_TARGET_TASKS;
  const tasks = raw
    .split(',')
    .map((task) => task.trim())
    .filter(Boolean);
  return tasks.length > 0 ? tasks : DEFAULT_TARGET_TASKS;
}

function getPoolSize() {
  const raw = Number.parseInt(process.env.AI_BOT_POOL_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_POOL_SIZE;
  }
  return raw;
}

function parseCreatedAt(value) {
  const normalized = value?.trim().replace(' ', 'T');
  if (!normalized) return 0;
  const timestamp = Date.parse(`${normalized}Z`);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function propertyMap(model) {
  return new Map(
    (model.properties || []).map((property) => [
      property.property_id,
      property.value,
    ]),
  );
}

function loadCatalog() {
  const raw = execFileSync('npx', ['wrangler', 'ai', 'models', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(raw);
}

function selectCompatibleModels(catalog, targetTasks, poolSize) {
  const deduped = new Map();

  for (const model of catalog) {
    if (!targetTasks.includes(model.task?.name || '')) continue;
    if (!SUPPORTED_AI_BOT_MODELS.has(model.name)) continue;

    const properties = propertyMap(model);
    if (properties.get('beta') === 'true') continue;
    if (properties.has('planned_deprecation_date')) continue;

    const existing = deduped.get(model.name);
    if (
      !existing ||
      parseCreatedAt(model.created_at) > parseCreatedAt(existing.created_at)
    ) {
      deduped.set(model.name, model);
    }
  }

  return [...deduped.values()]
    .sort((left, right) => parseCreatedAt(right.created_at) - parseCreatedAt(left.created_at))
    .slice(0, poolSize);
}

function updateWranglerToml(content, modelsValue, modesValue) {
  const lines = content.split('\n');
  const updated = [];
  let replacements = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith('AI_BOT_MODELS = ')) {
      updated.push(`AI_BOT_MODELS = "${modelsValue}"`);
      replacements += 1;

      const nextLine = lines[index + 1] || '';
      if (nextLine.startsWith('AI_BOT_MODEL_OUTPUT_MODES = ')) {
        updated.push(`AI_BOT_MODEL_OUTPUT_MODES = "${modesValue}"`);
        index += 1;
      } else {
        updated.push(`AI_BOT_MODEL_OUTPUT_MODES = "${modesValue}"`);
      }
      continue;
    }

    if (line.startsWith('AI_BOT_MODEL_OUTPUT_MODES = ')) {
      continue;
    }

    updated.push(line);
  }

  if (replacements === 0) {
    throw new Error('Could not find any AI_BOT_MODELS entries in wrangler.toml');
  }

  return updated.join('\n');
}

function main() {
  const targetTasks = getTargetTasks();
  const poolSize = getPoolSize();
  const catalog = loadCatalog();
  const selectedModels = selectCompatibleModels(catalog, targetTasks, poolSize);

  if (selectedModels.length < poolSize) {
    throw new Error(
      `Expected ${poolSize} supported AI bot models from tasks ${targetTasks.join(', ')}, found ${selectedModels.length}`,
    );
  }

  const modelsValue = selectedModels.map((model) => model.name).join(',');
  const modesValue = selectedModels
    .map((model) => `${model.name}=${SUPPORTED_AI_BOT_MODELS.get(model.name)}`)
    .join(',');

  const wranglerToml = readFileSync(WRANGLER_TOML_PATH, 'utf8');
  const updatedWranglerToml = updateWranglerToml(
    wranglerToml,
    modelsValue,
    modesValue,
  );

  if (updatedWranglerToml !== wranglerToml) {
    writeFileSync(WRANGLER_TOML_PATH, updatedWranglerToml);
  }

  console.log('Selected AI bot model pool:');
  for (const model of selectedModels) {
    console.log(
      `- ${model.name} | task=${model.task?.name || 'unknown'} | created_at=${model.created_at} | mode=${SUPPORTED_AI_BOT_MODELS.get(model.name)}`,
    );
  }
}

main();

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
const FETCH_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `You are playing a coordination game. All players see the same question \
and options. You win by picking the option most other players will pick. \
Pick the most obvious, stereotypical, default choice that a random person \
would gravitate toward.`;

interface OllamaResponse {
  response: string;
}

function randomIndex(optionCount: number): number {
  return Math.floor(Math.random() * optionCount);
}

export async function pickOption(
  questionText: string,
  options: string[],
  model: string,
  ollamaUrl = OLLAMA_DEFAULT_URL,
): Promise<number> {
  const numberedOptions = options
    .map((opt, i) => `${i + 1}. ${opt}`)
    .join('\n');

  const userPrompt = `Question: ${questionText}\nOptions:\n${numberedOptions}\n\nReply with ONLY the number of your choice (e.g. "3"). Nothing else.`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        model,
        prompt: userPrompt,
        system: SYSTEM_PROMPT,
        stream: false,
      }),
    });

    if (!res.ok) {
      console.error(`[strategy] ollama returned ${res.status}, using random`);
      return randomIndex(options.length);
    }

    const data = (await res.json()) as OllamaResponse;
    return parseChoice(data.response, options.length);
  } catch (err) {
    const reason =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'timed out'
        : String(err);
    console.error(`[strategy] ollama ${reason}, using random`);
    return randomIndex(options.length);
  } finally {
    clearTimeout(timer);
  }
}

function parseChoice(raw: string, optionCount: number): number {
  const match = raw.trim().match(/^\s*(\d+)/);
  if (!match) {
    console.error(`[strategy] unparseable response: "${raw}", using random`);
    return randomIndex(optionCount);
  }

  const oneIndexed = parseInt(match[1], 10);
  if (oneIndexed < 1 || oneIndexed > optionCount) {
    console.error(
      `[strategy] out of range: ${oneIndexed} (max ${optionCount}), using random`,
    );
    return randomIndex(optionCount);
  }

  return oneIndexed - 1;
}

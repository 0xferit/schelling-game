const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

const SYSTEM_PROMPT = `You are playing a coordination game. All players see the same question \
and options. You win by picking the option most other players will pick. \
Pick the most obvious, stereotypical, default choice that a random person \
would gravitate toward.`;

interface OllamaResponse {
  response: string;
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

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: userPrompt,
        system: SYSTEM_PROMPT,
        stream: false,
      }),
    });

    if (!res.ok) {
      console.error(`[strategy] ollama returned ${res.status}`);
      return 0;
    }

    const data = (await res.json()) as OllamaResponse;
    return parseChoice(data.response, options.length);
  } catch (err) {
    console.error(`[strategy] ollama unreachable: ${err}`);
    return 0;
  }
}

function parseChoice(raw: string, optionCount: number): number {
  const match = raw.match(/\d+/);
  if (!match) return 0;

  const oneIndexed = parseInt(match[0], 10);
  if (oneIndexed < 1 || oneIndexed > optionCount) return 0;

  return oneIndexed - 1;
}

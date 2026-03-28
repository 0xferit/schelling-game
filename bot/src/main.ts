import { parseArgs } from 'node:util';
import { GameClient, type RoundLog } from './client.js';

const { values } = parseArgs({
  options: {
    server: { type: 'string', short: 's' },
    model: { type: 'string', short: 'm', default: 'gemma3:1b' },
    ollama: { type: 'string', default: 'http://localhost:11434' },
    loop: { type: 'boolean', default: false },
    key: { type: 'string' },
    name: { type: 'string', short: 'n' },
  },
  strict: true,
});

if (!values.server) {
  console.error('Usage: tsx bot/src/main.ts --server <url> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --server, -s  Game server URL (required)');
  console.error('  --model, -m   Ollama model name (default: gemma3:1b)');
  console.error(
    '  --ollama      Ollama API URL (default: http://localhost:11434)',
  );
  console.error('  --loop        Re-queue after each match');
  console.error(
    '  --key         Wallet private key hex (generates random if omitted)',
  );
  console.error(
    '  --name, -n    Display name (generates bot-{hex} if omitted)',
  );
  process.exit(1);
}

function logRound(entry: RoundLog): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const client = new GameClient({
  serverUrl: values.server,
  model: values.model ?? 'gemma3:1b',
  ollamaUrl: values.ollama,
  loop: values.loop ?? false,
  privateKey: values.key,
  displayName: values.name,
  onRoundLog: logRound,
});

client.start().catch((err) => {
  console.error(`[bot] fatal: ${err}`);
  process.exit(1);
});

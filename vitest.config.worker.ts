import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, 'd1-migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        // Keep worker tests hermetic and CI-friendly. Staging validation runs
        // in a separate workflow job against a deployed Worker.
        remoteBindings: false,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ['test/worker/**/*.test.ts'],
      setupFiles: ['./test/worker/apply-migrations.ts'],
    },
  };
});

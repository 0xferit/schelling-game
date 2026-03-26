import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';

// Augment Cloudflare.Env so `env` is typed with our bindings.
// TEST_MIGRATIONS is injected by vitest.config.worker.ts.
declare module 'cloudflare:workers' {
  interface Cloudflare {
    Env: {
      DB: D1Database;
      GAME_ROOM: DurableObjectNamespace;
      TEST_MIGRATIONS: import('@cloudflare/vitest-pool-workers').D1Migration[];
    };
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

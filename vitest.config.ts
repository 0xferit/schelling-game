import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/domain/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts'],
      thresholds: {
        perFile: true,
        branches: 80,
        functions: 80,
      },
    },
  },
});

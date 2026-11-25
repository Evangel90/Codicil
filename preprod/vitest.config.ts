import { defineConfig } from 'vitest/config';

// Unit tests only: nothing here opens a network connection. The live checks
// are the CLI commands (`npm run preprod:check` and friends), which are opt-in.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
  },
});

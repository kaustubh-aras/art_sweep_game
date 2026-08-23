import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Server tests run against an in-memory Redis. Aliasing the Devvit server
 * package is what makes that possible — the real one refuses to work outside
 * the Devvit runtime, so there is nothing to test against without this swap.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@devvit\/web\/server$/,
        replacement: fileURLToPath(new URL('./tests/devServerMock.ts', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});

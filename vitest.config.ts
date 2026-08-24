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
      {
        // The client package resolves to a "you imported this on the server"
        // stub outside a browser build. The web-view tests need the real
        // implementation — they exist to check what it puts on the wire — so
        // they get the browser entry point Vite would have chosen.
        find: /^@devvit\/web\/client$/,
        replacement: fileURLToPath(new URL('./node_modules/@devvit/client/index.js', import.meta.url)),
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

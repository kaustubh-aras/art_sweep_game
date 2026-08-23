import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { fileURLToPath, URL } from 'node:url';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/**
 * Builds a runnable local server from the REAL `src/server/index.ts`, with the
 * Devvit runtime swapped for an in-memory stand-in. Used for browser testing
 * and offline development — it is never shipped.
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
  ssr: { target: 'node', noExternal: true },
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist/devserver',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: nodeBuiltins,
      output: { format: 'cjs', entryFileNames: 'index.cjs', inlineDynamicImports: true },
    },
  },
});

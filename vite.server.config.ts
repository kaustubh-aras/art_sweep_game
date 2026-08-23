import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { fileURLToPath, URL } from 'node:url';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/**
 * Server bundle. Devvit requires a single self-contained CommonJS file whose
 * only bare imports are Node built-ins, so everything from node_modules is
 * inlined (`ssr.noExternal`) and dynamic imports are flattened into the one
 * chunk.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  ssr: {
    target: 'node',
    noExternal: true,
  },
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node22',
    minify: false, // app review reads this bundle; keep it legible
    rollupOptions: {
      external: nodeBuiltins,
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
        inlineDynamicImports: true,
      },
    },
  },
});

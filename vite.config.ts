import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Client bundle. This directory is the Devvit Web webroot (`post.dir` in
// devvit.json) — every file in it is uploaded and served to the web view.
export default defineConfig({
  base: './',
  // SWEEP ships no image or audio files — every texture and sound is generated
  // at runtime. `public/` holds only leftovers from the earlier Trapmaker
  // prototype, and nothing orphaned should be uploaded to Reddit.
  publicDir: false,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    outDir: 'dist/client',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    open: true,
    host: true, // expose on LAN so a phone on the same WiFi can connect
    /**
     * Send the API to the local dev server.
     *
     * Without this, Vite answers `/api/state` with its own SPA fallback — HTTP
     * 200 and a page of HTML — so `res.json()` throws in `net.ts` and the game
     * boots straight into the DISCONNECTED screen. It looks like a network
     * fault and is really a missing route, which is a genuinely confusing first
     * five minutes for anyone who cloned the repo and ran `npm run dev`.
     *
     * This needs `node dist/devserver/index.cjs` running alongside. To play
     * without a second process, skip Vite entirely: the dev server serves the
     * built client and the API on one origin (see the README).
     */
    proxy: {
      '/api': { target: 'http://localhost:39700', changeOrigin: true },
      '/internal': { target: 'http://localhost:39700', changeOrigin: true },
    },
  },
});

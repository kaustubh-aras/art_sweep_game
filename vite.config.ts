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
  },
});

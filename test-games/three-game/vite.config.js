import { defineConfig } from 'vite';
import jsgame from '../vite-plugin-jsgame.js';

// Build a single, stably-named ES-module bundle so both the browser
// (dist/index.html) and the libretro core (package.json "main") can load the
// same artifact. Three.js is bundled in — no bare specifiers survive the build,
// which is what jsgame-libretro's loader requires (it does not resolve bare
// specifiers; "bundle your game"). The jsgame plugin packs dist/ into a
// .jsgame after the build.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      output: {
        entryFileNames: 'three-game.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  plugins: [jsgame()],
});

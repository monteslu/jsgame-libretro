import { defineConfig } from 'vite';
import jsgame from '../vite-plugin-jsgame.js';

// box2d3-wasm deluxe (threaded) build. The deluxe module has an emscripten
// pthread Worker that must stay a real on-disk file (shipped via copy-wasm to
// public/ -> dist root); mark it external so vite never bundles/parses it. The
// core runs emscripten wasm pthreads via native worker_threads. lib mode keeps
// the dynamic import root-relative (./Box2D.deluxe.mjs, not ./src/...).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022', outDir: 'dist', emptyOutDir: true, copyPublicDir: true,
    lib: { entry: 'src/main.js', formats: ['es'], fileName: () => 'box2d-physics.js' },
    rollupOptions: { external: [/Box2D\.deluxe\.mjs$/], output: { inlineDynamicImports: true, assetFileNames: '[name][extname]' } },
  },
  plugins: [jsgame()],
});

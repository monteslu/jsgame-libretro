import { defineConfig } from 'vite';
import jsgame from '../vite-plugin-jsgame.js';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: { output: {
      entryFileNames: 'audio-test.js',
      chunkFileNames: '[name].js',
      assetFileNames: '[name][extname]',
    } },
  },
  plugins: [jsgame()],
});

#!/usr/bin/env node
// One-shot: restructure a flat test-game (main.js + assets at root) into the
// vite template — src/main.js, index.html, vite.config.js, package.json with a
// "main" + the shared jsgame pack plugin. Idempotent-ish: skips if src/ exists.
//
// Usage: node _convert.mjs <game> <canvasId> [asset1 asset2 ...]
//   assets: files/dirs to move into public/ (copied verbatim to dist root)
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [game, canvasId = 'c', ...assets] = process.argv.slice(2);
if (!game) { console.error('usage: node _convert.mjs <game> <canvasId> [assets...]'); process.exit(1); }
const dir = join(process.cwd(), game);
if (!existsSync(dir)) { console.error(`no such game dir: ${dir}`); process.exit(1); }
if (existsSync(join(dir, 'src'))) { console.log(`${game}: already has src/, skipping`); process.exit(0); }

// 1. main.js -> src/main.js
mkdirSync(join(dir, 'src'), { recursive: true });
renameSync(join(dir, 'main.js'), join(dir, 'src', 'main.js'));

// 2. assets -> public/
if (assets.length) {
  mkdirSync(join(dir, 'public'), { recursive: true });
  for (const a of assets) {
    const from = join(dir, a), to = join(dir, 'public', a);
    if (existsSync(from)) renameSync(from, to);
    else console.log(`  (asset ${a} not found, skipping)`);
  }
}

// 3. index.html
writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${game}</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%;
      display: flex; justify-content: center; align-items: center;
      background-color: #000; overflow: hidden; }
    canvas { display: block; }
  </style>
</head>
<body>
  <canvas id="${canvasId}" width="640" height="480"></canvas>
  <script>
    // Scale to window (letterbox), browser-only fullscreen on click. The core
    // ignores both — its frontend owns the window.
    const canvas = document.getElementById('${canvasId}');
    function resizeCanvas() {
      const ar = canvas.width / canvas.height, ww = innerWidth, wh = innerHeight;
      if (ww / wh > ar) { canvas.style.width = wh * ar + 'px'; canvas.style.height = wh + 'px'; }
      else { canvas.style.width = ww + 'px'; canvas.style.height = ww / ar + 'px'; }
    }
    addEventListener('resize', resizeCanvas); resizeCanvas();
    canvas.addEventListener('click', () =>
      document.fullscreenElement ? document.exitFullscreen?.() : canvas.requestFullscreen?.());
  </script>
  <script src="./src/main.js" type="module"></script>
</body>
</html>
`);

// 4. vite.config.js (imports the shared plugin one level up)
writeFileSync(join(dir, 'vite.config.js'), `import { defineConfig } from 'vite';
import jsgame from '../vite-plugin-jsgame.js';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: { output: {
      entryFileNames: '${game}.js',
      chunkFileNames: '[name].js',
      assetFileNames: '[name][extname]',
    } },
  },
  plugins: [jsgame()],
});
`);

// 5. package.json — preserve existing deps, add vite+fflate, set main+scripts
let pkg = {};
try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch {}
pkg.name = pkg.name || game;
pkg.version = pkg.version || '1.0.0';
pkg.type = 'module';
pkg.main = `dist/${game}.js`;
pkg.scripts = { dev: 'vite', build: 'vite build', pack: 'vite build', preview: 'vite preview' };
pkg.devDependencies = { ...(pkg.devDependencies || {}), fflate: '^0.8.3', vite: '^8.0.16' };
writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

console.log(`${game}: converted (canvas #${canvasId}${assets.length ? ', assets: ' + assets.join(',') : ''})`);

// content.js — content access layer: a game is a directory tree (dir mode via
// .jsg marker, zip mode via .jsgame archive). All game/asset reads go through
// here; the game realm never touches fs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const fflate = require('./vendor/fflate.js');

/**
 * @param {string} contentPath path the frontend loaded (.jsg or .jsgame)
 * @returns {{ name: string, read: (rel: string) => Buffer|null,
 *             exists: (rel: string) => boolean, asset: (rel: string) => Buffer|null }}
 */
function createContent(contentPath) {
  const lc = contentPath.toLowerCase();
  if (lc.endsWith('.jsgame') || lc.endsWith('.zip')) return zipContent(contentPath);
  return dirContent(path.dirname(contentPath), path.basename(contentPath, '.jsg'));
}

function normalize(rel) {
  // realm-supplied paths: strip leading ./ and /, forbid escaping the root
  let p = String(rel).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function dirContent(root, name) {
  const hasPublic = fs.existsSync(path.join(root, 'public'));
  const read = (rel) => {
    const p = normalize(rel);
    if (p === null) return null;
    try { return fs.readFileSync(path.join(root, p)); } catch { return null; }
  };
  return {
    name,
    root,
    isZip: false,
    read,
    exists: (rel) => read(rel) !== null,
    // vite convention: static assets live in public/ and are addressed from root
    asset: (rel) => (hasPublic ? read('public/' + normalize(rel)) ?? read(rel) : read(rel)),
  };
}

function zipContent(zipPath) {
  const raw = fs.readFileSync(zipPath);
  const files = fflate.unzipSync(raw);
  // tolerate a single top-level folder wrapping the game tree
  const names = Object.keys(files).filter((n) => !n.endsWith('/'));
  let prefix = '';
  if (names.length > 0) {
    const first = names[0].split('/')[0] + '/';
    if (names.every((n) => n.startsWith(first))) prefix = first;
  }
  const hasPublic = names.some((n) => n.startsWith(prefix + 'public/'));

  // Extract the game tree to a real temp dir (content-addressed by a hash of the
  // zip, so re-runs reuse it). A real on-disk root is required for emscripten
  // wasm pthreads: the module's `new Worker(new URL('X.mjs', import.meta.url))`
  // and native worker_threads need a real file:// path, not an in-memory blob.
  // It also lets the realm's module loader resolve from disk. Reads still go
  // through the in-memory `files` map (fast, no fs round-trip).
  let root = null;
  try {
    const PREFIX = 'jsgame-content-';
    const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
    const dir = path.join(os.tmpdir(), PREFIX + hash);
    const stamp = path.join(dir, '.extracted');
    if (!fs.existsSync(stamp)) {
      // Prune old extractions before adding a new one so /tmp (a quota'd tmpfs
      // on some hosts) doesn't grow unbounded across different games. Keep the
      // most-recently-used few; drop the rest. Best-effort, never fatal.
      try {
        const KEEP = 6;
        const dirs = fs.readdirSync(os.tmpdir())
          .filter((n) => n.startsWith(PREFIX))
          .map((n) => { const p = path.join(os.tmpdir(), n); let mt = 0; try { mt = fs.statSync(p).mtimeMs; } catch {} return { p, mt }; })
          .sort((a, b) => b.mt - a.mt);
        for (const { p } of dirs.slice(KEEP)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
      } catch {}
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith('/')) continue;
        const rel = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
        if (!rel) continue;
        const dst = path.join(dir, rel);
        if (!path.resolve(dst).startsWith(path.resolve(dir))) continue; // zip-slip guard
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
      fs.writeFileSync(stamp, '');
    } else {
      try { fs.utimesSync(dir, new Date(), new Date()); } catch {} // mark as recently used
    }
    root = dir;
  } catch (e) {
    // Extraction is best-effort: if it fails, fall back to in-memory reads
    // (non-threaded games still work; threaded wasm needs the disk root).
    root = null;
  }

  const read = (rel) => {
    const p = normalize(rel);
    if (p === null) return null;
    const data = files[prefix + p];
    return data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  };
  return {
    name: path.basename(zipPath, path.extname(zipPath)),
    root,
    isZip: true,
    zipPath,
    read,
    exists: (rel) => read(rel) !== null,
    asset: (rel) => (hasPublic ? read('public/' + normalize(rel)) ?? read(rel) : read(rel)),
  };
}

// Entry resolution — same order as jsgamelauncher (minus auto-npm-install)
function resolveEntry(content) {
  const pkg = content.read('package.json');
  if (pkg) {
    try {
      const main = JSON.parse(pkg.toString()).main;
      if (main && content.exists(main)) return normalize(main);
    } catch { /* fall through */ }
  }
  const tryOrder = ['main.js', 'src/main.js', 'index.js', 'src/index.js', 'game.js', 'src/game.js'];
  for (const p of tryOrder) if (content.exists(p)) return p;
  return null;
}

module.exports = { createContent, resolveEntry, normalize };

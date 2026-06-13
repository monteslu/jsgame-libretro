// content.js — content access layer: a game is a directory tree (dir mode via
// .jsg marker, zip mode via .jsgame archive). All game/asset reads go through
// here; the game realm never touches fs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
  const files = fflate.unzipSync(fs.readFileSync(zipPath));
  // tolerate a single top-level folder wrapping the game tree
  const names = Object.keys(files).filter((n) => !n.endsWith('/'));
  let prefix = '';
  if (names.length > 0) {
    const first = names[0].split('/')[0] + '/';
    if (names.every((n) => n.startsWith(first))) prefix = first;
  }
  const hasPublic = names.some((n) => n.startsWith(prefix + 'public/'));
  const read = (rel) => {
    const p = normalize(rel);
    if (p === null) return null;
    const data = files[prefix + p];
    return data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  };
  return {
    name: path.basename(zipPath, path.extname(zipPath)),
    root: null,
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

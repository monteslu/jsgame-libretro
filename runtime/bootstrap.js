// bootstrap.js — privileged runtime entry. Full Node available HERE only;
// game code runs in the curated realm (realm.js).
'use strict';

const io = process._linkedBinding('jsgame_io');
const log = (...a) => io.log(1, a.join(' '));
const logErr = (...a) => io.log(3, a.join(' '));

process.on('uncaughtException', (err) => {
  logErr('uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
});
process.on('unhandledRejection', (err) => {
  logErr('unhandledRejection: ' + (err && err.stack ? err.stack : String(err)));
});

const canvasLib = require('./vendor/canvas/index.js');
const { createContent, resolveEntry } = require('./content.js');
const { buildRealm } = require('./realm.js');

const contentPath = globalThis.__jsg_paths.content;
const content = createContent(contentPath);

// Optional per-game config in the .jsg/.jsgame (JSON: {width, height})
let width = 640, height = 480;
try {
  const marker = require('node:fs').readFileSync(contentPath, 'utf8');
  const cfg = JSON.parse(marker);
  if (cfg.width > 0 && cfg.width <= 1920) width = cfg.width | 0;
  if (cfg.height > 0 && cfg.height <= 1080) height = cfg.height | 0;
} catch { /* empty/non-JSON marker = defaults */ }

log(`content: ${content.name} (${width}x${height})`);

const realm = buildRealm({ content, io, canvasLib, width, height, log, logErr });

const entry = resolveEntry(content);
if (!entry) {
  logErr('no game entry found (package.json main / main.js / src/main.js / ...)');
} else {
  log('entry: ' + entry);
  realm.runEntry(entry).then(
    () => log('entry evaluated'),
    (err) => logErr('entry failed: ' + (err && err.stack ? err.stack : String(err)))
  );
}

let frame = 0;

globalThis.__jsg_frame = () => {
  frame++;
  realm.fireFrame(io.getPads());

  const canvas = realm.displayCanvas;
  io.present(canvas.data(), canvas.width, canvas.height);

  if (frame === Number(process.env.JSGAME_DUMP_FRAME || 0) && process.env.JSGAME_DUMP_PNG) {
    try {
      require('node:fs').writeFileSync(process.env.JSGAME_DUMP_PNG, canvas.encodeSync('png'));
      log('dumped frame ' + frame + ' to ' + process.env.JSGAME_DUMP_PNG);
    } catch (e) {
      logErr('png dump failed: ' + e.message);
    }
  }
};

globalThis.__jsg_stop = () => log('stop');
globalThis.__jsg_start = (p) => log('restart: ' + p);

log('bootstrap ready');

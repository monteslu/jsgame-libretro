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

const FRAMES_PER_TICK = 800; // 48000 / 60

const entry = resolveEntry(content);
if (!entry) {
  logErr('no game entry found (package.json main / main.js / src/main.js / ...)');
} else {
  log('entry: ' + entry);
  // Real WebAudio first (ESM vendor; engine is WASM running in this V8) so a
  // game constructing AudioContext at boot gets the real engine, not the stub.
  import('./vendor/webaudio/LibretroAudioContext.js')
    .then((m) => {
      realm.setAudioContextClass(m.LibretroAudioContext);
      log('webaudio engine ready');
    })
    .catch((e) => logErr('webaudio init failed (stub stays): ' + e.message))
    .then(() => realm.runEntry(entry))
    .then(
      () => log('entry evaluated'),
      (err) => logErr('entry failed: ' + (err && err.stack ? err.stack : String(err)))
    );
}

let frame = 0;

globalThis.__jsg_frame = () => {
  frame++;
  realm.fireFrame(io.getPads());

  const audio = realm.pullAudio(FRAMES_PER_TICK);
  if (audio) io.pushAudio(audio);

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

// S3 spike: worker_threads under the embedded env + linked bindings in workers
if (process.env.JSGAME_TEST_WORKERS) {
  const { Worker } = require('node:worker_threads');
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  const w = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     let canvasOk = false, drawOk = false;
     try {
       const b = process._linkedBinding('canvas');
       canvasOk = typeof b.CanvasElement === 'function';
       const c = new b.CanvasElement(32, 32);
       const x = c.getContext('2d');
       x.fillStyle = '#ff0000'; x.fillRect(0, 0, 32, 32);
       drawOk = c.data()[0] === 255;
     } catch (e) { parentPort.postMessage({ err: e.message }); }
     new Int32Array(workerData.sab)[0] = 42;
     parentPort.postMessage({ canvasOk, drawOk });`,
    { eval: true, workerData: { sab } }
  );
  w.on('message', (m) => {
    log('S3 worker result: ' + JSON.stringify(m) + ' sab=' + view[0]);
    w.terminate();
  });
  w.on('error', (e) => logErr('S3 worker error: ' + e.message));
}

log('bootstrap ready');

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

// package.json is the manifest (entry = its "main", resolved in content.js).
// Sizing/network are OPTIONAL and default sensibly — no config field required.
// Overrides may live in a "jsgame" block in package.json, or in the .jsg marker
// (which is otherwise an empty pointer, like ScummVM's .scummvm). Marker wins.
let width = 640, height = 480;
let netPolicy = 'off';  // off | websocket | full (sandbox default; opt in per game)
function applyCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  if (cfg.width > 0 && cfg.width <= 3840) width = cfg.width | 0;
  if (cfg.height > 0 && cfg.height <= 2160) height = cfg.height | 0;
  if (cfg.network) netPolicy = String(cfg.network);
}
try {
  const pkg = content.read('package.json');
  if (pkg) applyCfg(JSON.parse(pkg.toString()).jsgame);
} catch { /* no/invalid package.json jsgame block = defaults */ }
try {
  // Marker-file mode: contentPath is the .jsg marker; it may hold override JSON.
  // Directory mode: contentPath is the dir (config comes from package.json above;
  // readFileSync of a dir throws → caught). Zip mode: the archive isn't JSON →
  // caught. So .jsg config is optional and only applies when a marker was passed.
  applyCfg(JSON.parse(require('node:fs').readFileSync(contentPath, 'utf8')));
} catch { /* directory / empty marker / archive = keep package.json/defaults */ }

log(`content: ${content.name} (${width}x${height})`);

const realm = buildRealm({ content, io, canvasLib, width, height, log, logErr, netPolicy, runtimeDir: globalThis.__jsg_paths.runtime });

const FRAMES_PER_TICK = 800; // 48000 / 60

const entry = resolveEntry(content);
if (!entry) {
  logErr('no game entry found (package.json main / main.js / src/main.js / ...)');
} else {
  log('entry: ' + entry);
  // __jsg_begin runs the entry — the CORE calls it (from retro_run) once GL is
  // ready (context_reset has fired), or immediately for software. This avoids
  // getContext('webgl2') racing ahead of the frontend's async context grant.
  let begun = false;
  globalThis.__jsg_begin = () => {
    if (begun) return; begun = true;
    Promise.all([
      import('./vendor/webaudio/LibretroAudioContext.js')
        .then((m) => { realm.setAudioContextClass(m.LibretroAudioContext); log('webaudio engine ready'); })
        .catch((e) => logErr('webaudio init failed (stub stays): ' + e.message)),
      import('./vendor/webgl/webgl2-context.mjs')
        .then((m) => { realm.setWebGL2Class(m.WebGL2RenderingContext); log('webgl2 ready'); })
        .catch((e) => logErr('webgl2 init failed: ' + e.message)),
    ])
      .then(() => realm.runEntry(entry))
      .then(
        () => log('entry evaluated'),
        (err) => logErr('entry failed: ' + (err && err.stack ? err.stack : String(err)))
      );
  };
}

let frame = 0;
let audioPrimed = false;
let tCb = 0, tAudio = 0, tPresent = 0, tMax = 0, slowFrames = 0;
const { performance: hostPerf } = require('node:perf_hooks');

// Audio must run at real wall-clock rate, like a browser's AudioContext —
// NOT a fixed 800 frames per video frame. If we always render 800/frame, then
// audio rate = fps * 800, so a slow/fast/jittery video frame rate makes audio
// play at the wrong speed with gaps (choppy). Instead, render exactly the
// number of frames that real elapsed time demands (elapsed_sec * 48000). The
// frontend's audio buffer + audio_sync absorb the small per-frame variance.
const SAMPLE_RATE = 48000;
let audioClockMs = 0;        // wall-clock anchor for audio production
let audioDebt = 0;           // fractional-frame carry so we never drift

globalThis.__jsg_frame = () => {
  frame++;
  const t0 = hostPerf.now();
  realm.fireFrame(io.getPads());
  const t1 = hostPerf.now();

  // How many audio frames does real elapsed time call for this tick?
  if (audioClockMs === 0) audioClockMs = t1;
  const elapsedMs = t1 - audioClockMs;
  audioClockMs = t1;
  let want = elapsedMs * (SAMPLE_RATE / 1000) + audioDebt;
  let nFrames = Math.floor(want);
  audioDebt = want - nFrames;
  // Clamp: never render a giant burst (first frame / hitch / pause) or zero.
  if (nFrames < 1) nFrames = 1;
  if (nFrames > 4096) { nFrames = 4096; audioDebt = 0; }

  const audio = realm.pullAudio(nFrames);
  if (audio) io.pushAudio(audio);
  const t2 = hostPerf.now();

  // Present the canvas the game treats as its screen. If that canvas is
  // GL-backed, the game rendered into the HW framebuffer — tell the core to
  // present that. Otherwise it's a software (Skia) raster, so hand over the
  // pixels — even if a GL context exists on some OTHER (offscreen) canvas that
  // the game composited from. The display canvas is the source of truth.
  const canvas = realm.displayCanvas;
  const displayIsGL = !!canvas._isWebGL;
  if (io.setDisplayGL) io.setDisplayGL(displayIsGL);
  if (!displayIsGL) {
    // GPU-composite path: if the display is a 2D canvas backed by a GPU (Ganesh)
    // surface (set up in 3D-composite mode), its pixels already live in a GL
    // texture — flush GPU work and present that texture directly (GPU->GPU, NO
    // readback). Falls back to the CPU raster present when not GPU-backed.
    // GPU-composite: scene is its own opaque texture; the HUD is the Skia
    // surface (transparent + fillText), flushed to its texture. Present blits
    // the scene then alpha-blends the HUD on top — all GPU->GPU, no readback.
    let sceneTex = canvas._isGpu2D ? (canvas._sceneTex || 0) : 0;
    let hudTex = 0;
    if (canvas._isGpu2D && canvas.jsgGpuFlush) hudTex = canvas.jsgGpuFlush();
    if (!globalThis.__gpuPresentLogged && canvas._isGpu2D) { globalThis.__gpuPresentLogged = 1; log('[gpu] present scene=' + sceneTex + ' hud=' + hudTex); }
    if (sceneTex && io.presentGpuComposite) {
      io.presentGpuComposite(sceneTex, hudTex, canvas.width, canvas.height);
      canvas._sceneTex = 0;
    } else {
      io.present(canvas.data(), canvas.width, canvas.height);
    }
  }
  const t3 = hostPerf.now();

  tCb += t1 - t0; tAudio += t2 - t1; tPresent += t3 - t2;
  const total = t3 - t0;
  if (total > tMax) tMax = total;
  if (total > 16) slowFrames++;
  if (frame % 120 === 0) {
    const nowMs = Date.now();
    if (!globalThis.__lastWall) globalThis.__lastWall = nowMs - 2000;
    const fps = 120000 / (nowMs - globalThis.__lastWall);
    globalThis.__lastWall = nowMs;
    log(`fps(real): ${fps.toFixed(1)}`);
  }
  if (frame % 600 === 0) {
    log(`timing/600f: cb=${(tCb / 600).toFixed(2)}ms audio=${(tAudio / 600).toFixed(2)}ms ` +
        `present=${(tPresent / 600).toFixed(2)}ms max=${tMax.toFixed(1)}ms slow(>16ms)=${slowFrames}`);
    tCb = tAudio = tPresent = tMax = 0; slowFrames = 0;
  }

  if (frame === Number(process.env.JSGAME_DUMP_FRAME || 0) && process.env.JSGAME_DUMP_PNG) {
    try {
      require('node:fs').writeFileSync(process.env.JSGAME_DUMP_PNG, canvas.encodeSync('png'));
      log('dumped frame ' + frame + ' to ' + process.env.JSGAME_DUMP_PNG);
    } catch (e) {
      logErr('png dump failed: ' + e.message);
    }
  }
};

globalThis.__jsg_dispatchKey = (type, code, key) => realm.dispatchKey(type, code, key, type === 'keydown');
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

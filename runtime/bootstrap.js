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

const FRAMES_PER_TICK = 800; // 48000 / 60

// ── Game session ──────────────────────────────────────────────────────────
// One running game = one session (its content + realm + entry + per-game frame
// counters). reset / load-a-new-game tear down the current session and build a
// fresh one, so nothing accumulates across restarts (a no-op reset used to leave
// the old realm + rAF running and only pile on state → the game just got slower).
let session = null;

function buildSession(contentPath) {
  const content = createContent(contentPath);

  // package.json is the manifest (entry = its "main"). Sizing/network are OPTIONAL
  // and default sensibly. Overrides may live in a "jsgame" block in package.json,
  // or in the .jsg marker (otherwise an empty pointer, like ScummVM's .scummvm).
  let width = 640, height = 480, netPolicy = 'off';
  const applyCfg = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    if (cfg.width > 0 && cfg.width <= 3840) width = cfg.width | 0;
    if (cfg.height > 0 && cfg.height <= 2160) height = cfg.height | 0;
    if (cfg.network) netPolicy = String(cfg.network);
  };
  try { const pkg = content.read('package.json'); if (pkg) applyCfg(JSON.parse(pkg.toString()).jsgame); }
  catch { /* no/invalid package.json jsgame block = defaults */ }
  try { applyCfg(JSON.parse(require('node:fs').readFileSync(contentPath, 'utf8'))); }
  catch { /* directory / empty marker / archive = keep package.json/defaults */ }

  log(`content: ${content.name} (${width}x${height})`);
  const realm = buildRealm({ content, io, canvasLib, width, height, log, logErr, netPolicy, runtimeDir: globalThis.__jsg_paths.runtime });
  const entry = resolveEntry(content);
  if (!entry) logErr('no game entry found (package.json main / main.js / src/main.js / ...)');
  else log('entry: ' + entry);

  // per-game frame + audio clock state (reset each session)
  return { content, realm, entry, begun: false, frame: 0, audioClockMs: 0, audioDebt: 0,
           tCb: 0, tAudio: 0, tPresent: 0, tMax: 0, slowFrames: 0,
           tGap: 0, gapMax: 0, gapLong: 0, lastEnd: 0 };
}

function startSession(contentPath) {
  stopSession();
  session = buildSession(contentPath);
}

function stopSession() {
  if (!session) return;
  try { session.realm.stop(); } catch (e) { logErr('session stop: ' + e.message); }
  session = null;
}

// __jsg_begin runs the entry — the CORE calls it (from retro_run) once GL is
// ready (context_reset has fired), or immediately for software. This avoids
// getContext('webgl2') racing ahead of the frontend's async context grant.
globalThis.__jsg_begin = () => {
  const s = session;
  if (!s || s.begun || !s.entry) return;
  s.begun = true;
  // Restore localStorage from SAVE_RAM NOW — __jsg_begin runs from retro_run, so
  // the frontend has already loaded the .srm into the buffer (it does so after
  // retro_load_game). Doing this at realm construction would read empty SRAM.
  try { s.realm.restoreLocalStorage(); } catch (e) { logErr('sram restore: ' + e.message); }
  Promise.all([
    import('./vendor/webaudio/LibretroAudioContext.js')
      .then((m) => { s.realm.setAudioContextClass(m.LibretroAudioContext); log('webaudio engine ready'); })
      .catch((e) => logErr('webaudio init failed (stub stays): ' + e.message)),
    import('./vendor/webgl/webgl2-context.mjs')
      .then((m) => { s.realm.setWebGL2Class(m.WebGL2RenderingContext); log('webgl2 ready'); })
      .catch((e) => logErr('webgl2 init failed: ' + e.message)),
  ])
    .then(() => { if (session === s) return s.realm.runEntry(s.entry); })
    .then(
      () => log('entry evaluated'),
      (err) => logErr('entry failed: ' + (err && err.stack ? err.stack : String(err)))
    );
};

// Build the first session from the initial content path.
startSession(globalThis.__jsg_paths.content);

const { performance: hostPerf } = require('node:perf_hooks');

// Audio must run at real wall-clock rate, like a browser's AudioContext —
// NOT a fixed 800 frames per video frame. If we always render 800/frame, then
// audio rate = fps * 800, so a slow/fast/jittery video frame rate makes audio
// play at the wrong speed with gaps (choppy). Instead, render exactly the
// number of frames that real elapsed time demands (elapsed_sec * 48000). The
// frontend's audio buffer + audio_sync absorb the small per-frame variance.
// (frame counter + audio clock are per-SESSION so a reset starts them fresh.)
const SAMPLE_RATE = 48000;

globalThis.__jsg_frame = () => {
  const s = session;
  if (!s) return;                 // no game loaded (mid restart) → nothing to do
  s.frame++;
  const realm = s.realm;
  const t0 = hostPerf.now();
  // Advance the game clock by the frontend-reported frame time (idiomatic
  // libretro: the frontend feeds real elapsed ms, but the reference 1000/60
  // during FF/slow-mo/pause so those stay deterministic). 0 = frontend didn't
  // register the callback -> fireFrame falls back to a fixed 1000/60 step.
  const frameMs = io.frameTimeMs ? io.frameTimeMs() : 0;
  realm.fireFrame(io.getPads(), frameMs);
  const t1 = hostPerf.now();

  // How many audio frames does real elapsed time call for this tick?
  // §1 (dev_notes): nFrames = elapsedMs * 48 with a fractional audioDebt carry —
  // audio rate tracks REAL elapsed wall-clock time, decoupled from fps, driftless.
  // THE STEADY-STATE MODEL IS UNCHANGED — it is the hard-won §1 victory.
  if (s.audioClockMs === 0) s.audioClockMs = t1;
  let elapsedMs = t1 - s.audioClockMs;
  s.audioClockMs = t1;

  // PHANTOM-TIME GUARD (startup feedback-loop fix). §1 assumes elapsedMs is time
  // the GAME ran. But under audio_sync=true the frontend BLOCKS our core inside
  // audio_batch_cb (AFTER this fn returns, in C) when its audio buffer is full —
  // and that block lands inside the NEXT frame's elapsedMs. During that block the
  // game did NOT run and NO audio was missed (the device was busy draining a full
  // buffer). Counting it as elapsed makes §1 produce audio for time the game was
  // frozen → a backlog that can only drain at 48kHz realtime → RA throttles us to
  // ~45fps for ~16s while it drains → and the throttle re-inflates elapsedMs →
  // metastable. So: cap elapsedMs at 2 video frames and DISCARD the excess (it is
  // phantom frontend-block time, not missed game time — carrying it would just
  // rebuild the backlog). This does NOT touch §1 steady state: at 60fps elapsed
  // ≈16.6ms << cap so the branch never fires; normal <30fps jitter (≤33ms) is
  // under the cap and fully preserved via the audioDebt carry below. Only a
  // frontend-block-inflated frame (>33ms, which on idle hardware can ONLY be a
  // block — cb is ~0.4ms) is trimmed. The reference is the frontend's own
  // frame-time when available (frameMs), else the 2-frame constant.
  const audioCapMs = 2 * (1000 / 60);         // 33.3ms — one frame of legit slack
  if (elapsedMs > audioCapMs) elapsedMs = audioCapMs;  // drop phantom block-time

  let want = elapsedMs * (SAMPLE_RATE / 1000) + s.audioDebt;
  let nFrames = Math.floor(want);
  s.audioDebt = want - nFrames;
  // Clamp: never render a giant burst (first frame / hitch / pause) or zero.
  if (nFrames < 1) nFrames = 1;
  if (nFrames > 4096) { nFrames = 4096; s.audioDebt = 0; }

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

  s.tCb += t1 - t0; s.tAudio += t2 - t1; s.tPresent += t3 - t2;
  const total = t3 - t0;
  if (total > s.tMax) s.tMax = total;
  if (total > 16) s.slowFrames++;

  // GAP: wall-clock from the END of the previous frame to the START of this one
  // — i.e. how long the FRONTEND blocked us between retro_run calls (audio
  // backpressure / vsync). If the dips live here (gap big while our work is
  // tiny), the stall is the frontend pacing us, not our code. This is the number
  // none of the cb/audio/present timers can see. (t0 was captured at fn entry.)
  if (s.lastEnd) {
    const gap = t0 - s.lastEnd;
    s.tGap += gap;
    if (gap > s.gapMax) s.gapMax = gap;
    if (gap > 20) s.gapLong = (s.gapLong || 0) + 1;
  }
  s.lastEnd = t3;
  if (s.frame % 120 === 0) {
    const nowMs = Date.now();
    if (!globalThis.__lastWall) globalThis.__lastWall = nowMs - 2000;
    const fps = 120000 / (nowMs - globalThis.__lastWall);
    globalThis.__lastWall = nowMs;
    log(`fps(real): ${fps.toFixed(1)}`);
  }
  if (s.frame % 600 === 0) {
    log(`timing/600f: cb=${(s.tCb / 600).toFixed(2)}ms audio=${(s.tAudio / 600).toFixed(2)}ms ` +
        `present=${(s.tPresent / 600).toFixed(2)}ms max=${s.tMax.toFixed(1)}ms slow(>16ms)=${s.slowFrames} ` +
        `| gap(avg)=${(s.tGap / 600).toFixed(2)}ms gapMax=${s.gapMax.toFixed(1)}ms gapLong(>20ms)=${s.gapLong || 0}`);
    s.tCb = s.tAudio = s.tPresent = s.tMax = 0; s.slowFrames = 0;
    s.tGap = 0; s.gapMax = 0; s.gapLong = 0;
  }

  if (s.frame === Number(process.env.JSGAME_DUMP_FRAME || 0) && process.env.JSGAME_DUMP_PNG) {
    try {
      require('node:fs').writeFileSync(process.env.JSGAME_DUMP_PNG, canvas.encodeSync('png'));
      log('dumped frame ' + s.frame + ' to ' + process.env.JSGAME_DUMP_PNG);
    } catch (e) {
      logErr('png dump failed: ' + e.message);
    }
  }
};

globalThis.__jsg_dispatchKey = (type, code, key) => { if (session) session.realm.dispatchKey(type, code, key, type === 'keydown'); };

// Restart the realm (reset) or load a different game. The CORE calls __jsg_stop
// (via jsg_host_stop) then __jsg_start(path) (via jsg_host_start) — together they
// tear down the current session and build a fresh one. __jsg_begin then re-runs
// the entry. Passing a NEW path here is how loading a different game works.
globalThis.__jsg_stop = () => { stopSession(); };
globalThis.__jsg_start = (p) => { startSession(p || (session && session.content && globalThis.__jsg_paths.content)); };

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

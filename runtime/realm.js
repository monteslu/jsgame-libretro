// realm.js — the game realm: a vm context whose globals are ONLY the browser
// shims. No fs, no process, no require reachable from game code. Soft sandbox
// (isolation, not a hardened boundary) per PLAN §12.
'use strict';

const vm = require('node:vm');

// RetroPad bit → W3C standard gamepad button index (PLAN §11.1)
// std buttons[i] reads retro bit STD_TO_RETRO[i]; -1 = always unpressed.
const STD_TO_RETRO = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7, -1];

function buildRealm({ content, io, canvasLib, width, height, log, logErr, netPolicy, runtimeDir }) {
  netPolicy = netPolicy || 'off';  // off | websocket | full
  const { createCanvas: nativeCreateCanvas, Image: NativeImage, loadImage: nativeLoadImage, GlobalFonts } = canvasLib;

  // GPU (Ganesh) state for the 3D-composite path. Populated when a WebGL context
  // is first created (3D mode). gpuReady gates the GPU-backed display surface.
  const glState = { gpuInited: false, gpuReady: false, fboColorTexture: null, getDefaultFb: null };

  // ── canvas factory (port of jsgamelauncher canvas.js, 2D only) ──────────
  function wrapCanvas(canvas) {
    const baseGetContext = canvas.getContext.bind(canvas);
    let ctx;
    let glCtx;
    canvas.style = {};
    const listeners = {};
    canvas.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
    canvas.removeEventListener = (type, fn) => {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    };
    canvas.getContext = function getContext(type) {
      if (type === 'webgl2' || type === 'webgl') {
        if (!WebGL2Ctx) {
          logErr('getContext(webgl2): GL not ready (no HW render context; set JSGAME_GL=1)');
          return null;
        }
        const glb = process._linkedBinding('jsgame_gl');
        if (glb.jsgReady && !glb.jsgReady()) {
          logErr('getContext(webgl2): frontend granted no GL context (desktop GL/GLES mismatch?)');
          return null;
        }
        if (!glCtx) {
          glCtx = new WebGL2Ctx(glb, canvas.width, canvas.height, { canvas });
          glCtx.canvas = canvas;
          // RetroArch's default FBO can change per frame — store the live getter
          // (not a one-time value) so bindFramebuffer(null) always resolves the
          // CURRENT FBO. Falls back to a cached 0 if the host doesn't expose it.
          glCtx._jsgGetDefaultFB = glb.jsgDefaultFramebuffer
            ? () => glb.jsgDefaultFramebuffer()
            : () => 0;
          glCtx._jsgDefaultFB = glCtx._jsgGetDefaultFB();
          // factory so the GL ctx can build a 2D snapshot canvas for drawImage()
          glCtx._make2DCanvas = (w, h) => wrapCanvas(nativeCreateCanvas(w, h));
          canvas._isWebGL = true;
          canvas._glCtx = glCtx;  // for per-frame default-FBO binding
          // GPU-composite path: a WebGL context exists, so we're in 3D mode.
          // Init the process Ganesh GrContext from the frontend's GL loader so
          // the DISPLAY 2D canvas can be GPU-backed (drawImage(glCanvas) becomes
          // a GPU->GPU blit, no readback). Best-effort: null on CPU-only Skia.
          if (!glState.gpuInited && glb.jsgGetProcAddress && displayCanvas.jsgGpuInit) {
            glState.gpuInited = true;
            try {
              const proc = glb.jsgGetProcAddress();
              glState.gpuReady = displayCanvas.jsgGpuInit(proc) && displayCanvas.jsgGpuReady();
              // sceneTexture(srcFbo,w,h): copy the WebGL FBO into a clean texture
              // we present DIRECTLY (the 3D scene). The HUD is a SEPARATE Skia
              // surface (transparent + fillText) blended over it at present —
              // Skia's GPU draws never reach an externally-written texture, so we
              // keep scene (raw GL) and HUD (Skia) as two textures.
              glState.sceneTexture = glb.jsgSceneTexture || null;
              glState.getDefaultFb = glb.jsgDefaultFramebuffer || null;
            } catch (e) { glState.gpuReady = false; }
          }
        }
        return glCtx;
      }
      if (type !== '2d') {
        logErr('getContext(' + type + ') unsupported');
        return null;
      }
      if (!ctx) {
        ctx = baseGetContext('2d');
        const baseDrawImage = ctx.drawImage.bind(ctx);
        const baseCreatePattern = ctx.createPattern.bind(ctx);
        const baseGetImageData = ctx.getImageData.bind(ctx);
        const basePutImageData = ctx.putImageData.bind(ctx);
        ctx.drawImage = (image, ...args) => {
          if (!image) return;
          // Web compat: drawImage(webglCanvas) blits the GL canvas's pixels onto
          // a 2D canvas (standard in every browser — used for HUD overlays over a
          // WebGL scene). Two implementations:
          //  - GPU (Ganesh): capture the WebGL scene as its OWN texture (present
          //    directly), and prep the Skia GPU surface as a TRANSPARENT HUD
          //    overlay — the game's subsequent fillText draws into it, and the
          //    host blends the HUD over the scene at present. (Skia GPU draws
          //    never reach an externally-raw-written texture, so scene and HUD
          //    must be two separate textures — NO readback either way.)
          //  - CPU fallback: the GL ctx hands us the flipped RGBA frame and we
          //    putImageData it into this 2D context (the readback path).
          if (image._isWebGL && image._glCtx) {
            if (
              canvas === displayCanvas && glState.gpuReady &&
              glState.sceneTexture && canvas.jsgUpgradeToGpu
            ) {
              if (!canvas._isGpu2D) {
                canvas._isGpu2D = canvas.jsgUpgradeToGpu();
                log('[gpu] upgrade_to_gpu=' + canvas._isGpu2D + ' gpuReady=' + glState.gpuReady);
              }
              if (canvas._isGpu2D) {
                const fbo = image._glCtx._jsgGetDefaultFB
                  ? image._glCtx._jsgGetDefaultFB() : 0;
                // 1) scene -> its own texture (presented directly, opaque)
                canvas._sceneTex = glState.sceneTexture(fbo, canvas.width, canvas.height);
                // 2) clear the Skia HUD surface to transparent + reset GL state
                //    so the game's following fillText draws form the overlay.
                canvas.jsgGpuReset();
                canvas.jsgGpuClearTransparent();
                if (!canvas._gpuLogged) { canvas._gpuLogged = 1; log('[gpu] sceneTex=' + canvas._sceneTex); }
                return;
              }
            }
            if (image._glCtx._snapshotInto) {
              image._glCtx._snapshotInto(ctx, baseGetImageData, basePutImageData);
              return;
            }
          }
          baseDrawImage(image._imgImpl ? image._imgImpl : image, ...args);
        };
        ctx.createPattern = (image, type2) => {
          if (!image) return null;
          return baseCreatePattern(image._imgImpl ? image._imgImpl : image, type2);
        };
      }
      return ctx;
    };
    canvas.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0,
      right: canvas.width, bottom: canvas.height,
      width: canvas.width, height: canvas.height,
    });
    return canvas;
  }

  const displayCanvas = wrapCanvas(nativeCreateCanvas(width, height));

  // ── Image (content-backed; port of jsgamelauncher image.js) ────────────
  class Image {
    constructor(w, h) {
      this._width = w || 0;
      this._height = h || 0;
      this._src = '';
    }
    set src(url) {
      this._src = String(url);
      const load = async () => {
        try {
          let img;
          if (this._src.startsWith('data:')) {
            img = await nativeLoadImage(this._src);
          } else {
            const buf = content.asset(this._src);
            if (!buf) throw new Error('asset not found: ' + this._src);
            img = await nativeLoadImage(buf);
          }
          this._imgImpl = img;
          this._width = img.width;
          this._height = img.height;
          if (this.onload) this.onload(this);
        } catch (err) {
          logErr('Image load failed: ' + this._src + ' — ' + err.message);
          if (this.onerror) this.onerror(err);
        }
      };
      load();
    }
    get src() { return this._src; }
    get width() { return this._imgImpl ? this._imgImpl.width : this._width; }
    get height() { return this._imgImpl ? this._imgImpl.height : this._height; }
    get complete() { return !!this._imgImpl; }
    addEventListener(type, fn) {
      if (type === 'load') this.onload = fn;
      if (type === 'error') this.onerror = fn;
    }
    removeEventListener() {}
  }

  const loadImage = async (url) => {
    const s = String(url);
    if (s.startsWith('data:')) return nativeLoadImage(s);
    const buf = content.asset(s);
    if (!buf) throw new Error('asset not found: ' + s);
    return nativeLoadImage(buf);
  };

  // ── fetch (game-root scoped; network off in Phase 1) ───────────────────
  const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', json: 'application/json',
    js: 'text/javascript', mjs: 'text/javascript', txt: 'text/plain',
    html: 'text/html', css: 'text/css', wasm: 'application/wasm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  };
  async function realmFetch(url, options = {}) {
    const s = String(url);
    const lc = s.toLowerCase();
    if (lc.startsWith('http') || lc.startsWith('//')) {
      logErr('fetch blocked (network off): ' + s);
      return new Response(null, { status: 403, statusText: 'Network disabled' });
    }
    const buf = content.asset(s);
    if (!buf) return new Response(null, { status: 404, statusText: 'Not Found' });
    const ext = s.split('.').pop().toLowerCase();
    return new Response(buf, {
      status: 200, statusText: 'OK',
      headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' },
    });
  }

  // ── localStorage → SRAM (magic 'JSG1' + u32 length + JSON) ─────────────
  const store = new Map();
  (() => {
    const sram = io.sramRead();
    if (sram && sram.length > 8 && sram[0] === 0x4a && sram[1] === 0x53 &&
        sram[2] === 0x47 && sram[3] === 0x31) {
      const len = sram[4] | (sram[5] << 8) | (sram[6] << 16) | (sram[7] << 24);
      if (len > 0 && len <= sram.length - 8) {
        try {
          const obj = JSON.parse(Buffer.from(sram.buffer, sram.byteOffset + 8, len).toString());
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
          log('localStorage: restored ' + store.size + ' keys from SRAM');
        } catch { /* corrupt — start fresh */ }
      }
    }
  })();
  function persist() {
    const json = Buffer.from(JSON.stringify(Object.fromEntries(store)));
    const sramSize = io.sramRead() ? io.sramRead().length : 0;
    if (json.length + 8 > sramSize) {
      const e = new Error('localStorage quota exceeded (SRAM ' + sramSize + ' bytes)');
      e.name = 'QuotaExceededError';
      throw e;
    }
    const out = Buffer.alloc(json.length + 8);
    out.write('JSG1', 0);
    out.writeUInt32LE(json.length, 4);
    json.copy(out, 8);
    io.sramWrite(out);
  }
  const localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); persist(); },
    removeItem: (k) => { store.delete(String(k)); persist(); },
    clear: () => { store.clear(); persist(); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  // ── Keyboard (events fed by the core from RETRO_KEYBOARD_CALLBACK) ──────
  const keyListeners = { keydown: [], keyup: [] };
  function dispatchKey(type, code, key, pressed) {
    const ev = { type, code, key, repeat: false, preventDefault() {}, stopPropagation() {},
                 altKey: false, ctrlKey: false, shiftKey: false, metaKey: false };
    for (const fn of keyListeners[type]) { try { fn(ev); } catch (e) { logErr('key handler: ' + e.message); } }
    if (type === 'keydown' && typeof sandbox.onkeydown === 'function') sandbox.onkeydown(ev);
    if (type === 'keyup' && typeof sandbox.onkeyup === 'function') sandbox.onkeyup(ev);
  }

  // ── Gamepad API over RetroPad ───────────────────────────────────────────
  let padSnapshot = new Int32Array(4 * 8);
  function getGamepads() {
    const out = [];
    for (let p = 0; p < 4; p++) {
      const o = p * 8;
      if (!padSnapshot[o + 7]) { out.push(null); continue; }
      const bits = padSnapshot[o] >>> 0;
      const buttons = STD_TO_RETRO.map((bit, i) => {
        let pressed = bit >= 0 && (bits & (1 << bit)) !== 0;
        let value = pressed ? 1 : 0;
        if (i === 6 && padSnapshot[o + 5] > 0) { value = padSnapshot[o + 5] / 32767; pressed = true; }
        if (i === 7 && padSnapshot[o + 6] > 0) { value = padSnapshot[o + 6] / 32767; pressed = true; }
        return { pressed, touched: pressed, value };
      });
      out.push({
        id: 'RetroPad #' + p,
        index: p,
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        buttons,
        axes: [
          padSnapshot[o + 1] / 32767, padSnapshot[o + 2] / 32767,
          padSnapshot[o + 3] / 32767, padSnapshot[o + 4] / 32767,
        ],
        vibrationActuator: { playEffect: async () => 'complete', reset: async () => 'complete' },
      });
    }
    return out;
  }

  // ── WebAudio stub (silent; real engine lands in Phase 2) ───────────────
  class FakeAudioBuffer {
    constructor(channels, length, sampleRate) {
      this.numberOfChannels = channels;
      this.length = length;
      this.sampleRate = sampleRate;
      this.duration = length / sampleRate;
      this._data = Array.from({ length: channels }, () => new Float32Array(length));
    }
    getChannelData(c) { return this._data[c]; }
    copyToChannel(src, c) { this._data[c].set(src.subarray(0, this.length)); }
    copyFromChannel(dst, c) { dst.set(this._data[c].subarray(0, dst.length)); }
  }
  class FakeNode {
    connect(n) { return n; }
    disconnect() {}
  }
  // Real engine class registered by bootstrap once the ESM vendor loads;
  // constructions before that fall back to the silent stub.
  let RealAudioContextClass = null;
  const liveContexts = [];
  let WebGL2Ctx = null;  // set once the ESM webgl2-context loads

  class AudioContext {
    constructor(opts) {
      if (RealAudioContextClass) {
        const ctx = new RealAudioContextClass(opts);
        liveContexts.push(ctx);
        return ctx;
      }
      logErr('AudioContext created before engine ready — silent stub');
      return new StubAudioContext();
    }
  }

  class StubAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = new FakeNode();
      this._t0 = realmPerformance.now();
    }
    get currentTime() { return (realmPerformance.now() - this._t0) / 1000; }
    async decodeAudioData(ab, ok) {
      // Phase 2: real decode. For now a 1-second silent buffer.
      const buf = new FakeAudioBuffer(2, 48000, 48000);
      if (ok) ok(buf);
      return buf;
    }
    createBufferSource() {
      const n = new FakeNode();
      n.buffer = null; n.loop = false; n.playbackRate = { value: 1 };
      n.start = () => { if (n.onended) setTimeout(() => n.onended(), 0); };
      n.stop = () => {};
      return n;
    }
    createGain() { const n = new FakeNode(); n.gain = { value: 1, setValueAtTime: () => {} }; return n; }
    createOscillator() {
      const n = new FakeNode();
      n.frequency = { value: 440, setValueAtTime: () => {} };
      n.type = 'sine'; n.start = () => {}; n.stop = () => {};
      return n;
    }
    createBuffer(c, l, r) { return new FakeAudioBuffer(c, l, r); }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
  }

  // ── WebSocket façade (privileged realm owns the real socket) ───────────
  class GameWebSocket {
    constructor(url, protocols) {
      this.url = String(url);
      this.readyState = 0; // CONNECTING
      this.bufferedAmount = 0;
      this._listeners = {};
      if (netPolicy === 'off') {
        logErr('WebSocket blocked (network policy: off): ' + this.url);
        setTimeout(() => { this.readyState = 3; this._emit('error', {}); this._emit('close', { code: 1006 }); }, 0);
        return;
      }
      try {
        this._ws = new WebSocket(this.url, protocols);  // Node global, privileged
        this._ws.binaryType = 'arraybuffer';
        this._ws.addEventListener('open', () => { this.readyState = 1; this._emit('open', {}); });
        this._ws.addEventListener('message', (e) => this._emit('message', { data: e.data }));
        this._ws.addEventListener('close', (e) => { this.readyState = 3; this._emit('close', { code: e.code, reason: e.reason }); });
        this._ws.addEventListener('error', () => this._emit('error', {}));
      } catch (e) {
        logErr('WebSocket open failed: ' + e.message);
        setTimeout(() => { this.readyState = 3; this._emit('error', {}); }, 0);
      }
    }
    send(data) { if (this._ws && this.readyState === 1) this._ws.send(data); }
    close(code, reason) { if (this._ws) this._ws.close(code, reason); }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter((f) => f !== fn); }
    _emit(t, ev) {
      ev.type = t;
      const on = this['on' + t]; if (typeof on === 'function') { try { on(ev); } catch (e) { logErr(e.message); } }
      for (const fn of (this._listeners[t] || [])) { try { fn(ev); } catch (e) { logErr(e.message); } }
    }
    get CONNECTING() { return 0; } get OPEN() { return 1; } get CLOSING() { return 2; } get CLOSED() { return 3; }
  }
  GameWebSocket.CONNECTING = 0; GameWebSocket.OPEN = 1; GameWebSocket.CLOSING = 2; GameWebSocket.CLOSED = 3;

  // ── Worker shim (worker_threads + our worker-bootstrap) ────────────────
  const { Worker: NodeWorker } = require('node:worker_threads');
  const path = require('node:path');
  class GameWorker {
    constructor(scriptUrl) {
      this._listeners = { message: [], error: [] };
      // Resolve the worker script to a real path inside the game (dir mode) or
      // extract from zip to a temp; for now support dir-mode relative scripts.
      const rel = String(scriptUrl).replace(/^\.?\//, '');
      this._worker = new NodeWorker(path.join(runtimeDir, 'worker-bootstrap.js'), {
        workerData: { script: rel, gameRoot: content.root || null, isZip: !!content.isZip },
      });
      this._worker.on('message', (data) => this._emit('message', { data }));
      this._worker.on('error', (err) => this._emit('error', { message: err.message }));
    }
    postMessage(data, transfer) { this._worker.postMessage(data, transfer); }
    terminate() { this._worker.terminate(); }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter((f) => f !== fn); }
    _emit(t, ev) {
      ev.type = t;
      const on = this['on' + t]; if (typeof on === 'function') { try { on(ev); } catch (e) { logErr(e.message); } }
      for (const fn of (this._listeners[t] || [])) { try { fn(ev); } catch (e) { logErr(e.message); } }
    }
  }

  // ── synthetic frame clock + rAF ─────────────────────────────────────────
  let now = 0; // ms, advances 1000/60 per frame
  const realmPerformance = { now: () => now, timeOrigin: 0 };
  let rafId = 0;
  let pendingRaf = null;
  function requestAnimationFrame(cb) {
    rafId++;
    pendingRaf = { id: rafId, cb };
    return rafId;
  }
  function cancelAnimationFrame(id) {
    if (pendingRaf && pendingRaf.id === id) pendingRaf = null;
  }

  // ── document / window stubs (port of launcher.js) ──────────────────────
  const document = {
    title: '',
    readyState: 'complete',
    currentScript: { src: '' },
    documentElement: {},
    getElementById: () => displayCanvas,
    querySelector: () => displayCanvas,
    querySelectorAll: () => [],
    createElement: (name) => {
      if (name === 'canvas') return wrapCanvas(nativeCreateCanvas(300, 150));
      if (name === 'img' || name === 'image') return new Image();
      return { style: {}, appendChild: () => {}, setAttribute: () => {} };
    },
    createElementNS: (_ns, name) => document.createElement(name),
    createTextNode: (text) => ({ nodeValue: text }),
    hasFocus: () => true,
    addEventListener: (type, fn) => { if (keyListeners[type]) keyListeners[type].push(fn); },
    removeEventListener: (type, fn) => { if (keyListeners[type]) keyListeners[type] = keyListeners[type].filter((f) => f !== fn); },
    body: {
      appendChild: () => {},
      removeChild: () => {},
      style: {},
      getBoundingClientRect: () => ({
        left: 0, top: 0, width: displayCanvas.width, height: displayCanvas.height,
        right: displayCanvas.width, bottom: displayCanvas.height,
      }),
    },
    head: { appendChild: () => {}, removeChild: () => {} },
    fonts: {
      add: (font) => { if (font && font._register) font._register(); },
      ready: Promise.resolve(),
    },
  };

  class FontFace {
    constructor(family, source) {
      this.family = family;
      this._source = source;
      this.status = 'unloaded';
    }
    async load() {
      const m = /url\(["']?([^"')]+)["']?\)/.exec(String(this._source));
      if (m) {
        const buf = content.asset(m[1]);
        if (buf && GlobalFonts) {
          GlobalFonts.register(buf, this.family);
          this.status = 'loaded';
        }
      }
      return this;
    }
    _register() { this.load(); }
  }

  // ── sandbox assembly ────────────────────────────────────────────────────
  const sandbox = {
    document,
    navigator: {
      userAgent: 'jsgame-libretro',
      platform: 'libretro',
      language: 'en-US',
      languages: ['en-US'],
      getGamepads,
      maxTouchPoints: 0,
    },
    screen: { width, height, availWidth: width, availHeight: height },
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    performance: realmPerformance,
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    fetch: realmFetch,
    Image,
    loadImage,
    localStorage,
    FontFace,
    AudioContext,
    webkitAudioContext: AudioContext,
    Audio: class Audio {
      constructor(src) { this.src = src || ''; this.volume = 1; this.loop = false; this.paused = true; }
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
      addEventListener(type, fn) { if (type === 'canplaythrough') setTimeout(fn, 0); }
      removeEventListener() {}
      cloneNode() { return new sandbox.Audio(this.src); }
    },
    console: {
      log: (...a) => log(a.map(String).join(' ')),
      info: (...a) => log(a.map(String).join(' ')),
      warn: (...a) => io.log(2, a.map(String).join(' ')),
      error: (...a) => logErr(a.map(String).join(' ')),
      debug: () => {},
      trace: () => {},
    },
    alert: (msg) => log('alert: ' + msg),
    // pass-through host classes (host realm intrinsics are fine to share for
    // data types; soft-sandbox stance per PLAN §12.2)
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob, Response, Request, Headers,
    ImageData: canvasLib.ImageData,
    Path2D: canvasLib.Path2D,
    OffscreenCanvas: class OffscreenCanvas {
      constructor(w, h) { return wrapCanvas(nativeCreateCanvas(w, h)); }
    },
    HTMLCanvasElement: Object.getPrototypeOf(displayCanvas).constructor,
    WebAssembly,
    WebSocket: GameWebSocket,
    Worker: GameWorker,
    structuredClone,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    addEventListener: (type, fn) => { if (keyListeners[type]) keyListeners[type].push(fn); },
    removeEventListener: (type, fn) => { if (keyListeners[type]) keyListeners[type] = keyListeners[type].filter((f) => f !== fn); },
    dispatchEvent: () => true,
    requestIdleCallback: (cb) => setTimeout(() => cb({ timeRemaining: () => 10 }), 0),
    cancelIdleCallback: clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;

  const context = vm.createContext(sandbox, { name: 'jsgame' });

  // ── ESM loader (relative specifiers only; bare/node: blocked) ──────────
  const moduleCache = new Map();
  function dirOf(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }
  function resolveSpecifier(spec, referrer) {
    if (spec.startsWith('node:')) throw new Error('builtin modules are not available: ' + spec);
    if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')) {
      throw new Error('bare specifier "' + spec + '" — bundle your game (no node_modules resolution)');
    }
    const base = spec.startsWith('/') ? '' : dirOf(referrer);
    const joined = (base ? base + '/' : '') + spec.replace(/^\.\//, '');
    // normalize ../ segments
    const parts = [];
    for (const seg of joined.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    let p = parts.join('/');
    if (!content.exists(p)) {
      for (const ext of ['.js', '.mjs', '/index.js']) {
        if (content.exists(p + ext)) return p + ext;
      }
    }
    return p;
  }
  function loadModule(relPath) {
    if (moduleCache.has(relPath)) return moduleCache.get(relPath);
    const src = content.read(relPath);
    if (!src) throw new Error('module not found: ' + relPath);
    const mod = new vm.SourceTextModule(src.toString(), {
      context,
      identifier: 'jsg:///' + relPath,
      initializeImportMeta(meta) { meta.url = 'jsg:///' + relPath; },
      importModuleDynamically: async (spec) => {
        const m = loadModule(resolveSpecifier(spec, relPath));
        await linkAndEvaluate(m);
        return m;
      },
    });
    mod._relPath = relPath;
    moduleCache.set(relPath, mod);
    return mod;
  }
  async function linkAndEvaluate(mod) {
    if (mod.status === 'unlinked') {
      await mod.link((spec, referencingModule) =>
        loadModule(resolveSpecifier(spec, referencingModule._relPath ?? mod._relPath)));
    }
    if (mod.status === 'linked') await mod.evaluate();
  }

  return {
    displayCanvas,
    setAudioContextClass(cls) { RealAudioContextClass = cls; },
    setWebGL2Class(cls) {
      WebGL2Ctx = cls;
      // Expose as a global so libraries that feature-detect WebGL2 by
      // `typeof WebGL2RenderingContext !== 'undefined'` and
      // `gl.constructor.name === 'WebGL2RenderingContext'` (e.g. Three.js)
      // correctly take their WebGL2 path instead of falling back to WebGL1.
      sandbox.WebGL2RenderingContext = cls;
    },
    dispatchKey,
    hasAudio() { return liveContexts.some((c) => c.state === 'running'); },
    pullAudio(numFrames) {
      const ctx = liveContexts.find((c) => c.state === 'running');
      if (!ctx) return null;
      // Reused buffer — pushAudio copies synchronously, safe.
      return ctx.pullFrames(numFrames);
    },
    async runEntry(entryPath) {
      const mod = loadModule(entryPath);
      await linkAndEvaluate(mod);
    },
    fireFrame(int32Pads) {
      now += 1000 / 60;
      padSnapshot = int32Pads;
      // Bind the frontend's (live) default framebuffer before the game's frame.
      // Libraries like Three.js render to "the canvas" assuming the default
      // framebuffer is already current and never call bindFramebuffer(null);
      // in a libretro core the real default is RetroArch's per-frame FBO, so we
      // must make it current each frame or their output goes to an unpresented FBO.
      if (displayCanvas._glCtx && displayCanvas._glCtx._bindDefaultFB) {
        displayCanvas._glCtx._bindDefaultFB();
      }
      if (pendingRaf) {
        const { cb } = pendingRaf;
        pendingRaf = null;
        cb(now);
      }
    },
  };
}

module.exports = { buildRealm };

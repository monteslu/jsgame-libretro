// realm.js — the game realm: a vm context whose globals are ONLY the browser
// shims. No fs, no process, no require reachable from game code. Soft sandbox
// (isolation, not a hardened boundary) per PLAN §12.
'use strict';

const vm = require('node:vm');

// RetroPad bit → W3C standard gamepad button index (PLAN §11.1)
// std buttons[i] reads retro bit STD_TO_RETRO[i]; -1 = always unpressed.
const STD_TO_RETRO = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7, -1];

function buildRealm({ content, io, canvasLib, width, height, log, logErr }) {
  const { createCanvas: nativeCreateCanvas, Image: NativeImage, loadImage: nativeLoadImage, GlobalFonts } = canvasLib;

  // ── canvas factory (port of jsgamelauncher canvas.js, 2D only) ──────────
  function wrapCanvas(canvas) {
    const baseGetContext = canvas.getContext.bind(canvas);
    let ctx;
    canvas.style = {};
    const listeners = {};
    canvas.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
    canvas.removeEventListener = (type, fn) => {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    };
    canvas.getContext = function getContext(type) {
      if (type === 'webgl2' || type === 'webgl') {
        const glb = process._linkedBinding('jsgame_gl');
        if (!glb.ready()) {
          logErr('getContext(webgl2): no HW render context (set JSGAME_GL=1)');
          return null;
        }
        // S5 spike surface: raw binding + the constants the spike needs.
        // Phase 3 replaces this with a full WebGL2RenderingContext.
        const gl = Object.assign(Object.create(null), glb, {
          canvas,
          VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
          COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
          ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4,
          COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100,
          TRIANGLES: 0x0004, FLOAT: 0x1406,
        });
        canvas._isWebGL = true;
        return gl;
      }
      if (type !== '2d') {
        logErr('getContext(' + type + ') unsupported');
        return null;
      }
      if (!ctx) {
        ctx = baseGetContext('2d');
        const baseDrawImage = ctx.drawImage.bind(ctx);
        const baseCreatePattern = ctx.createPattern.bind(ctx);
        ctx.drawImage = (image, ...args) => {
          if (!image) return;
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
    addEventListener: () => {},
    removeEventListener: () => {},
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
    structuredClone,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    addEventListener: () => {},
    removeEventListener: () => {},
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
    pullAudio(numFrames) {
      const ctx = liveContexts.find((c) => c.state === 'running');
      return ctx ? ctx.pullFrames(numFrames) : null;
    },
    async runEntry(entryPath) {
      const mod = loadModule(entryPath);
      await linkAndEvaluate(mod);
    },
    fireFrame(int32Pads) {
      now += 1000 / 60;
      padSnapshot = int32Pads;
      if (pendingRaf) {
        const { cb } = pendingRaf;
        pendingRaf = null;
        cb(now);
      }
    },
  };
}

module.exports = { buildRealm };

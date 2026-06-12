# jsgame-libretro — Plan

A libretro core that runs JavaScript web games **without a browser**. RetroArch (or any
libretro frontend) is the launcher, window manager, input mapper, and display pipeline.
The core embeds libnode (V8) and provides browser APIs — Canvas 2D, WebGL2, WebAudio,
Gamepad, localStorage, fetch, Workers — implemented directly on top of the libretro API.

Same games as jsgamelauncher. Same packaging as the web. Zero install beyond a core file.

```
RetroArch / libretro frontend
└── jsgame_libretro.so
    ├── libnode (static, V8 + libuv + embedding API)     ← build-libnode
    ├── @napi-rs/canvas (static, Skia CPU raster)        ← build-libcanvas (new)
    ├── webaudio DSP engine (native C, pull-model sink)  ← webaudio-node sources
    ├── GL linked binding (proc table from frontend)     ← fresh, on retro_hw_render
    └── privileged JS runtime (bootstrap + shims + sandbox)
        └── game realm (vm context, curated globals)
            └── the game — unmodified web JS
```

---

## 1. Why

jsgamelauncher already proves the thesis: web games run great on $50 Linux handhelds
without a browser. But it pays three taxes a libretro core doesn't:

1. **Install tax.** Per-distro installers, `es_systems.cfg`, `run.sh`, nvm, a system Node
   — and every distro update is whack-a-mole. A libretro core is a `.so` + `.info` file
   dropped in the cores directory. If it ever lands in the libretro buildbot, every
   RetroArch install on earth can download it from the Core Downloader.
2. **Display tax.** launcher.js carries a three-tier EGL dance (fbdev window surface →
   native window handle → SDL software fallback) because it must own the display on
   Mali-class devices. In a libretro core the frontend owns the display and hands the
   core a working GL context. Knulli already solved Mali; we inherit the solution.
3. **Frontend feature tax.** Scaling, integer scaling, fullscreen, shaders, overlays,
   screenshots, recording, menus, hotkeys, per-device controller mapping — all RetroArch
   features we currently reimplement or skip. Delete the code, keep the features.

What the core model costs us (accepted up front):

- **No save states / rewind / runahead / frontend netplay.** A V8 heap is not
  serializable. `retro_serialize_size()` returns 0. Games do their own netplay over
  WebSockets if they want it. Persistent *saves* are NOT lost — see §8 (SRAM-backed
  localStorage).
- **No npm install on device.** libnode is built `--without-npm`. Games ship bundled
  (which good web games already do).
- **No iOS, no statically-linked consoles.** V8 needs JIT and dlopen. The six targets
  are Linux x86_64 + aarch64, Windows x86_64, macOS x86_64 + aarch64, and Android
  aarch64 — the same matrix build-libnode already ships (§15).

Relationship to the wasmcart QuickJS plan (`../jsgamelauncher_wasmcart_plan.md`): these
are complementary tiers, not competitors. This core is the **compat/performance tier**
(real V8, real Skia, full web-API surface, soft sandbox). The QuickJS wasmcart is the
**portability/sandbox tier** (hard WASM isolation, runs on every wasmcart host). Both
consume the same game packages.

---

## 2. Prior art and naming

Game-engine cores are an established libretro category: **Lutro** (LÖVE/Lua), **TIC-80**,
**EasyRPG**, **ScummVM**, **DOSBox-Pure**, **Mr.Boom**. In-house, **wasmcart-libretro**
already embeds libnode in a core and is the chassis donor for this project.

Naming (locked — renaming a shipped core is painful because the name leaks into the
`.info` filename, playlists, and core-option keys):

- Repo: `jsgame-libretro` (matches `mrboom-libretro`, `beetle-psx-libretro`,
  `wasmcart-libretro`)
- Artifact: `jsgame_libretro.so` / `jsgame_libretro.dll` / `jsgame_libretro.dylib`
- Info file: `jsgame_libretro.info`
- Core option prefix: `jsgame_*`

Draft `.info`:

```ini
display_name = "JS Game Engine (jsgame)"
authors = "Luis Montes"
supported_extensions = "jsg|jsgame"
corename = "jsgame"
categories = "Game engine"
license = "MIT"
permissions = ""
display_version = "0.1.0"
systemname = "JS Games"
systemid = "jsgames"
manufacturer = "None"
database = ""
notes = "Runs JavaScript web games. (!) Content is a .jsg marker file inside a game directory, or a .jsgame zip package."
supports_no_game = "false"
savestate = "false"
cheats = "false"
is_experimental = "true"
```

---

## 3. Content format

Two modes, one mental model: **the game root is a directory tree, exactly like a web
deploy.** Same tree runs in jsgamelauncher, a browser (`npm run dev`), and this core.

### 3.1 Directory mode (development)

Identical to jsgamelauncher today. The content file the frontend loads is the `.jsg`
marker; the core takes `dirname(content_path)` as the game root.

```
mygame/
├── mygame.jsg          ← the "ROM" the frontend sees (can be empty or hold JSON config)
├── package.json        ← optional; "main" wins entry resolution
├── dist/ or src/       ← bundled output preferred
└── assets/
```

Entry resolution order (port verbatim from launcher.js): `package.json` `main` →
`main.js` → `src/main.js` → `index.js` → `src/index.js` → `game.js` → `src/game.js`.
The auto-`npm install` feature does NOT port (no npm). Dir-mode games with committed
`node_modules` still work only if the entry is a self-contained bundle — bare-specifier
imports are not resolved (§7.4).

### 3.2 Zip mode (distribution)

A zip of the same tree with extension `.jsgame` (decided: distinct from `.jsg` so both
can coexist in one roms folder; frontends associate both with this core).

Critical libretro details:

- `retro_get_system_info`: `need_fullpath = true`, **`block_extract = true`**.
  Without `block_extract` RetroArch auto-extracts archives before the core sees them.
- The core never extracts to disk. The privileged realm reads members directly from the
  archive (`yauzl` for streaming or `fflate` for in-memory — both already deps of
  wasmcart). All asset paths (`fetch`, `Image.src`, `FontFace`) resolve into the zip.
- `manifest.json` at zip root is optional v1, reserved for later metadata (name, players,
  preferred resolution, network allowlist).

### 3.3 `.jsg` file contents

Today jsgamelauncher treats it as a marker. Keep that, but define: if the file parses as
JSON, it may carry per-game config (`{"width": 1280, "height": 720, "name": "..."}`).
Empty/non-JSON ⇒ all defaults. Same rule in zip mode for a root `game.jsg`.

---

## 4. Process architecture: libnode in a core

### 4.1 Chassis (proven in wasmcart-libretro)

Fork the embedding layer from `../wasmcart-libretro` /
`../wasmcart-libretro/deps/wasmcart-native/src/cart_host.cpp`, which already does:

- `node::InitializeOncePerProcess(args, {kNoInitializeV8, kNoInitializeNodeV8Platform})`
- `node::MultiIsolatePlatform::Create(4)` — multi-isolate platform (worker-capable, §10)
- `node::CommonEnvironmentSetup::Create(...)` → full Node `Environment`
- `node::LoadEnvironment(env, bootstrap)` — full Node built-ins available
- `uv_run(loop, UV_RUN_NOWAIT)` pumped from the frame callback

Long-term both cores should share one "libnode-libretro chassis" library; v1 forks,
convergence is a tracked follow-up (§14).

### 4.2 V8 lifecycle across core load/unload

V8 cannot be disposed and re-initialized in one process. Adopt wasmcart-libretro's
behavior **identically** (audit it during Phase 0 and document what it actually does):
initialize once per process, keep platform/V8 alive across `retro_deinit`, tear down
Environments per content session, never call `V8::Dispose`. Also audit interop: a user
loading wasmcart core then jsgame core in one RetroArch session means two libnode copies
in-process — verify symbol visibility doesn't collide (both are linked statically with
hidden visibility; confirm `-fvisibility=hidden` on everything except the libretro API).

### 4.3 Static linking — everything in one .so

No `.node` files, no dlopen, no symbol-resolution games. The core links statically:

- `libnode.a` from build-libnode releases (already `-fPIC` + TLS global-dynamic patched
  specifically so it can live inside a shared library — that war is won)
- `libcanvas.a` + Skia static archives (§6)
- webaudio DSP objects (§9)
- The privileged JS runtime is **embedded in the binary** (objcopy/incbin a zip of
  `runtime/` into a `.rodata` blob) so the core remains a single file. Dev builds may
  load `runtime/` from disk via env var for fast iteration.

### 4.4 Threads inventory (inside RetroArch's process)

- V8/libnode worker pool (4 platform threads) + libuv default pool
- tokio runtime from napi-rs (async encode paths; bounded)
- Skia is used single-threaded from the JS thread
- webaudio DSP runs synchronously inside `retro_run` (pull model — no audio thread of
  our own; the frontend owns audio output timing)

`retro_run`, all JS, all GL, and all canvas raster happen on the frontend's main/retro
thread. Nothing else touches GL.

---

## 5. Frame loop contract

Declared in `retro_get_system_av_info`:

- `timing.fps = 60.0`, `timing.sample_rate = 48000.0`
- `geometry.base_width/height` = canvas dims (default 640×480, same as jsgamelauncher)
- `geometry.max_width/height` = 1920×1080
- On canvas resize from game code: `RETRO_ENVIRONMENT_SET_GEOMETRY` (cheap) — only
  escalate to `SET_SYSTEM_AV_INFO` if dims exceed declared max (it reinits the driver;
  wasmcart-libretro does this for its redirect resolution).

`retro_run()` pseudocode:

```c
void retro_run(void) {
  input_poll_cb();
  write_gamepad_snapshot();        // §11 — RetroPad → Gamepad API objects
  pump_keyboard_pointer_events();  // queued from callbacks since last frame

  js_dispatch_frame();             // fire the pending rAF callback exactly once
  uv_run(loop, UV_RUN_NOWAIT);     // timers, fs, net, worker messages

  present();                       // §6.4 / §7 — soft fb or GL
  render_audio(800);               // §9 — exactly sample_rate/fps frames
  flush_sram_if_dirty();           // §8
  drain_console_to_retro_log();
}
```

### 5.1 Clock virtualization (deliberate decision)

The rAF timestamp and `performance.now()` are **synthetic**: `frameCount * (1000/60)`.
Not wall-clock. Consequences, all desirable:

- **Fast-forward speeds the game up** (correct emulator semantics) instead of breaking
  dt math.
- **Pause/menu freezes game time.**
- WebAudio's `currentTime` advances by samples rendered — automatically consistent with
  the same synthetic clock.

`Date.now()` stays real (games use it for RNG seeds/saves, not frame timing).
`setTimeout`/`setInterval` v1 stay on real libuv time; documented caveat — games that
drive their loop on `setTimeout` instead of rAF will not fast-forward correctly. If it
matters later, reimplement timers on the frame clock in the shim layer (the sandbox owns
the `setTimeout` global, so this is a runtime/ change, not a core change).

`requestAnimationFrame` semantics: single pending callback slot dispatched once per
`retro_run` (port jsgamelauncher's implementation — it's exactly right for this model).

---

## 6. Canvas 2D — @napi-rs/canvas statically linked

Research findings from the `../napi-canvas` checkout (upstream Brooooooklyn/canvas
@1.0.0 with skia + depot_tools submodules):

- The Rust crate does **not** use skia-safe. It binds Skia through its own C wrapper,
  `skia-c/skia_c.cpp` — a surface `../wasmcart-skia` already builds standalone
  (`libskiac.a`). The integration surface is small and already understood in-house.
- Skia is built **CPU-only**: `skia_use_gl=false`, `skia_enable_ganesh=false`,
  `skia_enable_discrete_gpu=false`. Canvas output is a pixel buffer — no GL context
  entanglement with our WebGL binding.
- Everything is already static: freetype, harfbuzz, ICU, libjpeg-turbo, libwebp, libpng,
  expat, wuffs (`skia_use_system_*=false`), linked from `skia/out/Static`. PDF, SVG,
  skottie (Lottie), skparagraph are all enabled — text shaping is better than most
  browser canvases.
- `build.rs` has first-class cross paths for linux x64-gnu, aarch64-gnu/musl,
  arm-gnueabihf, and android-aarch64 (NDK clang). Upstream ships prebuilds for all of
  these — our targets are all officially supported build configs.
- Allocator: mimalloc as Rust global allocator, built with `local_dynamic_tls` on Linux
  — i.e. explicitly configured for living inside a dlopen'd .so. Aligned.
- The `skia/out/Wasm` tree in our checkout (from the wasmcart-skia effort) proves the
  exact source tree compiles for foreign targets; native staticlib is strictly easier.

### 6.1 build-libcanvas (new repo, sibling of build-libnode)

Same model as build-libnode: build once per platform in CI, release tarballs, downstream
fetches binaries.

Per target produces:

```
libcanvas.a            # Rust crate as staticlib (carries skiac + Rust glue)
skia/                  # libskia.a, libskshaper.a, libsvg.a, libskottie.a,
                       # libsksg.a, libskresources.a, libskparagraph.a, libskunicode*.a
include/               # skia_c.hpp (for any direct C use)
js/                    # index.js, geometry.js (DOMMatrix/Point/Rect), load-image.js,
                       # patched js-binding.js (§6.3), index.d.ts
CANVAS_VERSION
```

Build steps per target:

1. `scripts/build-skia.js` unchanged (their gn args, `is_official_build=true`).
2. One-line Cargo patch: `crate-type = ["cdylib"]` → `["staticlib"]`, kept in
   `patches/` per cliemu convention (never a fork drift).
3. `cargo build --release --target <triple>`.
4. Package archives + the JS files.

Targets: all six platforms from day one (§15) — `linux-x86_64`, `linux-aarch64`,
`windows-x86_64`, `macos-x86_64`, `macos-aarch64`, `android-aarch64`. Every one is an
officially supported upstream build config with an existing cross path in `build.rs`.

### 6.2 Registration in the core

```cpp
// napi-rs v3 generates napi_register_module_v1; its export table is built by
// ctors that run when the core .so is dlopen'd.
extern "C" napi_value napi_register_module_v1(napi_env env, napi_value exports);

node::AddLinkedBinding(env, "canvas", napi_register_module_v1, nullptr);
```

**Spike S1 verifies** the staticlib build actually emits the symbol (`nm | grep
napi_register_module_v1`). If napi-rs gates it on cdylib, the fallback is a ~5-line
shim object that calls napi-rs's registration entry — known pattern, not a blocker.
Watch for: only ONE napi staticlib can own that symbol name; if we ever link a second
napi-rs crate, one of them needs `-Wl,--defsym` style renaming or napi-rs's custom
entrypoint support.

### 6.3 JS side

Generated `js-binding.js` (the platform-sniffing `.node` loader) is replaced wholesale:

```js
module.exports = process._linkedBinding('canvas');
```

`index.js`, `geometry.js`, `load-image.js` ship as-is in `runtime/vendor/canvas/`
(pure JS). `load-image.js`'s http/https URL branch is irrelevant — the sandbox provides
its own `loadImage`/`Image` scoped to the game root (port `createLoadImage`/
`createImageClass` from jsgamelauncher's image.js, swapping fs reads for game-root reads
that work in both dir and zip mode).

### 6.4 The display canvas

Same pattern as jsgamelauncher's canvas.js: `createCanvas(w, h)` from @napi-rs/canvas;
the first/default canvas is the screen. Per frame, `canvas.data()` (BGRA premultiplied
— verify channel order once) is presented:

- **Software path** (no HW render context): `RETRO_ENVIRONMENT_SET_PIXEL_FORMAT`
  XRGB8888, `video_cb(canvas.data(), w, h, w*4)`. This is the v1 path — it works on
  every frontend with zero GL code and is exactly the perf profile jsgamelauncher's SDL
  fallback already proves acceptable on handhelds.
- **GL path** (once §7 lands): upload as texture + fullscreen quad into the frontend's
  FBO — the `wc_gl_blit` doctrine; faster at 1080p, required anyway for WebGL games.

Letterboxing/scaling/integer-scale/fullscreen: **deleted**, frontend's job. The core
reports geometry + aspect; RetroArch does the rest. `document.getElementById(*)` returns
the display canvas (jsgamelauncher behavior). `OffscreenCanvas` and additional
`createElement('canvas')` canvases are plain @napi-rs/canvas instances.

Resolution negotiation: default 640×480; `.jsg` JSON config may set dims; game-driven
`canvas.width = ...` triggers `SET_GEOMETRY`. `innerWidth/innerHeight` mirror canvas
dims; `devicePixelRatio = 1`.

---

## 7. WebGL2 — fresh shim over libretro hardware render

Not a webgl-node port (webgl-node owns its EGL context via native-gles; here the
frontend owns the context). But **crib webgl-node's JS bookkeeping** — the
integer-ID↔object tables, enum constants, parameter marshaling, and the
`transformFeedbackVaryings`-class signature lore are backend-agnostic and already
debugged against Three.js. Also crib `../wasmcart/src/webgl_imports.js` patterns
(extension list construction, `getString` overrides).

### 7.1 Context acquisition

- `retro_set_environment`: request `RETRO_HW_CONTEXT_OPENGLES3` via
  `SET_HW_RENDER` (version 3.0). ES 3.0 is the ceiling — deliberately the same ceiling
  as the wasmcart GPU ABI, so every porting lesson transfers both directions.
  Desktop GL fallback (`OPENGL_CORE` 3.3 with the ES-on-core shims) is a later phase;
  Linux/Android frontends do GLES3 natively.
- `context_reset` callback: build the proc table via `hw_render.get_proc_address`,
  mark GL ready. **Lesson already paid for in wasmcart-libretro: save the cart's/game's
  initial GL state at context_reset** (see the `save_cart_gl_state()` fix) and re-handle
  `context_destroy`/`context_reset` (frontend can recreate the context on fullscreen
  toggle etc. — v1 may declare `cache_context = true` to reduce pain, but must still
  survive a reset without crashing; full GL-resource rebuild is out of scope, document
  "context loss = game restart" initially, exactly like early browser WebGL).

### 7.2 The `gl` linked binding

A C++ N-API linked binding (`process._linkedBinding('jsgame_gl')`) exposing the proc
table as flat functions. JS layer on top implements `WebGL2RenderingContext`:

- ID tables for textures/buffers/programs/shaders/VAOs/samplers/sync/queries
  (emscripten-style, same as webgl_imports.js)
- Typed-array views into args (no copies where avoidable)
- `getParameter`/`getString` shims: cap `GL_VERSION`/`GL_SHADING_LANGUAGE_VERSION`
  strings to WebGL2-style values; pass through real `GL_EXTENSIONS` (Godot-on-wasmcart
  taught us engines need them for format detection)
- The state save/restore dance between game GL state and frontend GL state around each
  `retro_run` (port from wasmcart-native's gl_imports.cpp — this code exists and works)

### 7.3 Framebuffer discipline

The frontend gives `get_current_framebuffer()` — the FBO the core must render into.
Same redirect trick as wasmcart-libretro and launcher.js's FBO path:

- Game canvas dims ⇒ our own game FBO + depth/stencil renderbuffer
- Wrap `bindFramebuffer(null)` → bind game FBO
- At present: blit game FBO → `get_current_framebuffer()` (frontend handles final scale)
- `enable_state_tracking`: clear scissor, viewport bookkeeping per frame

When a game requests `canvas.getContext('webgl2')` (or Phaser.AUTO picks WebGL), that
canvas becomes the display canvas (port the `onWebGLCanvas` hook from canvas.js). 2D
display path and GL display path are mutually exclusive per game session — declared at
first getContext, like a browser.

`getContext('webgl')` (WebGL1): return the WebGL2 context behind a WebGL1-shaped class
(distinct constructor identity — the Three.js `instanceof` lesson from launcher.js:148).

### 7.4 ES module loading in the realm

Game entry is loaded as a real ES module graph via `vm.SourceTextModule` (embedded node
controls its own flags, so `--experimental-vm-modules` is just on):

- Custom linker resolves **relative** specifiers against the game root (dir or zip)
- Bare specifiers: hard error with a "bundle your game" message (web parity: browsers
  don't resolve bare specifiers without import maps either; import-map support is a
  possible later nicety)
- `node:`/builtin specifiers: blocked in the game realm, always
- CJS-style games (Phaser UMD bundles etc.) work because they just attach to
  `globalThis` — evaluate as classic script when the entry isn't parseable as a module
  (mirror jsgamelauncher's behavior, which uses dynamic `import()` and tolerates both)

---

## 8. localStorage → SRAM

Replace lowdb-on-fs with libretro save RAM. The frontend then owns persistence: `.srm`
files, per-game paths, save directories, periodic autosave, cloud sync on platforms that
have it.

- Fixed buffer, default 128 KiB, core option `jsgame_sram_size` (128K/512K/1M). Stable
  pointer for the core's lifetime (`retro_get_memory_data` contract).
- Layout: `magic "JSG1" | u32 used_length | CBOR-or-JSON UTF-8 blob` of the key/value
  map. Zeroed buffer ⇒ empty storage.
- Write-through with a dirty flag; serialize at most once per frame in
  `flush_sram_if_dirty()`. Quota behavior: throw `QuotaExceededError` like a browser
  when serialized size exceeds the buffer.
- `retro_get_memory_size(RETRO_MEMORY_SAVE_RAM)` returns the configured size.

This is better than jsgamelauncher's story (scattered lowdb JSON in a config dir) — and
it makes "memory card" mental models work in frontends.

---

## 9. WebAudio — webaudio-node's engine on the libretro sink

webaudio-node's value is its DSP graph engine (sample-accurate scheduling, all node
types, Speex resampler, MP3/WAV/FLAC/OGG/AAC decoders). Its current sink is SDL
push-mode. Here the sink is `retro_audio_sample_batch_t` pull-mode — which the engine
already supports in spirit: `OfflineAudioContext` renders on demand.

Target architecture (native): compile the engine's C/C++ sources (the same sources
currently compiled to WASM — this is *not* a WASM project; WASM was only ever the
portability vehicle) directly into the core, exposed via a `jsgame_audio` linked
binding:

- `audioInit(sampleRate)` / `audioRender(int16* out, frames)` — called from
  `retro_run`, exactly `48000/60 = 800` frames per call, interleaved stereo int16
- The JS-facing `AudioContext`/node-graph API layer from webaudio-node ships in
  `runtime/vendor/webaudio/` with the SDL sink replaced by the pull binding
- `AudioContext.currentTime` = samples_rendered / sample_rate (consistent with the
  synthetic frame clock by construction)

Pragmatic bootstrap option (explicitly allowed for Phase 2 bring-up only): run the
existing WASM build of the engine inside V8 with a pull adapter. Zero new native code,
proves the sink contract, then swap to native and delete. Decide at Phase 2 start based
on how cleanly the C sources extract from the WASM build scripts
(`../webaudio-node/scripts/build-unified-real.sh` is the map).

Audio/video sync: the frontend paces both; we just deliver 800 frames per `retro_run`.
Fast-forward automatically pitch-shifts/skips exactly like every emulator core
(frontend-side resampling handles it).

`Audio` element shim (audio.js) and `Video` stub port from jsgamelauncher unchanged on
top of the WebAudio layer.

---

## 10. Workers (required — not deferred)

### 10.1 Mechanism

`worker_threads` on the embedded Node environment. The platform is already
`MultiIsolatePlatform` (wasmcart chassis), which is the prerequisite.
**Spike S3 verifies** `new Worker()` works under `CommonEnvironmentSetup` embedding
(known to need the multi-isolate platform; needs empirical confirmation in our chassis,
including teardown on content unload).

### 10.2 Web Worker shim

The game never sees `worker_threads`. The sandbox's `Worker` class:

1. Spawns `worker_threads.Worker` on **our** `runtime/worker-bootstrap.js` with
   `workerData = { entry, gameRootHandle, options }`
2. worker-bootstrap builds the same curated sandbox globals inside the worker
   (`self`, `postMessage`, `onmessage`, `fetch`-from-game-root, `performance`, timers —
   no canvas in v1, see 10.3), then evaluates the game's worker script in a vm context
   via the same module loader as the main realm (§7.4)
3. `postMessage` bridges with structured clone (worker_threads native), including
   `SharedArrayBuffer` and transferables — free, and better than the browser baseline
   for game data sharing
4. Blob-URL workers (`new Worker(URL.createObjectURL(blob))`) supported — the blob
   registry lives in the privileged realm (port blob.js)

### 10.3 Canvas/bindings in workers — the open question with three exits

Linked bindings are registered per-Environment; whether worker Environments inherit
`process._linkedBinding('canvas')` is **unverified** (Spike S3 measures it). Exits:

- **If it works:** OffscreenCanvas in workers comes nearly free.
- **If not, v1 stance:** workers are compute-only (physics, pathfinding, audio
  prep — covers essentially every real controller game); main thread owns all rendering.
  Document it.
- **Trump card:** we build libnode ourselves. build-libnode already carries V8 patches;
  "propagate linked bindings to worker Environments" is a carried patch if
  OffscreenCanvas-in-worker ever earns it.

---

## 11. Input

### 11.1 Gamepad API over RetroPad

This is the shim that *shrinks* by moving to libretro: RetroArch's autoconfig +
per-device mapping does what gamepad-node's 2,400-entry database does, before the core
ever sees input. The core reads abstract RetroPad state; every controller is already
"standard mapping."

`navigator.getGamepads()` returns up to 4 pads (ports 0–3), each a browser-shaped
Gamepad object rebuilt each frame from `input_state_cb`:

| Gamepad API `buttons[i]` | W3C position | RetroPad ID |
|---|---|---|
| 0 | bottom face (S) | `JOYPAD_B` (0) |
| 1 | right face (E) | `JOYPAD_A` (8) |
| 2 | left face (W) | `JOYPAD_Y` (1) |
| 3 | top face (N) | `JOYPAD_X` (9) |
| 4 | L1 | `JOYPAD_L` (10) |
| 5 | R1 | `JOYPAD_R` (11) |
| 6 | L2 | `JOYPAD_L2` (12) (analog via `ANALOG_BUTTON`) |
| 7 | R2 | `JOYPAD_R2` (13) (analog via `ANALOG_BUTTON`) |
| 8 | select/back | `JOYPAD_SELECT` (2) |
| 9 | start | `JOYPAD_START` (3) |
| 10 | L3 | `JOYPAD_L3` (14) |
| 11 | R3 | `JOYPAD_R3` (15) |
| 12–15 | dpad U/D/L/R | `JOYPAD_UP/DOWN/LEFT/RIGHT` (4/5/6/7) |
| 16 | guide | — (always unpressed; frontend owns the home button) |

Axes: `RETRO_DEVICE_ANALOG`, `INDEX_LEFT/RIGHT` × `ANALOG_X/Y`, scale
`[-0x8000,0x7FFF]` → `[-1,1]`. Use `RETRO_DEVICE_ID_JOYPAD_MASK` (single call for all
buttons) when the frontend supports it.

`connected`/`gamepadconnected` events: derive from `RETRO_ENVIRONMENT_SET_CONTROLLER_INFO`
/ device-port callbacks where available; otherwise a pad is "connected" if any input or
the frontend reports a device on the port. Keep it simple: ports 0–3 always present,
`mapping: "standard"`, `id: "RetroPad #n"` — games only ever look at buttons/axes.

Rumble: `RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE` → `gamepad.vibrationActuator.playEffect`
("dual-rumble": strong→strong motor, weak→weak motor, duration mapped to per-frame
re-arming since the retro API is set-state not fire-and-forget).

**jsgamelauncher's gamepad hotkeys (exit, fullscreen, FPS, integer scaling) are
deleted** — all are frontend functions now.

### 11.2 Keyboard

`RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK`; queue events, dispatch as `keydown`/`keyup`
(with `key`/`code` translated from `retro_key` — write the table once, it's libretro's
RETROK_* enum which is SDL-shaped) during the frame step, before rAF. Games are
controller-first by mandate, but keyboard works on desktop frontends for dev.

### 11.3 Pointer (low priority)

`RETRO_DEVICE_POINTER` → synthesized `pointerdown/move/up` + mouse compat events on the
canvas, coordinates mapped from libretro's [-0x7FFF,0x7FFF] space to canvas pixels.
Phase 5; controller-first.

---

## 12. Sandbox

### 12.1 Threat model and stance

Games are downloaded JS from itch-style sources. Goal: **no fs, no process, no child
processes, no arbitrary native syscall surface reachable from game code.** Stated
honestly in docs as *isolation, not a hardened security boundary* (Node's `vm` is
documented as escapable by determined attackers; the hard boundary is the wasmcart tier).

### 12.2 Two-realm design

- **Privileged realm** (the main Node context): full Node. Loads runtime, owns the
  linked bindings, the zip reader, WebSocket client, SRAM, workers. Never evaluates
  game-controlled strings.
- **Game realm** (`vm.createContext`): receives ONLY the curated global surface (the
  jsgamelauncher global inventory, §13). No `require`, no `process`, no `module`, no
  `globalThis.constructor.constructor` escape left unfrozen — apply
  `lockdown`-lite: freeze intrinsics reachable from the realm boundary, intercept
  `importModuleDynamically`, null the realm's access to host objects except via the
  shim functions, which validate arguments.
- Crossings audited: every shim that accepts a callback wraps it; every object passed
  in is created realm-side or is a primitive/typed array. Canvas/GL/audio objects are
  host objects by necessity — they're napi externals with fixed method surfaces, which
  is acceptable exposure (methods don't return fs handles).
- `fetch`: game-root-relative paths only (dir or zip). http(s): **off by default**,
  core option `jsgame_network` (`off | websocket | full`) — `websocket` allows
  `WebSocket` but not http fetch; `full` allows https fetch for the adventurous.
- Worker realms get the identical treatment (§10.2).

### 12.3 Explicitly NOT in v1

Separate-isolate hard sandboxing (marshaling tax on the hot path), syscall filtering,
Node permission model (process-wide, would constrain the privileged realm too).

### 12.4 WebAssembly in games — yes, deliberately

`WebAssembly` is part of the curated global surface, in the main realm AND in workers.
jsgamelauncher already supports it (checked box in its README) and real web games use
WASM routinely (physics engines, Rust/wasm-bindgen games, codec internals). V8 is the
runtime — zero added code, Liftoff startup numbers from build-libnode apply.

- **Sandbox impact: positive.** A WASM module touches only its linear memory and the
  imports realm JS hands it — game-shipped WASM is more contained than game-shipped JS.
- **One compat shim:** `instantiateStreaming`/`compileStreaming` expect a real
  `Response`; wrap to fall back to `arrayBuffer()` from our fetch.
- **Threads:** shared `WebAssembly.Module` + `SharedArrayBuffer` across the worker shim
  enables pthreads-style wasm threading (worker_threads gives both natively).
- **North star (tracked, not promised):** Godot/Unity *web exports* are WASM + WebGL2 +
  WebAudio + Gamepad + SAB threads — exactly this core's surface. Expect a tail of
  Emscripten-browser-glue shim gaps; revisit after M3 with a Godot web export as the
  test subject.
- **Boundary with wasmcart stays clean:** wasmcart runs carts (`wc_*` ABI, hard
  sandbox); jsgame runs web games that may contain WASM as an implementation detail.

---

## 13. Shim inventory (port map from jsgamelauncher)

The bootstrap is launcher.js reborn, minus everything the frontend now owns. Per-file
disposition of `../jsgamelauncher`:

| jsgamelauncher file | Disposition |
|---|---|
| `launcher.js` global setup (window/self/document/MutationObserver/screen) | port into `runtime/bootstrap.js`, realm-side |
| `launcher.js` entry resolution (package.json main → fallbacks) | port (minus auto-npm-install) |
| `launcher.js` rAF/cancelRAF | port as-is |
| `launcher.js` EGL three-tier + SDL window + resize/letterbox/FPS/hotkeys | **delete** (frontend) |
| `canvas.js` (createCanvas, display-canvas tracking, onWebGLCanvas) | port, present() swapped for libretro paths |
| `image.js` (createImageClass/createLoadImage) | port, fs reads → game-root reads (dir/zip) |
| `fetch.js` / `xhr.js` | port, same game-root scoping + network policy |
| `blob.js` | port as-is |
| `localstorage.js` (lowdb) | **replace** with SRAM binding (§8) |
| `fontface.js` | port; `GlobalFonts.register(buffer)` from game root (works from zip) |
| `events.js` (resize/loading events) | port, trimmed (no window resize concept) |
| `audio.js` / `video.js` elements | port on top of §9 |
| `gamepads.js` / gamepad-node | **replace** with RetroPad shim (§11) — much smaller |
| `options.js` (CLI flags) | **replace** with core options + `.jsg` JSON config |
| Worker via `web-worker` pkg | **replace** with own shim (§10.2) |
| `WebSocket` via `ws` | port (privileged realm owns the socket; realm gets a façade) |
| `Module._load` noop-proxy hack for optional CJS deps | port (cheap, saves real games) |

Core options (initial set):

```
jsgame_sram_size      = 128K | 512K | 1M
jsgame_network        = off | websocket | full
jsgame_resolution     = game | 640x480 | 960x540 | 1280x720   (overrides default only)
jsgame_log_level      = error | info | debug                  (console → retro_log)
```

---

## 14. Repo layout

```
jsgame-libretro/
├── PLAN.md                      ← this file
├── CMakeLists.txt               ← mirrors wasmcart-libretro; LIBNODE_DIR, LIBCANVAS_DIR
├── jsgame_libretro.info
├── src/
│   ├── libretro.c               ← entry points, env negotiation, AV info, SRAM,
│   │                              input poll, video/audio presentation
│   ├── node_host.cpp/.h         ← chassis: libnode lifecycle, uv pump, realm mgmt
│   ├── binding_canvas.cpp       ← AddLinkedBinding("canvas", …) registration
│   ├── binding_gl.cpp           ← proc-table → N-API flat GL functions + state dance
│   ├── binding_audio.cpp        ← webaudio engine init/render
│   ├── binding_io.cpp           ← SRAM, zip asset reads, log, shutdown
│   └── embedded_runtime.S       ← incbin of runtime.zip
├── runtime/                     ← privileged JS (plain ESM + JSDoc, no TS)
│   ├── bootstrap.js             ← realm construction, global curation, entry loading
│   ├── worker-bootstrap.js
│   ├── shims/                   ← canvas, webgl2, webaudio, gamepad, keyboard, fetch,
│   │                              xhr, blob, fontface, storage, websocket, worker
│   └── vendor/
│       ├── canvas/              ← index.js, geometry.js + linkedBinding js-binding.js
│       └── webaudio/            ← graph API layer, pull sink
├── deps/                        ← fetched, gitignored (libnode/, libcanvas/, angle/)
├── scripts/
│   ├── fetch-deps.sh            ← pulls build-libnode + build-libcanvas GitHub releases
│   ├── build.sh                 ← local build, current platform (CI calls this too)
│   ├── build-android.sh         ← local NDK cross build
│   ├── versions.json            ← pinned dep release tags (cliemu convention)
│   └── patches/                 ← any carried patches (napi-canvas staticlib, libnode)
├── .github/workflows/
│   └── build.yml                ← 6-target matrix → GitHub Release (§15)
└── test-games/                  ← tiny fixtures; real testing uses ../../jsgames
```

Conventions honored: plain JS ESM + JSDoc (no TypeScript); no dev work in /tmp; pinned
fetched deps with real versions in `scripts/versions.json`; patches live in
`scripts/patches/`; no absolute home paths in the tree.

---

## 15. Build, CI, and releases — six platforms, everything hosted on GitHub

Direct lesson from build-libnode and wasmcart-libretro: **CI builds binaries once per
release; downstream (including our own core CI) only ever downloads them from GitHub
Releases.** No source builds of dependencies in the core's CI, no artifacts hosted
anywhere but GitHub.

### Target matrix (all six from day one)

| Target | GH Actions runner | Toolchain notes |
|---|---|---|
| linux-x86_64 | `ubuntu-22.04` | gcc/clang; oldest supported glibc baseline for handheld distros |
| linux-aarch64 | `ubuntu-22.04-arm` | native arm runner (fall back to cross + qemu smoke test if needed) |
| windows-x86_64 | `windows-2022` | clang-cl/MSVC; lib.exe merge lore from build-libnode; **ANGLE** for GLES3 |
| macos-x86_64 | `macos-13` | Intel runner; **ANGLE** for GLES3 |
| macos-aarch64 | `macos-14` | Apple Silicon runner; **ANGLE** for GLES3 |
| android-aarch64 | `ubuntu-22.04` + NDK | NDK r26+ clang; build-libnode android target + V8 TLS patch already exist |

ANGLE on Windows/macOS: same approach as wasmcart-libretro (`-DANGLE_DIR=...`); consider
a third tiny binary-release repo (`build-angle`) if fetching prebuilt ANGLE proves
annoying — same pattern, decided when Windows/macOS phase lands.

### Three repos, three release streams, all GitHub Releases

1. **build-libnode** (exists) — `libnode-<platform>.tar.gz` per Node version tag.
2. **build-libcanvas** (new, §6.1) — `libcanvas-<platform>.tar.gz` per canvas version
   tag. Same workflow shape as build-libnode: tag push or manual dispatch → 6 parallel
   jobs → one GitHub Release with all archives attached. Skia build is the long pole
   (~30-60 min/target) which is exactly why it's prebuilt here and nowhere else.
3. **jsgame-libretro** — `jsgame_libretro-<platform>.zip` containing the core
   (`.so`/`.dll`/`.dylib`) + `jsgame_libretro.info`. Because deps arrive prebuilt, core
   CI is fast (minutes): fetch-deps → cmake → package → Release. Tag push creates the
   Release; manual dispatch builds without releasing. Releases are deliberate, not
   nightly (build-libnode's stated policy, same reasoning — version alignment is a
   decision, not an accident).

`scripts/versions.json` pins exact dep release tags (real tags, not branches — cliemu
provenance convention). Bumping a dep is a one-line PR.

### Local builds (first-class, not an afterthought)

CI must call the **same scripts** a developer runs — no CI-only build logic:

```bash
./scripts/fetch-deps.sh            # downloads pinned libnode/libcanvas releases
./scripts/build.sh                 # current platform → build/jsgame_libretro.so
./scripts/build.sh --debug         # + runtime/ loaded from disk for fast JS iteration
NDK_PATH=~/android-ndk ./scripts/build-android.sh
```

`build.sh --debug` skips the embedded-runtime blob and reads `runtime/` from the source
tree (env var override, §4.3), so shim development is edit-and-relaunch with no C
rebuild.

### Android note

RetroArch's Play Store build cannot sideload cores; document that Android users need
the website/F-Droid APK (standard situation for out-of-buildbot cores). Long-term fix is
buildbot inclusion (Phase 6).

---

## 16. Phases, spikes, milestones

### Phase 0 — De-risk spikes (each is a day-scale experiment with a yes/no answer)

- **S1 — staticlib symbol.** Build napi-canvas as `staticlib` for linux-x86_64
  (their Docker images make this turnkey). Acceptance: `nm libcanvas.a | grep
  napi_register_module_v1` (or fallback shim identified); link into a trivial .so with
  libnode without symbol collisions (`--allow-multiple-definition` lore as needed).
- **S2 — linked binding draw.** Fork the wasmcart-libretro chassis; `AddLinkedBinding`;
  privileged JS does `createCanvas(320,240)`, fills a rect, core presents via software
  framebuffer in RetroArch. Acceptance: pixels on screen, 60fps, clean content
  load/unload twice in one session.
- **S3 — workers.** Inside S2's chassis: spawn `worker_threads.Worker`, round-trip a
  message and a SharedArrayBuffer, report whether `process._linkedBinding('canvas')`
  resolves in the worker. Acceptance: both facts known; teardown leak-free across
  content unload.
- **S4 — zip-as-rom.** `.jsgame` extension + `block_extract=true`; read entry +
  asset out of the zip in the privileged realm. Acceptance: RetroArch passes the
  archive path untouched; image asset decodes from zip memory.
- **S5 — GL triangle.** `SET_HW_RENDER` GLES3, proc-table binding, JS-side
  `glClear` + one triangle into the redirect FBO, blit to
  `get_current_framebuffer()`. Acceptance: triangle in RetroArch, survives fullscreen
  toggle (context_reset) without crashing.
- **S6 — audio tone.** 440Hz sine from a JS-driven render loop through
  `retro_audio_sample_batch`, 800 frames/frame. Acceptance: clean tone, no underrun
  warnings, pitch shifts under fast-forward.

S1+S2 first (they gate everything); S3–S6 parallelizable after.

Phase 0 exit also stands up the infrastructure: this repo's skeleton with the 6-target
GitHub Actions workflow building the bare chassis on every platform (catch toolchain
problems before there's real code), and the **build-libcanvas repo with its first
tagged GitHub Release** — S1's staticlib build, promoted to CI, is exactly that release.

### Phase 1 — 2D MVP

Software framebuffer path end-to-end: bootstrap, game realm + module loader, canvas 2D,
gamepad shim, synthetic clock, SRAM localStorage, dir + zip content modes, console →
retro_log. **Milestone M1: a stock 2D demo from the jsgames repo runs unmodified in
RetroArch on desktop Linux.**

### Phase 2 — Audio

webaudio engine integration (native target; WASM-in-V8 bridge acceptable as scaffold,
then deleted), Audio element shim, decoders verified (MP3/OGG/WAV minimum).
**Milestone M2: a jsgames demo with music + SFX, correct under fast-forward.**

### Phase 3 — WebGL2

GL binding, FBO discipline, WebGL2RenderingContext layer, onWebGLCanvas display
switching, GL-blit path for 2D canvases. **Milestone M3: a Three.js demo and a
Phaser-WebGL game run unmodified.** (Phaser exercises 2D-on-GL + canvas-into-texture
paths hard; it's the best single test.)

### Phase 4 — Workers + networking

Worker shim per §10, WebSocket façade + network core option, blob-URL workers.
**Milestone M4: a game using a worker + a WebSocket echo test, sandbox policy enforced.**

### Phase 5 — Platforms + polish

The six-target CI matrix exists from Phase 0 (§15) — this phase is about *verifying*
the non-Linux-desktop targets, not creating them: aarch64 handheld + Android device
testing, ANGLE bring-up validation on Windows/macOS, keyboard/pointer shims, core
options UI strings, context_destroy robustness pass, perf pass on real handheld
hardware. **Milestone M5: same `.jsgame` file runs on a Knulli/ROCKNIX handheld and an
Android device via RetroArch, downloaded from a GitHub Release.**

### Phase 6 — Hardening + distribution

Sandbox audit (escape-hunt against the realm boundary), docs (generic phrasing per the
no-commercial-names rule for anything end-user-facing), installer-free install docs,
buildbot/core-downloader exploration, decide on chassis convergence with
wasmcart-libretro (shared `libnode-libretro` layer).

---

## 17. Risk register

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | napi-rs staticlib doesn't emit register symbol | Low | 5-line registration shim; napi-rs has static-link precedent (iOS targets) |
| 2 | Skia staticlib build breaks on some target | Low | Upstream prebuilds prove every target config; we reuse their Docker images + gn args verbatim |
| 3 | worker_threads unsupported/flaky under embedder setup | Medium | MultiIsolatePlatform already in chassis; if broken, patch libnode (we own the build) — S3 answers early |
| 4 | Linked bindings invisible in workers | Medium | Compute-only workers v1 (acceptable); carried libnode patch later |
| 5 | GL context_reset churn (driver/job loss) breaks games | Medium | `cache_context=true`; "context loss restarts game" documented v1; resource-rebuild later |
| 6 | Two libnode-bearing cores in one frontend session collide | Medium | Hidden visibility everywhere; audit in Phase 0 alongside wasmcart-libretro; shared chassis eliminates it long-term |
| 7 | Core size (~95MB) raises eyebrows | Certain | It replaces a Node install; document; strip aggressively; ICU is already out of libnode (kept in Skia only) |
| 8 | vm realm escape | Certain (theoretically) | Stated stance §12.1; frozen intrinsics; no fs/process reachable; hard tier = wasmcart |
| 9 | setTimeout-driven games misbehave under fast-forward | Low | Documented; frame-clock timers in shim layer if needed |
| 10 | `.data()` channel order / premultiply mismatch on present | Low | One-time verification in S2 (it bit the SDL path once in jsgamelauncher land) |

---

## 18. Open questions (tracked, none blocking Phase 0)

1. `.jsgame` vs reusing `.jsg` for zips — leaning `.jsgame` (dir-marker vs archive stay
   visually distinct); confirm no frontend treats unknown-extension zips specially even
   with block_extract.
2. Entry-as-classic-script vs module sniffing rules — match jsgamelauncher behavior
   exactly or document a stricter rule?
3. Should `.jsg` JSON config be able to declare `network: ["host:port"]` allowlist that
   tightens/loosens the core option? (Manifest-driven, wasmcart-style.)
4. Audio engine native extraction effort — answered at Phase 2 start by reading
   webaudio-node's build scripts; decides scaffold strategy.
5. Frontends below 60Hz (PAL 50) — declare 60 and let frontend resample, or honor
   `GET_TARGET_REFRESH_RATE`? v1: declare 60 always.
6. Desktop GL fallback priority — do Windows/macOS users matter before ANGLE work? Both
   need ANGLE for GLES3 (reuse wasmcart-libretro notes); deferred to Phase 5+.
7. Multi-content / subsystem support (load a second zip as a "DLC" mount)? Not v1.
8. Chassis convergence timing with wasmcart-libretro (fork now is decided; when to
   extract the shared layer?).

---

## 19. Success criteria

1. A stock game from the jsgames sample repo — built for the web, never having heard of
   this core — runs in RetroArch from a `.jsgame` zip with correct video, audio, input,
   and saves.
2. The same zip runs on desktop Linux x86_64 and an aarch64 handheld with no changes.
3. jsgamelauncher's installers directory becomes optional documentation, not
   infrastructure: "or just install the jsgame core in RetroArch."
4. Game code cannot read the filesystem, spawn processes, or reach the network outside
   the declared policy — verified by tests that try.
5. Core passes RetroArch's content load → unload → load cycle without leaks or crashes,
   twice over, with a wasmcart cart loaded in between.

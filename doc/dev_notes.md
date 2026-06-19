# jsgame-libretro — dev notes (hard-won gotchas)

Read this BEFORE touching audio, frame pacing, or the video/present path. These
took a long time to debug; the root causes are non-obvious. Source of truth for
architecture is `PLAN.md`; this file is the "don't repeat these mistakes" list.

---

## 1. Audio MUST be wall-clock based, NOT fixed-per-frame

**Symptom:** choppy / stuttering sound (worst on a continuous tone, hides on
sparse SFX). Often appears at <60fps or jittery fps.

**Root cause:** audio was produced as a fixed **800 frames per video frame**
(`48000/60`). That ties audio rate to fps: `audio_rate = fps * 800`. Any fps
dip/jitter → wrong audio rate → gaps. A browser's `AudioContext` never does
this — it renders in real time, independent of `requestAnimationFrame`.

**The fix (in `runtime/bootstrap.js` `__jsg_frame`):** render the number of
audio frames that *real elapsed wall-clock time* demands:
`nFrames = elapsedMs * (48000/1000) + carry`, clamp 1..4096, keep a fractional
`audioDebt` carry so it never drifts. This is THE web-correct model.

**And `jsg_host_audio` (node_host.cpp) must deliver EVERYTHING banked**, not a
capped 800/call. A 30fps frame banks ~1600 audio frames; delivering only 800
backs up the ring → drop-oldest → choppy. Cap only at the out-buffer size.

**Do NOT "fix" choppy audio by:** changing the audio driver (sdl2/alsathread),
audio_latency, or `audio_sync`. Those are red herrings — we tried them all, the
bug was always the fixed-per-frame production. The driver/latency don't matter
once audio is wall-clock based.

**Async vs sync audio callback:** `SET_AUDIO_CALLBACK` (async) busy-spins on
Android-style frontends — the audio thread calls our callback **~23M times/sec**,
almost always on an empty ring, starving playback AND stealing CPU. We default to
the **sync path** (deliver audio inside `retro_run`). `JSGAME_ASYNC_AUDIO=1`
re-enables the callback only for comparison.

---

## 2. Frame pacing: ONE clock, and beware double-pacing

**Symptom A — runs at thousands of fps** (e.g. `fps(real): 6000`): the present
path isn't throttled.
- The **GL hardware-render present is NOT reliably vsync-throttled** in the
  flatpak (glcore) driver. Do not assume "GL path is driver-paced" — it free-runs.
- The **software present path** is never vsync-paced either.
- Free-running spawns game objects per real frame → with WebGL, object/particle
  explosion → **freeze**.

**Fix:** the core paces `retro_run` to 60fps itself (`pace_60fps()` in
libretro.c), for BOTH GL and software paths. This is safe because audio is
wall-clock based (gotcha #1) — capping the frame rate does not affect audio.

**Symptom B — game runs at exactly 30fps / half speed:** **double-pacing.** If
RetroArch's `video_vsync = true` AND our `pace_60fps()` both throttle, they
stack → 30fps. The core pacer is the single clock; RA vsync should be off for
this core (or the pacer made vsync-aware). `fps(real)` reading 60→30→15 jitter
is the fingerprint.

**Symptom C — game feels slow but `timing/600f` shows cb<2ms, slow=0:** the work
is fast; the *pacer* is over-sleeping. `nanosleep` overshoots (kernel tick
granularity = several ms). **Do not sleep the whole wait** (lands long → 30fps)
and **do not busy-wait the whole wait** (burns a CPU core → starves the game).
The pacer sleeps until ~1.5ms short, then busy-trims the last ~1.5ms.

---

## 3. Games MUST use delta-time, not per-frame movement

A game that does `ship.x += 6.5` moves at half speed at 30fps. Correct games
multiply by `dt` (delta seconds): `ship.x += speed_px_per_sec * dt`, timers in
seconds. The rAF timestamp is a **synthetic clock** (`now += 1000/60` in
realm.js), so `dt` derived from it is steady — but games should still be written
delta-time-correct (and clamp `dt` to avoid teleport on a hitch/pause).
See `test-games/star-catcher/main.js` for the reference pattern.

---

## 4. Present paths: GL-native vs 2D-software vs GL-composite

There are THREE present cases. `gl_active` = the game used WebGL anywhere (so
`SET_HW_RENDER` succeeded and RA is in **hardware-render mode**).

| Case | display canvas | how it presents |
|------|----------------|-----------------|
| A. GL-native | the WebGL canvas (`_isWebGL`) | `video_cb(RETRO_HW_FRAME_BUFFER_VALID)` — present RA's FBO directly |
| B. GL + 2D composite | a 2D canvas, but `gl_active` (3D scene + 2D HUD) | **GPU composite** (preferred) or **gl_blit** (fallback) — see §9 |
| C. pure software | a 2D canvas, no GL | `video_cb(software_pixels)` directly |

**THE TRAP (case B):** once `gl_active`, RetroArch is in HW-render mode and
**ignores software `video_cb` frames entirely**. So a WebGL game that composites
its scene onto a 2D display canvas (3D + a 2D HUD) gets a BLACK screen — every
2D draw is silently dropped. Diagnosing this wasted a lot of time; the tell is
`getImageData` shows your pixels in the canvas, but they never reach the screen.

**Case B is the only path that ever needs GPU-backed (Ganesh) Skia.** Cases A
and C never touch Ganesh — A presents the WebGL FBO straight, C uses the CPU
raster + software `video_cb`. So GPU-Skia is opt-in PER FRAME, only when a 3D
game composites onto a 2D HUD. See §9 for the two case-B implementations (GPU
composite = no readback; gl_blit = the readback fallback).

---

## 5. Web compat: `ctx2d.drawImage(webglCanvas)` is supported — keep it that way

A browser lets you `ctx2d.drawImage(aWebGLCanvas, 0, 0)` to composite a WebGL
canvas onto a 2D one (standard HUD-over-3D pattern). The engine special-cases it
in `runtime/realm.js`'s `drawImage` override (detects `image._isWebGL`), with
TWO implementations chosen automatically:

- **GPU path (preferred, no readback)** — when the Ganesh libcanvas is present
  and a `GrContext` is live (3D mode). The WebGL scene becomes its own GL texture
  and the HUD a transparent Skia GPU surface; they're composited GPU-to-GPU at
  present. See §9. This is what makes the standard web pattern fast.
- **CPU fallback (readback)** — `_snapshotInto(targetCtx, rawGetImageData,
  rawPutImageData)` (`runtime/vendor/webgl/webgl2-context.mjs`): `glReadPixels`
  the live default FBO, flip bottom-up→top-down, `putImageData` into the SAME 2D
  context so subsequent `fillText`/HUD draws land on top. Used on CPU-only
  libcanvas or if GPU init fails.

Either way the GAME code is unchanged — it's the standard `drawImage(glCanvas)` +
`fillText`. **Never route a game around this with `WebGLRenderTarget` + manual
readback — that's a shortcut; the point is web compatibility.**

---

## 6. GL context negotiation — don't trust GET_PREFERRED_HW_RENDER

Android's GLES build reports `RETRO_HW_CONTEXT_OPENGL` even though it's GLES, so
trusting the "preferred" value made us request desktop GL on a GLES-only frontend
→ rejected → black. **Fix:** TRY each context type (`OPENGLES3`, then
`OPENGL_CORE 3.3`, then `OPENGL`) and keep the first `SET_HW_RENDER` that
succeeds (libretro.c). Desktop GL also needs GLES `#version 300 es` shaders
translated to `#version 330 core` (`jsg_gl_set_desktop` → gl_bindings.cpp).

**Per-frame default FBO:** RetroArch's default framebuffer id can change every
frame — always call `get_current_framebuffer()` live, never cache it, or
`bindFramebuffer(null)` targets a stale FBO and nothing shows.

---

## 7. Three.js (and any WebGL2 engine) gotchas

- **`WebGL2RenderingContext` must be a global** — Three feature-detects WebGL2
  via `typeof WebGL2RenderingContext !== 'undefined' && gl.constructor.name ===
  'WebGL2RenderingContext'`. realm.js exposes it; without it Three falls back to
  WebGL1 (`attribute`/`varying` shaders that desktop GL rejects).
- **One material per object = freeze.** Each `MeshStandardMaterial` (or `.clone()`)
  compiles a fresh GPU shader. Creating a new/cloned material per enemy/particle
  → hundreds of shader compiles → freeze. **Reuse shared materials.**
- **Scene too dark?** set `renderer.outputColorSpace = THREE.SRGBColorSpace` and
  a tone mapping (`ACESFilmicToneMapping`, exposure ~1.5); raw linear output
  looks near-black.

---

## 8. Node 26 / libnode gotchas

- **`vm.SourceTextModule is not a constructor`** (every game fails to boot): the
  realm's ESM loader needs `--experimental-vm-modules`. On libnode 26 it must be
  in the **`InitializeOncePerProcess` argv** (process init), NOT only
  `NODE_OPTIONS` / per-Environment `exec_args`. See `node_host.cpp`.
- **glibc floor:** a libnode-26 build links some libm float-math symbols at
  `GLIBC_2.43`, which won't load on older runtimes (flatpak glibc 2.42). The core
  `--wrap`s them to `@GLIBC_2.2.5` (`src/glibc_compat.c`).

---

## 9. Present: GPU composite (no readback) vs the gl_blit fallback

**WHEN IS GANESH (GPU-Skia) USED? Only in case B (3D scene + 2D HUD), per frame.**
Not "always." The decision tree:
- **Pure 2D game (no WebGL):** CPU raster Skia + software `video_cb`. NO Ganesh.
  This is the common case and it never touches the GPU-Skia path. (CPU raster is
  also more robust — Ganesh has been flaky for pure-2D, so we deliberately keep
  2D on CPU.)
- **GL-native game (display canvas IS the WebGL canvas):** present RA's FBO
  directly. NO Skia at all.
- **3D + 2D HUD (`gl_active`, display is a 2D canvas):** THIS is the only case
  that uses Ganesh — and only the HUD 2D surface is GPU-backed (the 3D scene is
  raw GL). If the Ganesh libcanvas is present and `GrContext` init succeeds, use
  the GPU composite; otherwise fall back to gl_blit (readback). The game's
  `drawImage(glCanvas)` triggers the upgrade lazily (`jsgUpgradeToGpu`).

So: a GPU-backed Skia surface is created ONLY for the display canvas of a 3D-plus-
HUD game, and only on a Ganesh build. Everything else stays CPU/native. The
libcanvas IS built with Ganesh enabled on every platform now, but the GPU
surface is opt-in at runtime (gated on a `GrDirectContext` being supplied) — so
shipping Ganesh doesn't change the CPU path for 2D games.

There are TWO Case-B (GL + 2D HUD) present paths:

**GPU composite (preferred, zero readback)** — when libcanvas is the Ganesh
build (Skia `skia_use_gl=true`). The `drawImage(glCanvas)` GPU path splits the
frame into TWO GPU textures composited at present, NO GPU→CPU→GPU round-trip:
1. **scene** → `jsgSceneTexture`: `glBlitFramebuffer` the WebGL FBO into a plain
   GL texture, presented directly (opaque).
2. **HUD** → `jsgGpuClearTransparent` on a Skia GPU surface; the game's following
   `fillText`/`fillRect` form a transparent overlay; present alpha-blends it over
   the scene (premultiplied `GL_ONE / GL_ONE_MINUS_SRC_ALPHA`).
Measured `cb` ≈ 0.3–0.6ms (vs ~1.75ms for the readback path). Scene + HUD are
SEPARATE textures because **Skia GPU draws don't land in an externally raw-written
texture** — don't try to raw-blit the scene into the Skia surface and have Skia
composite the HUD on top of it (the scene survives, the HUD/Skia draws don't).

**gl_blit fallback (readback)** — CPU-only libcanvas, or if the GrDirectContext
fails to init. The old `readPixels` + re-upload path (`src/gl_blit.c`
`jsg_gl_blit_present`). ~1.3ms/frame at 480p. Still correct, just slower.

**⚠ GL-STANDARD GOTCHA (cost a lot of time):** Skia's `skia_gl_standard` MUST
match the runtime GL — **`gles` for Android (ship target), `gl` for a desktop
GL-core context** (the local flatpak RetroArch is desktop GL-core, not GLES,
despite us requesting GLES3 first). On a MISMATCH, Ganesh emits the wrong shader
dialect and **every shader-based Skia draw silently no-ops — text/rect/image all
vanish while `clear()` still works** (clear needs no shader). The raw-GL scene
path is unaffected (no Skia shaders), so the symptom is "3D scene perfect, HUD
text missing." Build-libcanvas defaults to `gles`; for a local desktop test
build set `CANVAS_SKIA_GL_STANDARD=gl`. (Browsers dodge this via ANGLE.)

The full napi-canvas GPU surface API (GrContext from RA's get_proc_address,
`Surface::new_gpu`, transparent-clear, texture-id) is patched into the upstream
canvas crate via `build-libcanvas/patches/ganesh-gpu.patch`.

---

## 10. How to test fast (don't re-derive this)

- **Headless harness** (`./test/harness build/jsgame_libretro.so <game>.jsg N`):
  CPU-only, NO GL context — WebGL games WILL log "no GL context / Error creating
  WebGL context". That's expected; it only validates JS-boots-clean + Canvas2D +
  audio (`audio peak` > 0 means sound output works).
- **GL games must run in real RetroArch** (the flatpak here provides desktop
  GL-core). Drive it: `flatpak run org.libretro.RetroArch -v -L <core.so> <game>`,
  screenshot via the network command (`network_cmd_enable=true`, port 55355):
  `echo -n SCREENSHOT | nc -u -w1 127.0.0.1 55355`.
- **Check fps/timing:** run with `-v`, grep `fps(real)` and `timing/600f`
  (`cb`=game+render, `audio`, `present`, `max` ms, `slow(>16ms)` count).
- **Pixel-diff two screenshots** to tell "frozen" from "animating" — a black
  screen with the game logging 60fps is a PRESENT bug, not a logic hang.

---

## 11. Windows build: per-platform deps + CRT/LTO landmines

Getting the Windows core to link was a STACK of independent issues (2026-06-16).
The diagnosis cost ~a dozen ~40-min CI cycles because there's no local Windows
repro — read this before touching the Windows build. Errors peeled off in order
(thousands → 52 → 4 → 2 → 1 → 0); each layer hid the next.

- **POSIX-isms break MSVC compile.** `CLOCK_MONOTONIC`/`clock_gettime`,
  `<strings.h>` (`strcasecmp`), `nanosleep`/`struct timespec` are POSIX-only.
  Guard with `#ifdef _WIN32`: `QueryPerformanceCounter`, `_stricmp`/`_strnicmp`,
  `Sleep()`. (`src/libretro.c`, `src/gl_detect.c`.)
- **`find_program(ZIP_EXECUTABLE zip REQUIRED)`** in CMakeLists fails — the
  windows runner has 7z but not GNU `zip`. CI installs it (`choco install zip`).
- **Runner must be `windows-2025`, not `windows-2022`.** libnode v26's `.lib`
  needs a newer MSVC STL; on 2022 the link fails on `__std_min_element_8i` /
  `__std_rotate` / `__std_unique_*` (vectorized STL helpers).
- **libnode v26 dropped N-API on Windows (THE big one).** Node 24+ FORCES
  clang-cl, and `vcbuild release` FORCES Thin-LTO → libnode/napi objects are LLVM
  BITCODE: MSVC `lib.exe` can't archive them (LNK1136) and MSVC `link.exe` can't
  resolve symbols from them (LNK2001 napi_*). Fixed in build-libnode (tag
  v26.3.0-jsg9): DISABLE LTO so clang-cl emits real COFF (strip the `&set ltcg=1`
  vcbuild adds on `release`), then merge ALL `*.lib` INCLUDING the self-emitted
  `libnode.lib` (it holds the `node::` internals — Buffer/AsyncResource/
  MakeCallback/CleanupQueue — that `node_api.obj` references). Full saga in
  internal memory `build-libnode-windows-napi-lto`.
- **Consumer link needs the right system libs + CRT (CMakeLists `if(WIN32)`):**
  - `opengl32` — Skia's `GrGLMakeWinInterface` (wglGetProcAddress/CurrentContext).
  - `ucrt` — a few libcanvas libaom objects reference the dynamic-UCRT import
    form `__imp_log1pf` / `__imp_fmax`.
  - CRT must be **/MT** (`MultiThreadedDLL` is WRONG here): libcanvas is ~4057
    objects `/MT`. `CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded"` (Release-only;
    `MultiThreadedDLLDebug` is an INVALID value), plus `/NODEFAULTLIB:msvcrt`.
- **libcanvas's lone Rust object was `/MD`** (`…-static.o`) → 1 unkillable
  LNK2038/LNK1319 against the `/MT` bulk (LNK2038 can't be `/FORCE`d away).
  Fixed at the source in build-libcanvas (tag v1.0.0-jsg8): build the Rust
  staticlib with `RUSTFLAGS=-C target-feature=+crt-static` on Windows so the
  whole `.lib` is uniformly `/MT`.
- **Don't local-build Windows** — you can't here (Linux). All Windows debugging
  is CI-only; locally you can `nm`/`ar` a downloaded `.lib` (COFF archives read
  fine on Linux: `nm libnode.lib | grep 'T napi_create_function'`, ~145 defs =
  good) and edit the YAML/CMake, but the build/link loop is GitHub Actions.

## 12. Threaded wasm (emscripten pthreads) — make the realm look like Node

Threaded wasm (e.g. box2d3-wasm's "deluxe" build, `b2CreateThreadedWorld` +
enkiTS) is FIRST-CLASS and works in the core. The hard part was a wrong mental
model, not the tech: libnode has had `worker_threads` + `SharedArrayBuffer` since
the S3 spike (`bootstrap.js`), so threading was always *possible* — emscripten
just couldn't *find* it.

**Why it failed at first (the trap):** emscripten's glue picks Node vs browser via
`ENVIRONMENT_IS_NODE = typeof process == 'object' && …versions.node`. The realm is
a soft sandbox that HID `process`/`require` (realm.js header: "No fs, no process,
no require"). So emscripten took the BROWSER path:
`new Worker(new URL('Box2D.deluxe.mjs', import.meta.url), {type:'module'})`. That
can't work here — the old GameWorker shim only sourced game-authored worker files
from disk (and failed in zip mode: no `gameRoot`), and `import.meta.url` was a
`jsg://` virtual URL. Result: `no worker source` / silent hang.

**The design: BROWSER path + a real module Worker (NOT the Node path).** Games are
browser games — they need exactly what a browser gives, nothing more. The first
working version made the realm look like Node (real process, scoped require with
fs, etc.) so emscripten took its Node path — but that's the WRONG fork: it hands
game code fs/process it should never have. The RIGHT fork: keep the realm a
browser (it already has `window`/`fetch`/`WebAssembly`), give it a real
`Worker(url, {type:'module'})`, and emscripten takes its BROWSER path — which uses
`new Worker` + `SharedArrayBuffer` and touches NO fs/process. (emscripten gates
the env: `ENVIRONMENT_IS_NODE = typeof process == 'object' && …node`; the fs/
process/worker_threads code is all inside `if (ENVIRONMENT_IS_NODE)`. No `process`
→ browser path → none of it loads.)

**The fix (all in `runtime/`; libnode unchanged):**
- **content.js** — zip `.jsgame` EXTRACTS to a temp dir
  (`os.tmpdir()/jsgame-content-<sha1>`, content-addressed + reused, pruned to ~6
  MRU) and sets `content.root`. A real on-disk root is REQUIRED so the pthread
  worker URL `new URL('X.mjs', import.meta.url)` resolves to a real file. Reads
  still use the in-memory unzip map.
- **realm.js**:
  - `initializeImportMeta` → real `file://` URL when `content.root` exists. Makes
    the worker URL real.
  - NO `process`/`require`/`fs`/`global`/`__dirname` in the sandbox. Game code
    sees a browser. (Verified adversarially: `typeof process/require/global/
    __dirname === 'undefined'`; `require('fs')` AND `import('fs')` both blocked.)
  - `GameWorker` is a real browser-style module Worker: resolves the scriptUrl
    (URL object / `file://` / `jsg:///rel` / `./rel`) to a real on-disk module,
    spawns a `worker_threads.Worker` running `worker-module-bootstrap.mjs`.
  - `SharedArrayBuffer`/`Atomics` exposed (browser-standard; how a pthread shares
    memory).
  - Standard web event classes (Event/EventTarget/CustomEvent/MessageEvent/…) —
    emscripten + many libs reference them.
- **worker-module-bootstrap.mjs** — runs the emscripten module in a real
  worker_threads worker. KEY: it does NOT shim a browser surface (that confused
  emscripten's detection); in the WORKER, emscripten's own Node-worker path wires
  `parentPort`<->`onmessage` itself and works natively. The worker MUST be
  launched with `workerData === 'em-pthread'` (the exact string emscripten checks
  for `ENVIRONMENT_IS_PTHREAD`); pass the module URL + name via env
  (`JSG_WORKER_MODULE`/`JSG_WORKER_NAME`) instead. Set `globalThis.name` to the
  em-pthread name too.

**The split that matters:** the MAIN realm thread is the sandbox (browser, no
process/fs — that's where game code runs). The WORKER thread is a real Node worker
running trusted bundled wasm; it can't reach or weaken the main realm. So the
worker_threads plumbing lives entirely in the runtime, invisible to game code.

**Two non-obvious gotchas that cost time:**
- The realm's parentPort can deliver emscripten's `load` message BEFORE the
  module installs `onmessage`. (Only relevant if you DO shim the worker — the
  final design doesn't, but if you bridge messages, BUFFER early ones and flush on
  `onmessage` set, like a real browser Worker.)
- `workerData` being an OBJECT (to pass moduleUrl) breaks emscripten's
  `workerData == 'em-pthread'` check → it doesn't detect pthread → never installs
  its handler → main thread waits forever. Pass the string; route data via env.

**Game-side build pattern (per box2d3 game, a `build:jsgame` separate from the
browser build):** ship the DELUXE `Box2D.deluxe.{mjs,wasm}` as RAW assets in
`public/` (→ dist root); the `.mjs` MUST stay a real on-disk file (its pthread
worker URL resolves against it), so mark it `external` and `await import()` it
from the game root. Use vite `lib` mode so the dynamic import stays root-relative
(`./Box2D.deluxe.mjs`, NOT `./src/…`). Fetch the wasm root-relative and pass
`wasmBinary` (the realm doesn't auto-locate wasm). Do NOT go through the package
ENTRY (`import 'box2d3-wasm'`) — its runtime SIMD-detect dynamic-import is what
hangs; import the deluxe factory directly.

**Verify it's actually threaded:** look for the game's own
`"Created threaded world"` / `taskSystem= true`, not just "entry evaluated".
A single-threaded fallback (`b2CreateWorld`) also evaluates and runs.

**box2d3-wasm version pin:** v5 REMOVED the `e_segment` DebugDrawCommandType enum
(values shifted; index 5 gone) → a debug-draw doing `e_segment.value` crashes on
undefined. Games with that debug-draw (simple-box2d3, angry-tirds) pin
`~3.8.0`; box2d-physics (no debug-draw enum dep) is on v5.

**Don't try-catch the threaded path as a fallback.** emscripten compat (non-pthread)
build EXPORTS `TaskSystem` but calling it `abort()`s the wasm INSTANCE (dead after
that) — catching is useless. Detect capability first, or just use deluxe.

**Security: the game realm is a BROWSER sandbox — no process/fs/require, period.**
The insight: these are browser games; a browser gives them ZERO OS access and they
run fine, so the realm gives them exactly that. Game code sees NO `process`, NO
`require`, NO `fs`, NO `global`, NO `__dirname` — by any path (CJS `require` and
ESM `import('fs')` both fail). It sees only browser globals (window/document/
canvas/fetch/WebAssembly/Worker/SharedArrayBuffer/Atomics). A hostile game's
`require('fs').rmSync(...)` fails at `require` itself.
- Threading still works because emscripten takes its BROWSER path (no process →
  `ENVIRONMENT_IS_NODE` false) and uses `new Worker(url,{type:'module'})` +
  SharedArrayBuffer — served by `GameWorker`. The worker_threads plumbing lives
  entirely in `GameWorker`/`worker-module-bootstrap.mjs`, NEVER exposed to game
  code. The worker runs in a separate Node worker (trusted bundled wasm); it can't
  reach the main realm's sandbox.
- This is a genuine browser-equivalent boundary, not "soft" hardening — the
  earlier neutered-fs/real-process approach (which DID leak process + a chokepoint
  require) is GONE. Even an adversarial game cannot reach fs/process/shell.
- Verify with an adversarial game: `typeof process`/`require`/`global`/`__dirname`
  must all be `'undefined'`; `require('fs')` must throw; `import('fs')` must
  reject; `Worker` and `SharedArrayBuffer` must be functions (threads still work).
- jsgamelauncher (the sibling SDL/Node launcher) HISTORICALLY ran games in the
  main Node scope (full Node — real fs/process, auto-npm-install). As of its
  `vm-realm-sandbox` branch it adopts THIS SAME model (a `node:vm` realm), so the
  sandbox is now portable across both runtimes. See jsgamelauncher's
  `docs/SECURITY.md` + `docs/PLAN-jsgame-libretro-lessons.md`. (On `main` it's
  still full-Node until that branch merges.)

**Zip extraction is pruned.** `content.js` extracts each `.jsgame` to
`os.tmpdir()/jsgame-content-<sha1>` (content-addressed, reused). It prunes to the
~6 most-recently-used before each new extraction so a quota'd `/tmp` tmpfs doesn't
grow unbounded across different games.

## 13. The core links NO GL library — load ALL GL from RetroArch's get_proc_address

**The rule a libretro core lives by: RetroArch is the host. It supplies the GL
context, input, audio sink, window, save files, and the frame clock. The core
statically bakes in ONLY what RetroArch does NOT provide — for us: libnode (V8/JS
runtime), the webaudio C DSP engine, and the Rust canvas + Ganesh/Skia. Anything
else, including GL, comes FROM the frontend.** A core that links its own GL stack
is re-implementing the host and will fight the frontend on real hardware.

**The mistake we made (and fixed in v0.5.x):** the WebGL2 binding called ~240 GL
functions DIRECTLY against `#include <GLES3/gl3.h>`, so the `.so` carried hundreds
of undefined `gl*` symbols that the linker resolved against a GL library:
- Linux/Android: the system/NDK `libGLESv2` satisfied them (incidentally OK, but
  still wrong in principle).
- macOS/Windows: there is NO system GLES, so the build pulled in **ANGLE** and
  shipped `libEGL`/`libGLESv2` as **sidecar dylibs** next to the core.

Sidecars break the **one-file-per-core** model the RetroArch Core Downloader
requires (every core on the buildbot is a single `*_libretro.<ext>`). And it was
redundant: `context_reset` already receives `hw_render.get_proc_address` — the
frontend's GL loader — exactly how Flycast renders Dreamcast 3D on a Mac without
linking any GL lib. We captured that pointer and then ignored it.

**The fix (`src/gl/gl_procs.{h,c}`):** declare a `p_glXxx` function pointer for
every GL function the binding uses, and `#define glXxx p_glXxx` (after
`<GLES3/gl3.h>`, so header declarations aren't rewritten). `jsg_gl_set_procs`
loads them all from `hw_render.get_proc_address`. Existing `glXxx(...)` call sites
resolve to the loaded pointers with ZERO edits. Result: the core links **no GL
library on any platform** — single self-contained file everywhere, no ANGLE.

**Verify after any GL change** (the regression guard):
```
nm -D build/jsgame_libretro.so | grep -E ' U (gl[A-Z]|egl)'   # must be EMPTY
ldd build/jsgame_libretro.so | grep -iE 'GLES|EGL'            # must be EMPTY
```
Both empty = correct. Any undefined `gl*` = a call site not going through the
redirect (e.g. a file that includes `<GLES3/gl3.h>` but not `gl_procs.h`).

**Gotchas:**
- Generate the function list from what the LINKER reports undefined (`nm -D ... U
  gl*`), not a source grep — a `glGetIntegeri_v`-style name with an underscore
  trips a naive `gl[A-Z][a-zA-Z0-9]*` regex (it stops at `_`). Use
  `gl[A-Z][a-zA-Z0-9_]*`.
- Vendor the GLES3 headers (`src/vendor/gl`, Khronos/MIT) so macOS/Windows compile
  without ANGLE's headers and every platform builds identically (no system
  mesa-dev needed).
- **Android still links `GLESv3 EGL`** — but that is for **Skia/libcanvas's** GL
  backend, NOT our binding. Those are Android SYSTEM libraries (always present,
  resolved at load like libc) so the core stays single-file. macOS Skia uses the
  system `OpenGL.framework` (also system, single-file-safe). The distinction:
  *system* GL libs that the platform always ships are fine to link (they're not
  bundled); a *bundled* GL lib (ANGLE sidecar) is not.
- Removing ANGLE surfaced a latent `build.sh` bug: `"${CMAKE_EXTRA[@]}"` on an
  empty array errors under macOS bash 3.2 `set -u`. If you reintroduce an
  optional-args array, guard it or expand it safely.

**The sibling wasmcart-libretro made the exact same mistake** (linked GL directly
→ ANGLE sidecars; even spun up its own EGL context in the core). It caused real
Android debugging grief — the core fought the frontend's GLES context instead of
using it. Same fix applied there. See `wasmcart-libretro/doc/dev_notes.md`.

## 14. ES-DE / RetroDeck: the "JS Games" category (it's `<theme>`, NOT `<fullname>`)

This is a frontend-integration note, not a core concern — the core knows nothing
about ES-DE (it just gets launched). But getting `.jsgame` files to show as a proper
**"JS Games"** category in ES-DE/RetroDeck cost real time on wrong assumptions.

**The rule:** ES-DE picks a system's **displayed name AND logo from the `<theme>`
tag** (`${system.theme}`), **not** from `<fullname>`. So pointing `<theme>` at an
existing system **borrows that system's identity**:
- `<theme>pc</theme>` → renders as **"IBM PC"** with the IBM logo.
- `<theme>ports</theme>` → renders as **"Ports"**.

`<fullname>JS Games</fullname>` is ignored for the carousel label in both cases.

**The fix:** use a `<theme>` value **no stock theme defines** (`jsgames`). ES-DE then
falls back to showing `<fullname>` as text + whatever logo you drop in for that name.
From the ES-DE source (`es-core/.../CarouselComponent`, RetroDECK/ES-DE
retrodeck-main): a carousel item is the `staticImage` (`${artworkSource}/${system.theme}.png`)
if the file exists, else the `defaultImage` (`_default.png`), else the full-name
text; the `system-logo` element separately overlays `${logoSource}/${system.theme}.svg`.

**Logo gotcha — ES-DE renders theme SVGs with nanosvg, which does NOT render
`<text>`:** a wordmark built with `<text>` is **invisible** (only ~4 of art-book-next's
212 stock logos use `<text>`, and those rely on being pre-outlined). Our
`logos/jsgames.svg` is pixel-block letters drawn as `<rect>`s (paths only), white-fill
so the theme recolors via `${systemLogoColor}`. Regenerate with `frontend/es-de/gen-logo.py`.

**Where it all lives / install:**
- Repo assets: `frontend/es-de/` — `es_systems.xml` (portable: `%ROMPATH%` /
  `%EMULATOR_RETROARCH%` / `%CORE_RETROARCH%`, no hardcoded paths), `logos/jsgames.svg`,
  `gen-logo.py`, `README.md`.
- Install the system into `custom_systems/es_systems.xml` — the **supported user-add
  path that ES-DE does NOT overwrite on update** (everything else under ES-DE config
  is read-only; ROM folders are editable).
- Drop `logos/jsgames.svg` into the active theme's `_inc/systems/logos/` (theme files
  DO get clobbered on a theme update — re-copy after). For art-book-next, also place a
  `jsgames.png` in each `artwork*/` variant dir (artworkSource resolves to one per the
  user's chosen style).
- On RetroDeck, if the core isn't where `%CORE_RETROARCH%` points (read-only `/app`),
  use an absolute `-L /path/to/jsgame_libretro.so` in `<command>` instead.

**A full ES-DE/RetroDeck RESTART is required** — the systems config is read once at
startup; "reload gamelist" does not pick up a new custom system.

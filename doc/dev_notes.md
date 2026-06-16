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

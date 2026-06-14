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
| B. GL + 2D composite | a 2D canvas, but `gl_active` | **gl_blit**: upload the 2D framebuffer as a GL texture, draw fullscreen into RA's FBO, then `video_cb(VALID)` |
| C. pure software | a 2D canvas, no GL | `video_cb(software_pixels)` directly |

**THE TRAP (case B):** once `gl_active`, RetroArch is in HW-render mode and
**ignores software `video_cb` frames entirely**. So a WebGL game that composites
its scene onto a 2D display canvas (3D + a 2D HUD) gets a BLACK screen — every
2D draw is silently dropped. Diagnosing this wasted a lot of time; the tell is
`getImageData` shows your pixels in the canvas, but they never reach the screen.

**Fix = `src/gl_blit.c`** (the PLAN's "wc_gl_blit" doctrine): software FB → GL
texture → fullscreen quad into RA's FBO. Picks GLSL `300 es` vs `330 core` to
match the negotiated context. This makes standard web `ctx2d.drawImage(glCanvas)`
+ 2D HUD work.

---

## 5. Web compat: `ctx2d.drawImage(webglCanvas)` is supported — keep it that way

A browser lets you `ctx2d.drawImage(aWebGLCanvas, 0, 0)` to composite a WebGL
canvas onto a 2D one (standard HUD-over-3D pattern). napi-canvas can't read GL
pixels, so the engine special-cases it: `runtime/realm.js`'s `drawImage` override
detects `image._isWebGL` and calls the GL context's `_snapshotInto(targetCtx,
rawGetImageData, rawPutImageData)` (`runtime/vendor/webgl/webgl2-context.mjs`),
which `glReadPixels` the live default FBO, flips bottom-up→top-down, and
`putImageData`s straight into the SAME 2D context so subsequent `fillText`/HUD
draws land on top. **Never route a game around this with `WebGLRenderTarget` +
manual readback — that's a shortcut; the point is web compatibility.**

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

## 9. Performance: the gl_blit readback cost

Case B (GL+2D composite) does a GPU→CPU→GPU round-trip (`readPixels` +
texture re-upload). At 640×480 it's ~1.3ms/frame (`cb` ~1.75ms vs ~0.4ms for a
GL-native game) — negligible, steady 60fps with ~14ms headroom. **It scales with
resolution** (~8MB/frame at 1080p) — if a high-res HUD game stutters, the fix is
to draw the HUD as a GL overlay (camera-pinned textured quad inside the scene)
instead of the readback path. The 3D itself is always full GPU hardware render.

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

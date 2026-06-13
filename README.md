# jsgame-libretro

A libretro core that runs JavaScript web games **without a browser**. RetroArch
(or any libretro frontend) is the launcher, window manager, input mapper, and
display pipeline. The core embeds Node.js (V8 via
[libnode](https://github.com/wasmcart/build-libnode)) and provides browser APIs
implemented directly on top of the libretro API.

Sibling project to [jsgamelauncher](https://github.com/monteslu/jsgamelauncher)
— same games, same packaging, but the frontend does the launching.

## Status

Early but real: unmodified 2D demos from
[jsgames](https://github.com/monteslu/jsgames) run in the core today — Canvas
2D (Skia via [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas),
statically linked), ES modules, Gamepad API over RetroPad, real WebAudio
(webaudio-node's DSP engine compiled in), localStorage backed by libretro save
RAM, and a deterministic 60fps frame clock — verified in RetroArch with audio.
Released for 5 platforms (Linux x86_64/arm64, Windows, macOS arm64, Android
arm64). Feature parity with jsgamelauncher is complete except Peer Connection.
See `PLAN.md` for the full design.

## Content

| Mode | What the frontend loads |
|---|---|
| Directory (dev) | the `.jsg` marker file inside the game directory |
| Zip (distribution) | a `.jsgame` archive of the same tree |

A game is a normal web game tree: entry resolved from `package.json` `main`,
then `main.js`, `src/main.js`, `index.js`, `src/index.js`, `game.js`,
`src/game.js`. Bundle your game — bare specifiers are not resolved. Static
assets in `public/` are addressed from the root, vite-style.

## Browser APIs

Tracks the same surface as [jsgamelauncher](https://github.com/monteslu/jsgamelauncher);
a game that runs there is the target for running here unchanged.

| API | Status | Notes |
|-----|--------|-------|
| Canvas 2D | ✅ | Skia (`@napi-rs/canvas`); also `OffscreenCanvas`, `Path2D`, `ImageData` |
| WebAudio | ✅ | webaudio-node DSP engine compiled native; frame-locked pull sink |
| Gamepad API | ✅ | every controller is `mapping: "standard"` via RetroPad |
| FontFace | ✅ | Skia font registration (works from zip-loaded buffers) |
| LocalStorage | ✅ | backed by libretro SRAM (frontends persist as `.srm`) |
| WebAssembly | ✅ | runs in V8, in the game realm and workers |
| `fetch` / `Image` | ✅ | game-root scoped (dir or zip); HTTP off by default |
| WebGL2 / Canvas 3D | ✅ | full `WebGL2RenderingContext` (Skia-free GLES3 path); auto-enabled by `{"webgl":true}` in the `.jsg`; desktop via ANGLE |
| Web Workers | ✅ | `worker_threads`-backed; curated worker realm; `SharedArrayBuffer`/`Atomics` |
| Keyboard events | ✅ | `keydown`/`keyup` with `key`/`code` (frontend keyboard → realm) |
| WebSockets | ✅ | privileged-realm socket + game façade; gated by `network` in the `.jsg` (`off`/`websocket`/`full`) |
| Peer Connection | ❌ | not supported (matches jsgamelauncher) |
| Save states / rewind | ⛔ | a V8 heap is not serializable; games persist via LocalStorage/SRAM |

Beyond jsgamelauncher's surface, the synthetic 60fps `requestAnimationFrame`
clock means fast-forward speeds the game up and pause freezes it, like any
libretro core.

## Build

```bash
./scripts/fetch-deps.sh          # prebuilt libnode + libcanvas from GitHub releases
./scripts/build.sh               # → build/jsgame_libretro.so
```

Headless verification (no frontend needed):

```bash
cc -o test/harness test/harness.c -ldl
JSGAME_RUNTIME_DIR=$PWD/runtime ./test/harness \
  build/jsgame_libretro.so test-games/s2-demo/s2-demo.jsg 60
```

The JS runtime is embedded in the core, so the built `.so` runs standalone.
`JSGAME_RUNTIME_DIR` is an optional dev override: point it at `runtime/` to load
the JS from disk (edit JS, relaunch, no C rebuild). Set
`JSGAME_DUMP_PNG=/path.png JSGAME_DUMP_FRAME=25` to capture a frame.

## Install (RetroArch)

Copy `jsgame_libretro.so` and `jsgame_libretro.info` into your frontend's cores
directory, put games in a `jsgames` roms folder, point the frontend at them. The
core is self-contained — no env vars needed.
Release builds: [Releases](https://github.com/monteslu/jsgame-libretro/releases).

## License

MIT

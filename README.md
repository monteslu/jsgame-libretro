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

A game is a normal web game **folder**. The core accepts three forms:

| Input | When |
|---|---|
| the **directory** | dev / direct runs (the folder IS the game) |
| a **`.jsg` marker** file in the folder | ES-DE / EmulationStation — libretro frontends scan by file extension, so a tiny marker gives them one file per entry |
| a **`.jsgame`** zip of the folder | distribution |

Both the `.jsg` marker and `package.json` are **optional**. The `.jsg` is just a
pointer for ES-DE-style launchers — an empty file is fine (same idea as ScummVM's
`.scummvm` hook). A bare folder with a `main.js` runs with neither. Everything is
derived from the folder:

- **Entry**: `package.json` `main`, then `main.js`, `src/main.js`, `index.js`,
  `src/index.js`, `game.js`, `src/game.js`. Bundle your game for the core —
  unlike the browser/jsgamelauncher, the core ships no `node_modules`, so bare
  specifiers aren't resolved on-device (dev with vite in the browser, then
  `npm run build`, then run the built `dist/`). Static assets in `public/` are
  addressed from the root, vite-style.
- **Security**: games run in a `node:vm` **browser sandbox** — no `process`,
  `require`, or `fs` reachable by game code (a game can't read your files or run
  shell commands). Threaded wasm still works.
- **GPU**: WebGL use is auto-detected by scanning the game's source for a
  `getContext('webgl'|'webgl2')` call (the core must request the GPU context
  before any game code runs, so it can't wait for the call). `JSGAME_GL=1`
  forces it on if a game obtains the context through an indirection the scan
  can't see.
- **Optional config** (`width`, `height`, `network`): a `"jsgame"` block in
  `package.json` (or JSON in the `.jsg` marker, which wins). All optional —
  sensible defaults otherwise.

## Browser APIs

Tracks the same surface as [jsgamelauncher](https://github.com/monteslu/jsgamelauncher);
a game that runs there is the target for running here unchanged.

| API | Status | Notes |
|-----|--------|-------|
| Canvas 2D | ✅ | Skia (`@napi-rs/canvas`); also `OffscreenCanvas`, `Path2D`, `ImageData` |
| WebAudio | ✅ | webaudio-node DSP engine compiled native; frame-locked pull sink |
| Gamepad API | ✅ | reads the RetroPad abstraction, so every controller in RetroArch's autoconfig DB just works; exposed as `mapping: "standard"` |
| FontFace | ✅ | Skia font registration (works from zip-loaded buffers) |
| LocalStorage | ✅ | backed by libretro SRAM (frontends persist as `.srm`) |
| WebAssembly | ✅ | runs in V8, in the game realm and workers |
| `fetch` / `Image` | ✅ | game-root scoped (dir or zip); HTTP off by default |
| WebGL2 / Canvas 3D | ✅ | full `WebGL2RenderingContext` (Skia-free GLES3 path); GPU use is auto-detected from the game's `getContext('webgl')` calls (no config field); desktop via ANGLE |
| Web Workers | ✅ | `worker_threads`-backed; curated worker realm; `SharedArrayBuffer`/`Atomics` |
| Keyboard events | ✅ | `keydown`/`keyup` with `key`/`code` (frontend keyboard → realm) |
| WebSockets | ✅ | privileged-realm socket + game façade; gated by `network` in the `.jsg` (`off`/`websocket`/`full`) |
| Peer Connection | ❌ | not supported (matches jsgamelauncher) |
| Save states / rewind | ⛔ | a V8 heap is not serializable; games persist via LocalStorage/SRAM |

### What the frontend gives you for free

Because RetroArch (not the core) owns input, the core reads only the **RetroPad**
abstraction (`input_state_cb(RETRO_DEVICE_JOYPAD/ANALOG)`) — it never touches a
physical device. So your game inherits RetroArch's entire input layer at no cost:

- **The full controller autoconfig database.** Every pad RetroArch supports —
  hundreds, frontend-maintained across Knulli / Batocera / ROCKNIX — maps to the
  standard RetroPad and reaches your game with zero work in the core or the game.
  (Contrast jsgamelauncher, which reads SDL directly and owns its own controller
  database + fallbacks.)
- **User remapping in the RetroArch UI**, persisted per-core / per-game, plus
  port assignment and hotkeys — none of which the game has to implement.
- On Batocera/Knulli, that autoconfig is itself generated from the system
  controller setup, so the device's mapping flows through to the game. (Note: it's
  RetroArch's input layer you inherit at runtime — EmulationStation hands off to
  RetroArch and steps aside; it does not pipe its config into the running core.)

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
cc -D_DEFAULT_SOURCE -o test/harness test/harness.c -ldl
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

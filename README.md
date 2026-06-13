# jsgame-libretro

A libretro core that runs JavaScript web games **without a browser**. RetroArch
(or any libretro frontend) is the launcher, window manager, input mapper, and
display pipeline. The core embeds Node.js (V8 via
[libnode](https://github.com/wasmcart/build-libnode)) and provides browser APIs
implemented directly on top of the libretro API.

Sibling project to [jsgamelauncher](https://github.com/monteslu/jsgamelauncher)
— same games, same packaging, but the frontend does the launching.

## Status

Early but real: an unmodified 2D demo from
[jsgames](https://github.com/monteslu/jsgames) runs in the core today — Canvas
2D (Skia via [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas),
statically linked), ES modules, Gamepad API over RetroPad, localStorage backed
by libretro save RAM, deterministic 60fps frame clock. WebGL2 and real WebAudio
are in progress (silent stub today). See `PLAN.md` for the full design.

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

- Canvas 2D (Skia), `OffscreenCanvas`, `Path2D`, `ImageData`
- `Image` / `loadImage` / `fetch` (game-root scoped; network off by default)
- Gamepad API — every controller is `mapping: "standard"` via RetroPad
- `localStorage` → libretro SRAM (frontends persist it as `.srm`)
- `FontFace` → Skia font registration
- `requestAnimationFrame` + synthetic 60fps clock (fast-forward speeds the game up)
- `WebAssembly` (V8), Web Workers (worker_threads under the hood)
- WebAudio — silent stub today, real engine in progress
- No save states (a V8 heap is not serializable) — saves use localStorage/SRAM

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

`JSGAME_RUNTIME_DIR` points at `runtime/` for development (edit JS, relaunch, no
C rebuild). Set `JSGAME_DUMP_PNG=/path.png JSGAME_DUMP_FRAME=25` to capture a
frame.

## Install (RetroArch)

Copy `jsgame_libretro.so` and `jsgame_libretro.info` into your frontend's cores
directory, put games in a `jsgames` roms folder, point the frontend at them.
Release builds: [Releases](https://github.com/monteslu/jsgame-libretro/releases).

## License

MIT

# Batocera integration

Adds a **"JS Games"** system (`jsgames`) to Batocera without rebuilding the image.
Tested: Batocera 43.1 on Raspberry Pi 5 (RetroArch 1.22.2, Mesa V3D, Wayland/labwc)
with the linux-aarch64 release: WebGL2 (raw GL and Three.js PBR scene), Canvas 2D,
Box2D wasm, audio, all at 60 fps.

## Why it needs a service

Batocera's launcher (`configgen`) only looks for cores in `/usr/lib/libretro` and
their `.info` in `/usr/share/libretro/info`, and the Carbon theme only reads logos
from its own `art/logos/`. `/usr` is a RAM overlay wiped on reboot, so the real
files live in `/userdata/system/jsgame/` and a user service
(`/userdata/system/services/jsgame`, run every boot) drops symlinks into the overlay.
`custom.sh` is deprecated in Batocera 43; services replace it.

## Install

```sh
# on the box (ssh root@<ip>, password linux), with these files in one dir:
#   jsgame_libretro.so  jsgame_libretro.info  jsgames.svg (from ../es-de/logos)
#   es_systems_jsgames.cfg  jsgame.service.sh  install.sh
sh install.sh
```

Then put `.jsgame` (or `.jsg`) zips in `/userdata/roms/jsgames/` and restart
EmulationStation (es_systems is only read at startup).

| What | Where |
| --- | --- |
| core + `.info` | `/userdata/system/jsgame/` |
| logo (SVG, paths only: nanosvg ignores `<text>`) | `/userdata/system/jsgame/theme/jsgames.svg` |
| system definition | `/userdata/system/configs/emulationstation/es_systems_jsgames.cfg` |
| emulator/core mapping (unknown systems otherwise fail with `MissingEmulator`) | `jsgames.emulator=libretro`, `jsgames.core=jsgame` in `/userdata/system/batocera.conf` |
| boot-time symlinks | `/userdata/system/services/jsgame`, enabled with `batocera-services enable jsgame` |

## Verifying without a controller

ES has an HTTP API on port 1234:

```sh
curl -s http://127.0.0.1:1234/systems | grep -c '"name": "jsgames"'                    # 1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1234/systems/jsgames/logo   # 200
curl -X POST http://127.0.0.1:1234/launch -d /userdata/roms/jsgames/game.jsgame
batocera-es-swissknife --emukill
```

Core log lines (`console.log` included) land in `/userdata/system/logs/es_launch_stderr.log`.
Don't stop the `S31emulationstation` init script to test: it also stops the
Wayland compositor and `emulatorlauncher` then fails in `getCurrentResolution`.
Restarting ES via that init script also crashes labwc about every other time on
this box; use `batocera-es-swissknife --restart` or the ES menu.

## Packaging note

A `.jsgame` is a zip whose root has the entry script named by `package.json`
`main` (or `main.js` / `src/main.js`). A plain `vite build` output with only an
`index.html` and a hashed `assets/*.js` is not enough: add a `package.json` with
`"main": "assets/<file>.js"`, or use `test-games/vite-plugin-jsgame.js`.

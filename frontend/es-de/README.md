# ES-DE / EmulationStation integration

Adds a **"JS Games"** system to ES-DE (and RetroDeck) so `.jsgame` files show up
as their own category, launched through the jsgame-libretro core.

## Install

1. **Add the system** — copy `es_systems.xml` into ES-DE's `custom_systems/` dir
   (this is the supported user-add path; ES-DE does **not** overwrite it on update):
   - Native ES-DE: `~/ES-DE/custom_systems/es_systems.xml`
   - RetroDeck: `~/retrodeck/ES-DE/custom_systems/es_systems.xml`

   If the core is not installed where `%CORE_RETROARCH%` points (e.g. RetroDeck's
   read-only `/app` cores dir), change `<command>` to an absolute `-L` path to the
   `.so`, e.g. on RetroDeck:
   ```
   <command>%EMULATOR_RETROARCH% -L /home/<user>/retrodeck/storage/jsgame-cores/jsgame_libretro.so %ROM%</command>
   ```

2. **Add the logo** (optional but recommended) — drop `logos/jsgames.svg` into the
   active theme's per-system logo dir. For art-book-next (RetroDeck default):
   ```
   ~/retrodeck/ES-DE/themes/art-book-next-es-de/_inc/systems/logos/jsgames.svg
   ```
   (Theme files DO get overwritten on a theme update; re-copy after updating a theme.)

3. **Put games** in `%ROMPATH%/jsgames/` as `.jsgame` files.

4. **Restart ES-DE/RetroDeck fully.** The systems config is read once at startup —
   "reload gamelist" is not enough; the new system only appears after a full restart.

## Why `<theme>jsgames</theme>` (not `pc` or `ports`)

ES-DE picks a system's displayed **name and logo from the theme**, keyed by the
`<theme>` value (`${system.theme}`), NOT from `<fullname>`. So pointing `<theme>` at
an existing system borrows *that* system's identity:
- `<theme>pc</theme>` → renders as **"IBM PC"** with the IBM logo.
- `<theme>ports</theme>` → renders as **"Ports"**.

Using a name **no stock theme defines** (`jsgames`) makes ES-DE fall back to showing
our `<fullname>` and our own dropped-in `logos/jsgames.svg`. From the ES-DE source
(`CarouselComponent`): a carousel item is the `staticImage` (`${system.theme}.png`)
if present, else the `defaultImage` (`_default.png`), else the full-name text; the
`system-logo` element separately overlays `${system.theme}.svg`.

## Logo gotcha: ES-DE renders SVGs with **nanosvg**, which ignores `<text>`

`logos/jsgames.svg` must be built from **paths/shapes only** — `<text>` elements are
**not rendered** by ES-DE's SVG loader (only ~4 of art-book-next's 212 stock logos
use `<text>`, and they rely on it being pre-outlined). Our logo is pixel-block
letters drawn as `<rect>`s, white-filled so the theme can recolor it via
`${systemLogoColor}`. Regenerate with `scripts/gen-esde-logo.py` if the wordmark
changes.

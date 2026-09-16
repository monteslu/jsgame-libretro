#!/bin/sh
# Batocera user service: expose the jsgame libretro core (kept in /userdata) to
# configgen/RetroArch, which only look in the read-only /usr tree.
D=/userdata/system/jsgame
THEME=/usr/share/emulationstation/themes/es-theme-carbon
case "$1" in
  start)
    ln -sf "$D/jsgame_libretro.so"   /usr/lib/libretro/jsgame_libretro.so
    ln -sf "$D/jsgame_libretro.info" /usr/share/libretro/info/jsgame_libretro.info
    ln -sf "$D/theme/jsgames.svg"    "$THEME/art/logos/jsgames.svg"
    ln -sf "$D/theme/jsgames.svg"    "$THEME/art/logos/jsgames-w.svg"
    ;;
  stop)
    rm -f /usr/lib/libretro/jsgame_libretro.so /usr/share/libretro/info/jsgame_libretro.info \
          "$THEME/art/logos/jsgames.svg" "$THEME/art/logos/jsgames-w.svg"
    ;;
esac
exit 0

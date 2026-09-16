#!/bin/sh
# Install jsgame as a "JS Games" system on a Batocera box. Run ON the box as root,
# from this directory, with jsgame_libretro.so (linux build for the box's arch),
# jsgame_libretro.info and jsgames.svg next to this script. Everything lands in
# /userdata (survives reboots and upgrades); the read-only /usr tree only gets
# symlinks, put back on every boot by the 'jsgame' user service.
set -e
D=/userdata/system/jsgame
mkdir -p "$D/theme" /userdata/roms/jsgames /userdata/system/services /userdata/system/configs/emulationstation
cp jsgame_libretro.so jsgame_libretro.info "$D/"
cp jsgames.svg "$D/theme/jsgames.svg"
cp es_systems_jsgames.cfg /userdata/system/configs/emulationstation/
cp jsgame.service.sh /userdata/system/services/jsgame
chmod +x /userdata/system/services/jsgame
grep -q '^jsgames.emulator=' /userdata/system/batocera.conf || \
  printf '\n## jsgames (custom system)\njsgames.emulator=libretro\njsgames.core=jsgame\n' >> /userdata/system/batocera.conf
batocera-services enable jsgame
/userdata/system/services/jsgame start
echo "Installed. Drop .jsgame files in /userdata/roms/jsgames, then restart EmulationStation"
echo "(Menu > Quit > Restart, or: batocera-es-swissknife --restart)."

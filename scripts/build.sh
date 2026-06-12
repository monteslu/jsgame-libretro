#!/usr/bin/env bash
# Local build for the current platform. CI calls this same script.
set -euo pipefail
cd "$(dirname "$0")/.."

LIBCANVAS_A="${LIBCANVAS_A:-$PWD/deps/libcanvas/libcanvas.a}"
SKIA_LIB_DIR="${SKIA_LIB_DIR:-$PWD/deps/libcanvas/skia}"

# Spike fallback: sibling napi-canvas checkout (debug build)
if [ ! -f "$LIBCANVAS_A" ] && [ -f "$PWD/../napi-canvas/target/debug/libcanvas.a" ]; then
    LIBCANVAS_A="$PWD/../napi-canvas/target/debug/libcanvas.a"
    SKIA_LIB_DIR="$PWD/../napi-canvas/skia/out/Static"
fi

cmake -B build -DCMAKE_BUILD_TYPE=Release \
    -DLIBCANVAS_A="$LIBCANVAS_A" \
    -DSKIA_LIB_DIR="$SKIA_LIB_DIR" \
    "$@"
cmake --build build -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

ls -lh build/jsgame_libretro.*

#!/usr/bin/env bash
# Local build for the current platform. CI calls this same script.
set -euo pipefail
cd "$(dirname "$0")/.."

LIBCANVAS_A="${LIBCANVAS_A:-$PWD/deps/libcanvas/libcanvas.a}"
[ -f "$PWD/deps/libcanvas/libcanvas.lib" ] && LIBCANVAS_A="$PWD/deps/libcanvas/libcanvas.lib"
SKIA_LIB_DIR="${SKIA_LIB_DIR:-$PWD/deps/libcanvas/skia}"

# Spike fallback: sibling napi-canvas checkout (debug build)
if [ ! -f "$LIBCANVAS_A" ] && [ -f "$PWD/../napi-canvas/target/debug/libcanvas.a" ]; then
    LIBCANVAS_A="$PWD/../napi-canvas/target/debug/libcanvas.a"
    SKIA_LIB_DIR="$PWD/../napi-canvas/skia/out/Static"
fi

# libcanvas.a carries duplicate object members (napi-rs bundles its link deps;
# Linux GNU ld tolerates via --allow-multiple-definition; Apple ld does not.
# Rather than force_load the whole archive (pulls BOTH copies of each dup
# object -> "duplicate symbol") or de-dup by name (drops distinct same-named
# objects, e.g. libavif), extract ONLY the object defining the napi register
# entry, force_load just that, and let the normal archive link pull every
# other symbol once. CMake reads JSG_NAPI_OBJ for the macOS path.
if [ "$(uname)" = "Darwin" ] && [ -f "$LIBCANVAS_A" ]; then
    TMP="$PWD/build/napi-extract"
    rm -rf "$TMP"; mkdir -p "$TMP"
    ( cd "$TMP" && ar x "$LIBCANVAS_A" )
    NAPI_OBJ=""
    for o in "$TMP"/*.o; do
        if nm "$o" 2>/dev/null | grep -q 'T _\?napi_register_module_v1'; then NAPI_OBJ="$o"; break; fi
    done
    [ -n "$NAPI_OBJ" ] || { echo "FATAL: napi register object not found"; exit 1; }
    export JSG_NAPI_OBJ="$NAPI_OBJ"
fi

CMAKE_EXTRA=()
[ -n "${ANGLE_DIR:-}" ] && CMAKE_EXTRA+=("-DANGLE_DIR=$ANGLE_DIR")

cmake -B build -DCMAKE_BUILD_TYPE=Release \
    -DLIBCANVAS_A="$LIBCANVAS_A" \
    -DSKIA_LIB_DIR="$SKIA_LIB_DIR" \
    "${CMAKE_EXTRA[@]}" \
    "$@"
cmake --build build --config Release -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

ls -lh build/jsgame_libretro.*

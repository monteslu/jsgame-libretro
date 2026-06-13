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
# Linux GNU ld tolerates via --allow-multiple-definition, Apple ld does not —
# "duplicate symbol"). On macOS, repack a de-duplicated archive.
if [ "$(uname)" = "Darwin" ] && [ -f "$LIBCANVAS_A" ]; then
    DEDUP="$PWD/build/libcanvas-dedup.a"
    mkdir -p "$PWD/build"
    TMP="$(mktemp -d)"
    ( cd "$TMP" && ar x "$LIBCANVAS_A" )
    rm -f "$DEDUP"
    # ar with deterministic names; duplicate basenames extracted by ar get
    # numeric suffixes — collapse to first of each logical object.
    ( cd "$TMP" && ar qcs "$DEDUP" $(ls -1 | sort -u) )
    LIBCANVAS_A="$DEDUP"
    rm -rf "$TMP"
fi

cmake -B build -DCMAKE_BUILD_TYPE=Release \
    -DLIBCANVAS_A="$LIBCANVAS_A" \
    -DSKIA_LIB_DIR="$SKIA_LIB_DIR" \
    "$@"
cmake --build build -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

ls -lh build/jsgame_libretro.*

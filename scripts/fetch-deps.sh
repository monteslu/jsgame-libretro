#!/usr/bin/env bash
# Fetch prebuilt dependencies from GitHub releases (pins in versions.json).
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORM="${1:-linux-x86_64}"
LIBNODE_RELEASE=$(node -p "require('./scripts/versions.json').libnode.release")

if [ ! -f deps/libnode/libnode.a ] && [ ! -f deps/libnode/libnode.lib ]; then
    echo "fetching libnode $LIBNODE_RELEASE ($PLATFORM)..."
    mkdir -p deps/libnode
    EXT="tar.gz"; case "$PLATFORM" in windows-*) EXT="zip";; esac
    URL="https://github.com/wasmcart/build-libnode/releases/download/${LIBNODE_RELEASE}/libnode-${PLATFORM}.${EXT}"
    if [ "$EXT" = "zip" ]; then
        curl -sL "$URL" -o deps/libnode.zip && unzip -q deps/libnode.zip -d deps/libnode && rm deps/libnode.zip
    else
        curl -sL "$URL" | tar xz -C deps/libnode
    fi
fi
echo "libnode: $(cat deps/libnode/NODE_VERSION 2>/dev/null || echo '?')"

LIBCANVAS_RELEASE=$(node -p "require('./scripts/versions.json').libcanvas.release")
if [ "$LIBCANVAS_RELEASE" != "null" ] && [ ! -f deps/libcanvas/libcanvas.a ]; then
    echo "fetching libcanvas $LIBCANVAS_RELEASE ($PLATFORM)..."
    mkdir -p deps/libcanvas
    curl -sL "https://github.com/monteslu/build-libcanvas/releases/download/${LIBCANVAS_RELEASE}/libcanvas-${PLATFORM}.tar.gz" \
        | tar xz -C deps/libcanvas
    cat deps/libcanvas/CANVAS_VERSION
fi
# If no release is pinned yet, scripts/build.sh falls back to ../napi-canvas.

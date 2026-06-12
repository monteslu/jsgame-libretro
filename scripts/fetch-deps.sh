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

# libcanvas: prebuilt releases pending build-libcanvas repo (PLAN §15).
# Until then, scripts/build.sh falls back to a sibling ../napi-canvas build.

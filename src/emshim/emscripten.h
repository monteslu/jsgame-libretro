#include <cstdint>
#include <string>
#include <cstring>
#include <cmath>
// emscripten.h shim for native builds
#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#endif

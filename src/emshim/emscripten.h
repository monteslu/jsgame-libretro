#include <cstdint>
#include <string>
#include <cstring>
#include <cmath>
// emscripten.h shim for native builds
#ifndef EMSCRIPTEN_KEEPALIVE
#ifdef _MSC_VER
#define EMSCRIPTEN_KEEPALIVE
#include <BaseTsd.h>
typedef SSIZE_T ssize_t;
#else
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#endif
#endif

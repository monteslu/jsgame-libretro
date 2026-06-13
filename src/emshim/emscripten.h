// emscripten.h shim for NATIVE builds of the webaudio-node engine sources.
// The engine #includes <emscripten.h> only for EMSCRIPTEN_KEEPALIVE and a few
// POSIX types the WASM toolchain provided implicitly.
#ifndef JSG_EMSCRIPTEN_SHIM_H
#define JSG_EMSCRIPTEN_SHIM_H

#include <cstdint>
#include <cstring>
#include <cmath>
#include <string>

#ifdef _MSC_VER
#define EMSCRIPTEN_KEEPALIVE
#include <BaseTsd.h>
#include <sys/types.h>
typedef SSIZE_T jsg_ssize_t;
#ifndef _SSIZE_T_DEFINED
#define _SSIZE_T_DEFINED
typedef SSIZE_T ssize_t;
#endif
// MSVC has no off_t in the bare global namespace; uaac.h's stubs need it.
typedef int64_t off_t;
#else
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#include <sys/types.h>  // ssize_t, off_t
#endif

#endif  // JSG_EMSCRIPTEN_SHIM_H

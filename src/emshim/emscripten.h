// emscripten.h shim for NATIVE builds of the webaudio-node engine sources.
// The engine #includes <emscripten.h> only for EMSCRIPTEN_KEEPALIVE.
#ifndef JSG_EMSCRIPTEN_SHIM_H
#define JSG_EMSCRIPTEN_SHIM_H

#ifdef _MSC_VER
#define _USE_MATH_DEFINES  // M_PI for <cmath>
#endif
#include <cstdint>
#include <cstring>
#include <cmath>
#include <string>
#include <sys/types.h>  // ssize_t / off_t where the engine touches them

#ifdef _MSC_VER
#define EMSCRIPTEN_KEEPALIVE
#include <BaseTsd.h>
#ifndef _SSIZE_T_DEFINED
#define _SSIZE_T_DEFINED
typedef SSIZE_T ssize_t;
#endif
#else
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#endif

#endif  // JSG_EMSCRIPTEN_SHIM_H

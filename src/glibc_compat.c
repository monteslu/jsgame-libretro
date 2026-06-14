// glibc_compat.c — pin newer-glibc math symbols to old versions for portability.
//
// glibc 2.43 gave several float math functions "correctly rounded" variants
// with a fresh default symbol version (e.g. atan2f@GLIBC_2.43). Our prebuilt
// libcanvas/skia archive references these as plain undefined symbols, so when
// the core is linked on a 2.43 host they resolve to the 2.43 version, and the
// .so then refuses to load on older runtimes (the KDE 6.10 flatpak runtime
// ships glibc 2.42):
//   version `GLIBC_2.43' not found (required by jsgame_libretro.so)
//
// A source-level .symver only affects OUR objects, not the prebuilt archive.
// So instead we use the linker's --wrap (set in CMakeLists): every reference
// to e.g. atan2f — including skia's — is redirected to __wrap_atan2f below,
// which forwards to the old @GLIBC_2.2.5 implementation (still present in every
// modern libm). Behaviour is identical for our uses; we only forgo 2.43's
// last-ulp rounding guarantee. Linux/glibc only.
#if defined(__linux__) && defined(__GLIBC__)
#include <math.h>

// Bind these names to the old, widely-available symbol versions.
__asm__(".symver __old_atan2f,atan2f@GLIBC_2.2.5");
__asm__(".symver __old_asinf,asinf@GLIBC_2.2.5");
__asm__(".symver __old_acosf,acosf@GLIBC_2.2.5");
__asm__(".symver __old_log10f,log10f@GLIBC_2.2.5");
__asm__(".symver __old_remainder,remainder@GLIBC_2.2.5");

extern float  __old_atan2f(float, float);
extern float  __old_asinf(float);
extern float  __old_acosf(float);
extern float  __old_log10f(float);
extern double __old_remainder(double, double);

float  __wrap_atan2f(float y, float x)      { return __old_atan2f(y, x); }
float  __wrap_asinf(float x)                { return __old_asinf(x); }
float  __wrap_acosf(float x)                { return __old_acosf(x); }
float  __wrap_log10f(float x)               { return __old_log10f(x); }
double __wrap_remainder(double x, double y) { return __old_remainder(x, y); }
#endif

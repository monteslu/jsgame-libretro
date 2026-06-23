cmake_minimum_required(VERSION 3.16)
project(jsgame-libretro C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

if(MSVC)
    add_compile_options("$<$<COMPILE_LANGUAGE:CXX>:/std:c++20>" "$<$<COMPILE_LANGUAGE:CXX>:/Zc:__cplusplus>")
    # Static CRT (/MT): libcanvas.lib is overwhelmingly /MT (4057 Skia/C++
    # objects); only ONE stray Rust object (…-static.o) is /MD. So match the
    # bulk with /MT and tell the linker to ignore the dynamic-CRT default that
    # the one stray object drags in (msvcrt) — see /NODEFAULTLIB below.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()

# ─── Dependencies (prebuilt, fetched by scripts/fetch-deps.sh) ───────────

set(LIBNODE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/libnode" CACHE PATH "libnode.a + headers")
set(LIBCANVAS_A "" CACHE FILEPATH "Path to libcanvas.a (napi-canvas staticlib)")
set(SKIA_LIB_DIR "" CACHE PATH "Directory with Skia static archives")

if(NOT EXISTS "${LIBNODE_DIR}/libnode.a" AND NOT EXISTS "${LIBNODE_DIR}/libnode.lib")
    message(FATAL_ERROR "libnode not found at ${LIBNODE_DIR} — run scripts/fetch-deps.sh")
endif()
if(NOT EXISTS "${LIBCANVAS_A}")
    message(FATAL_ERROR "libcanvas.a not found (set -DLIBCANVAS_A=...)")
endif()
if(NOT EXISTS "${SKIA_LIB_DIR}/libskia.a" AND NOT EXISTS "${SKIA_LIB_DIR}/skia.lib")
    message(FATAL_ERROR "Skia archives not found (set -DSKIA_LIB_DIR=...)")
endif()

# ─── Embedded runtime blob ───────────────────────────────────────────────
# Zip runtime/ at build time and embed it as a C byte array so the released
# .so is self-contained (no JSGAME_RUNTIME_DIR). The core extracts it to a
# temp dir on first load (src/runtime_unzip.c). Edits to runtime/ files
# retrigger via DEPENDS; newly ADDED files retrigger via CONFIGURE_DEPENDS.
find_program(NODE_EXECUTABLE node REQUIRED)
find_program(ZIP_EXECUTABLE zip REQUIRED)

file(GLOB_RECURSE RUNTIME_FILES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/runtime/*")
set(RUNTIME_ZIP "${CMAKE_BINARY_DIR}/runtime.zip")
set(EMBEDDED_RUNTIME_C "${CMAKE_BINARY_DIR}/embedded_runtime.c")

add_custom_command(
    OUTPUT "${RUNTIME_ZIP}"
    COMMAND "${CMAKE_COMMAND}" -E rm -f "${RUNTIME_ZIP}"
    COMMAND "${ZIP_EXECUTABLE}" -r -X -q "${RUNTIME_ZIP}" .
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/runtime"
    DEPENDS ${RUNTIME_FILES}
    COMMENT "Zipping runtime/ -> runtime.zip"
    VERBATIM)

add_custom_command(
    OUTPUT "${EMBEDDED_RUNTIME_C}"
    COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/bin2c.js"
            "${RUNTIME_ZIP}" "${EMBEDDED_RUNTIME_C}" jsg_runtime_zip
    DEPENDS "${RUNTIME_ZIP}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/bin2c.js"
    COMMENT "Generating embedded_runtime.c from runtime.zip"
    VERBATIM)

set_source_files_properties("${EMBEDDED_RUNTIME_C}" PROPERTIES GENERATED TRUE)
# Explicit anchor so multi-config generators (Xcode/VS) order codegen first.
add_custom_target(jsg_runtime_blob DEPENDS "${EMBEDDED_RUNTIME_C}")

# ─── Opus decode (libogg + libopus + opusfile, all BSD, royalty-free) ────────
# Built as static libs via the upstream CMake (handles arch/intrinsics detection
# per platform). We only need DECODE: tests/programs/docs/install all stay off, and
# opusfile is compiled from its 4 memory-decode .c files (no http.c/wincerts.c).
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(INSTALL_DOCS OFF CACHE BOOL "" FORCE)
set(INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(INSTALL_CMAKE_PACKAGE_MODULE OFF CACHE BOOL "" FORCE)
# These static libs link into our SHARED core, so they need PIC.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
add_subdirectory(src/vendor/ogg EXCLUDE_FROM_ALL)
add_subdirectory(src/vendor/opus EXCLUDE_FROM_ALL)
set_target_properties(ogg opus PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(opusfile_dec STATIC
    src/vendor/opusfile/src/opusfile.c
    src/vendor/opusfile/src/stream.c
    src/vendor/opusfile/src/info.c
    src/vendor/opusfile/src/internal.c
)
set_target_properties(opusfile_dec PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(opusfile_dec PRIVATE
    src/vendor/opusfile/include
    src/vendor/opusfile/src
    src/vendor/ogg/include
    src/vendor/opus/include)
# Memory-only decode: no HTTP/URL stack, no float-config quirks (opusfile defaults
# to float output, matching our 48 kHz float pipeline).
target_compile_definitions(opusfile_dec PRIVATE OP_FIXED_POINT=0 OP_ENABLE_HTTP=0)
target_link_libraries(opusfile_dec PRIVATE opus ogg)

# ─── AAC decode (Ittiam libxaac, Apache-2.0, maintained + fuzzed) ────────────
# AAC-LC is patent-free (US patents expired 2017). We build libxaac's decoder as a
# PIC static lib from an EXPLICIT all-C source list (the 124 base decoder + 23 DRC +
# 3 common + 2 generic files) — deliberately NOT via libxaac's own per-arch cmake.
#
# Why not its cmake: it selects hand-written GNU-as .s SIMD files keyed on
# CMAKE_SYSTEM_PROCESSOR=="aarch64"/"x86_64", which breaks two ways here: (1) Apple
# Silicon reports "arm64" not "aarch64" (misses the branch → undefined ARM symbols),
# and (2) AppleClang's assembler rejects the GNU-as syntax ("brackets expression not
# supported"). The portable, always-correct path is libxaac's own generic/ pure-C
# implementation (function_selector_generic + qmf_dec_generic) with NO asm — same
# approach we use for opus. Slightly slower than NEON/SSE, but decode is off the
# game thread (async decodeAudioData) so it doesn't matter.
set(XAAC_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/libxaac")
file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/libxaac_sources.txt" XAAC_SRC_REL)
set(XAAC_SOURCES "")
foreach(s ${XAAC_SRC_REL})
    list(APPEND XAAC_SOURCES "${XAAC_ROOT}/${s}")
endforeach()
add_library(libxaacdec STATIC ${XAAC_SOURCES})
set_target_properties(libxaacdec PROPERTIES POSITION_INDEPENDENT_CODE ON C_STANDARD 99)
target_include_directories(libxaacdec PRIVATE
    "${XAAC_ROOT}/decoder" "${XAAC_ROOT}/decoder/drc_src" "${XAAC_ROOT}/common")
# libxaac's generic function-selector wires up the function-pointer tables with
# signatures that differ slightly between the scalar variants; the calls are
# compatible at runtime but trip -Werror=incompatible-pointer-types (and MSVC's
# equivalent). Relax it for this vendored third-party lib only.
# CRITICAL: ixheaacd_function_selector_generic.c wraps its ENTIRE body (all the C
# function-pointer-table globals: ixheaacd_adjust_scale, _apply_rot,
# _calc_max_spectral_line, _aac_ld_dec_rearrange, ...) in `#if !__ARM_NEON__`. On
# Apple Silicon AppleClang predefines __ARM_NEON__, so on macos-arm64 that file
# compiles to NOTHING → those globals are undefined at link (linux gcc-arm doesn't
# predefine __ARM_NEON__, which is why it linked). We use the generic C path on ALL
# arches (no asm/NEON sources), so force the generic body to compile everywhere by
# undefining __ARM_NEON__ for this lib.
if(MSVC)
    target_compile_options(libxaacdec PRIVATE /w /U__ARM_NEON__)
else()
    # GCC 14+/Clang make incompatible-pointer-types an error by default; downgrade
    # it (and a couple of other strict diagnostics the vendored C trips) to non-fatal
    # for this third-party lib only.
    target_compile_options(libxaacdec PRIVATE
        -U__ARM_NEON__ -U__ARM_NEON
        -Wno-error=incompatible-pointer-types -Wno-incompatible-pointer-types
        -Wno-error=implicit-function-declaration -Wno-implicit-function-declaration -w)
endif()

# ─── Core ────────────────────────────────────────────────────────────────

file(GLOB WEBAUDIO_SRC src/webaudio/*.cpp src/webaudio/nodes/*.cpp src/webaudio/utils/*.cpp)

add_library(jsgame_libretro SHARED
    src/libretro.c
    src/node_host.cpp
    src/binding_gl.cpp
    src/gl/binding_gl_full.cpp
    src/gl/gl_bindings.cpp
    src/gl/gl_procs.c
    src/binding_audio.cpp
    src/runtime_unzip.c
    src/gl_detect.c
    src/glibc_compat.c
    src/gl_blit.c
    src/vendor/miniz.c
    "${EMBEDDED_RUNTIME_C}"
    ${WEBAUDIO_SRC}
)
add_dependencies(jsgame_libretro jsg_runtime_blob)

# miniz: expose ONLY the mz_zip_reader_* surface. MINIZ_NO_ZLIB_APIS drops the
# zlib-compatible names (compress/inflate/crc32/...) that would otherwise add to
# libnode's bundled-zlib dup-symbol pile; NO_ARCHIVE_WRITING_APIS — we read only.
set_source_files_properties(src/vendor/miniz.c PROPERTIES
    COMPILE_DEFINITIONS "MINIZ_NO_ZLIB_APIS;MINIZ_NO_ARCHIVE_WRITING_APIS")
# webaudio engine sources include <emscripten.h> for EMSCRIPTEN_KEEPALIVE only
set_source_files_properties(${WEBAUDIO_SRC} src/binding_audio.cpp PROPERTIES
    INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/src/emshim;${CMAKE_CURRENT_SOURCE_DIR}/deps/simde;${CMAKE_CURRENT_SOURCE_DIR}/src")

# RetroArch expects "jsgame_libretro.so", not "libjsgame_libretro.so"
set_target_properties(jsgame_libretro PROPERTIES PREFIX "")
# Flat output dir (MSVC multi-config otherwise nests under build/Release/);
# the package/harness steps look in build/ directly.
foreach(cfg "" _DEBUG _RELEASE _RELWITHDEBINFO _MINSIZEREL)
    set_target_properties(jsgame_libretro PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY${cfg} "${CMAKE_BINARY_DIR}"
        LIBRARY_OUTPUT_DIRECTORY${cfg} "${CMAKE_BINARY_DIR}")
endforeach()

set(NODE_ADDON_API_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/node-addon-api" CACHE PATH "node-addon-api headers")
target_include_directories(jsgame_libretro PRIVATE
    src
    src/gl
    ${LIBNODE_DIR}/include
    ${NODE_ADDON_API_DIR}
)
# node-addon-api: pin N-API version; it uses C++ exceptions for Napi:: errors
target_compile_definitions(jsgame_libretro PRIVATE
    NAPI_VERSION=8 NODE_ADDON_API_DISABLE_DEPRECATED)

# All Skia archives (official build emits many; link as one group)
file(GLOB SKIA_LIBS "${SKIA_LIB_DIR}/*.a")

if(WIN32)
    file(GLOB SKIA_LIBS_WIN "${SKIA_LIB_DIR}/*.lib")
    target_link_libraries(jsgame_libretro PRIVATE
        ${SKIA_LIBS_WIN}
        ${LIBNODE_DIR}/libnode.lib
        winmm dbghelp ws2_32 crypt32 iphlpapi psapi userenv bcrypt
        # Skia GDI fontmgr (ScriptShape) + XPS (CreateFontPackage) + Rust std
        # (Nt* syscalls): Uniscribe, font-subsetting, and ntdll import libs.
        usp10 fontsub ntdll gdi32 user32 ole32 oleaut32 shell32 advapi32
        # Skia's GrGLMakeWinInterface needs WGL (wglGetProcAddress/CurrentContext).
        opengl32
        # Some libcanvas libaom objects were built /MD and reference the dynamic
        # UCRT import form of two math fns (__imp_log1pf / __imp_fmax). Under the
        # /MT bulk those are absent; ucrt.lib supplies the __imp_* math imports.
        ucrt)
    # libcanvas.lib + libnode.lib both bundle zlib/harfbuzz objects (dup defs);
    # /FORCE:MULTIPLE is MSVC's --allow-multiple-definition (take first, warn).
    # /NODEFAULTLIB:msvcrt: one stray /MD Rust object in libcanvas drags in the
    # dynamic CRT (msvcrt.lib), clashing with the /MT bulk (LNK2038/LNK1319).
    # Ignoring msvcrt forces everything onto the static CRT (libcmt) we link with.
    target_link_options(jsgame_libretro PRIVATE
        "/WHOLEARCHIVE:${LIBCANVAS_A}" "/FORCE:MULTIPLE" "/NODEFAULTLIB:msvcrt")
elseif(APPLE)
    # Apple ld: -force_load is the whole-archive equivalent (napi-rs ctor
    # registration objects must all be pulled in)
    # libcanvas.a has DUPLICATE object members (napi-rs bundles its link deps).
    # force_load on the whole archive -> "duplicate symbol" under Apple ld; de-dup
    # by name drops distinct same-named objects (libavif). So: force_load ONLY the
    # extracted napi-register object (build.sh sets JSG_NAPI_OBJ), then link
    # libcanvas.a normally (archive pulls each needed symbol once, dup members OK).
    set(JSG_NAPI_OBJ "$ENV{JSG_NAPI_OBJ}")
    if(NOT JSG_NAPI_OBJ)
        message(FATAL_ERROR "JSG_NAPI_OBJ not set (run via scripts/build.sh on macOS)")
    endif()
    target_link_libraries(jsgame_libretro PRIVATE
        ${LIBNODE_DIR}/libnode.a pthread dl m c++
        "-Wl,-force_load,${JSG_NAPI_OBJ}"
        ${LIBCANVAS_A}
        "-framework CoreFoundation" "-framework Security"
        "-framework SystemConfiguration" "-framework ApplicationServices")
elseif(ANDROID)
    add_library(cpufeatures STATIC ${ANDROID_NDK}/sources/android/cpufeatures/cpu-features.c)
    target_include_directories(cpufeatures PUBLIC ${ANDROID_NDK}/sources/android/cpufeatures)
    target_link_libraries(jsgame_libretro PRIVATE
        -Wl,--whole-archive ${LIBCANVAS_A} -Wl,--no-whole-archive
        -Wl,--start-group ${SKIA_LIBS} ${LIBNODE_DIR}/libnode.a -Wl,--end-group
        dl m log android cpufeatures
        # Skia's GL backend (libcanvas) references GLESv3/EGL. On Android these are
        # SYSTEM libraries (always present on the device, resolved at load like
        # libc) — NOT bundled sidecars, so the core stays a single self-contained
        # file. Our WebGL binding does NOT need them (it loads GL via the
        # frontend's get_proc_address); this link is purely for Skia.
        GLESv3 EGL)
    target_link_options(jsgame_libretro PRIVATE
        -Wl,--allow-multiple-definition -Wl,--exclude-libs,ALL)
else()
    # Linux: group the canvas/skia/libnode archives to resolve cross-deps.
    # libc++/libc++abi static: skia + skia_c are built against libc++;
    # libnode is libstdc++ — both statically linked, symbols localized.
    # NAMES with explicit .a: plain find_library prefers the shared flavor,
    # whose libc++abi drags a libunwind.so.1 DT_NEEDED that flatpak runtimes
    # (RetroDeck) don't ship. Static keeps unwind symbols out of DT_NEEDED.
    find_library(LIBCXX_STATIC NAMES libc++.a PATHS /usr/lib/x86_64-linux-gnu /usr/lib/llvm-19/lib /usr/lib/llvm-18/lib)
    find_library(LIBCXXABI_STATIC NAMES libc++abi.a PATHS /usr/lib/x86_64-linux-gnu /usr/lib/llvm-19/lib /usr/lib/llvm-18/lib)
    # whole-archive on libcanvas.a: napi-rs registers classes via ctor
    # initializers in objects nothing references — without this, class
    # constructors silently vanish ("Class contains no constructor").
    target_link_libraries(jsgame_libretro PRIVATE
        -Wl,--whole-archive ${LIBCANVAS_A} -Wl,--no-whole-archive
        -Wl,--start-group
        ${SKIA_LIBS}
        ${LIBNODE_DIR}/libnode.a
        -Wl,--end-group
        ${LIBCXX_STATIC} ${LIBCXXABI_STATIC}
        pthread dl m)
    target_link_options(jsgame_libretro PRIVATE
        -Wl,--allow-multiple-definition
        -Wl,--exclude-libs,ALL   # keep dep symbols out of the dynamic table
        # Redirect newer-glibc math symbols (skia pulls atan2f/asinf/acosf/
        # log10f/remainder@GLIBC_2.43) to old versions so the .so loads on
        # older runtimes (e.g. flatpak glibc 2.42). See src/glibc_compat.c.
        -Wl,--wrap=atan2f -Wl,--wrap=asinf -Wl,--wrap=acosf
        -Wl,--wrap=log10f -Wl,--wrap=remainder
    )
endif()

# ── Audio decode libs (Opus + AAC, all platforms) ───────────────────────
# Separate link line so it applies regardless of the per-platform block above;
# CMake orders the static-lib deps. opusfile_dec → opus + ogg (transitively).
target_link_libraries(jsgame_libretro PRIVATE opusfile_dec opus ogg libxaacdec)
# audio_decoders.cpp includes opusfile.h + the libxaac decoder headers.
set_source_files_properties(src/webaudio/audio_decoders.cpp PROPERTIES
    INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/src/emshim;${CMAKE_CURRENT_SOURCE_DIR}/deps/simde;${CMAKE_CURRENT_SOURCE_DIR}/src;${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/opusfile/include;${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/opus/include;${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/ogg/include;${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/libxaac/decoder")

# ── GLES3 headers for the WebGL2 binding ─────────────────────────────────
# The binding links NO GL library. Every GL entry point is loaded at runtime from
# the libretro frontend's hw_render.get_proc_address (RetroArch owns the GL
# context, exactly like Flycast/mupen) — see src/gl/gl_procs.{h,c}. So we only
# need the GLES3 *headers* (types + PFN typedefs), which we vendor (Khronos, MIT)
# so the build is identical and self-contained on every platform: no system
# mesa-dev, no ANGLE, no EGL/GLESv2 link, no sidecar dylibs. Single-file core.
target_include_directories(jsgame_libretro PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/gl)

if(NOT MSVC)
    target_compile_options(jsgame_libretro PRIVATE -Wno-unused-parameter -fvisibility=hidden)
endif()

message(STATUS "")
message(STATUS "jsgame-libretro:")
message(STATUS "  libnode:   ${LIBNODE_DIR}")
message(STATUS "  libcanvas: ${LIBCANVAS_A}")
message(STATUS "  skia:      ${SKIA_LIB_DIR}")
message(STATUS "")

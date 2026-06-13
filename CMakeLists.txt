cmake_minimum_required(VERSION 3.16)
project(jsgame-libretro C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

if(MSVC)
    add_compile_options("$<$<COMPILE_LANGUAGE:CXX>:/std:c++20>" "$<$<COMPILE_LANGUAGE:CXX>:/Zc:__cplusplus>")
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
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

# ─── Core ────────────────────────────────────────────────────────────────

file(GLOB WEBAUDIO_SRC src/webaudio/*.cpp src/webaudio/nodes/*.cpp src/webaudio/utils/*.cpp)

add_library(jsgame_libretro SHARED
    src/libretro.c
    src/node_host.cpp
    src/binding_gl.cpp
    src/gl/binding_gl_full.cpp
    src/gl/gl_bindings.cpp
    src/binding_audio.cpp
    ${WEBAUDIO_SRC}
)
# vendored decoder headers (uaac AAC tables) trip gcc's C++ narrowing errors
if(NOT MSVC)
    set_source_files_properties(src/webaudio/audio_decoders.cpp PROPERTIES COMPILE_OPTIONS "-Wno-narrowing")
endif()
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
        usp10 fontsub ntdll gdi32 user32 ole32 oleaut32 shell32 advapi32)
    # libcanvas.lib + libnode.lib both bundle zlib/harfbuzz objects (dup defs);
    # /FORCE:MULTIPLE is MSVC's --allow-multiple-definition (take first, warn).
    target_link_options(jsgame_libretro PRIVATE
        "/WHOLEARCHIVE:${LIBCANVAS_A}" "/FORCE:MULTIPLE")
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
        dl m log android cpufeatures)
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
    )
endif()

# ── GLES3/EGL for the WebGL2 binding (gl_bindings.cpp) ───────────────────
# System on Linux, NDK on Android, ANGLE on macOS/Windows (set -DANGLE_DIR).
set(ANGLE_DIR "" CACHE PATH "Path to ANGLE (include/ + lib/) for macOS/Windows GLES3")
if(ANGLE_DIR AND EXISTS "${ANGLE_DIR}/include")
    target_include_directories(jsgame_libretro PRIVATE ${ANGLE_DIR}/include)
    if(APPLE)
        target_link_libraries(jsgame_libretro PRIVATE
            ${ANGLE_DIR}/lib/libEGL.dylib ${ANGLE_DIR}/lib/libGLESv2.dylib)
    elseif(WIN32)
        target_link_libraries(jsgame_libretro PRIVATE
            ${ANGLE_DIR}/lib/libEGL.lib ${ANGLE_DIR}/lib/libGLESv2.lib)
    endif()
elseif(ANDROID)
    target_link_libraries(jsgame_libretro PRIVATE GLESv3 EGL)
elseif(NOT WIN32 AND NOT APPLE)
    find_library(GLESV2_LIB GLESv2)
    find_library(EGL_LIB EGL)
    if(GLESV2_LIB)
        target_link_libraries(jsgame_libretro PRIVATE ${GLESV2_LIB})
    endif()
    if(EGL_LIB)
        target_link_libraries(jsgame_libretro PRIVATE ${EGL_LIB})
    endif()
endif()

if(NOT MSVC)
    target_compile_options(jsgame_libretro PRIVATE -Wno-unused-parameter -fvisibility=hidden)
endif()

message(STATUS "")
message(STATUS "jsgame-libretro:")
message(STATUS "  libnode:   ${LIBNODE_DIR}")
message(STATUS "  libcanvas: ${LIBCANVAS_A}")
message(STATUS "  skia:      ${SKIA_LIB_DIR}")
message(STATUS "")

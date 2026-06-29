// node_host.h — libnode embedding for jsgame-libretro
#ifndef JSG_NODE_HOST_H
#define JSG_NODE_HOST_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*jsg_log_fn)(int level, const char* msg); // level: 0=debug 1=info 2=warn 3=error

// Start the JS runtime for a piece of content.
// content_path: full path to the .jsg / .jsgame the frontend loaded.
// runtime_dir:  directory holding bootstrap.js (dev mode); NULL = embedded runtime.
// Returns 0 on success.
int jsg_host_start(const char* content_path, const char* runtime_dir, jsg_log_fn log);

// Run one frame: dispatch rAF, pump libuv. Returns 0 on success.
int jsg_host_frame(void);

// Framebuffer the JS side last presented (XRGB8888, tightly packed).
// Returns NULL if nothing presented yet. *width/*height set on success.
const uint32_t* jsg_host_framebuffer(unsigned* width, unsigned* height);

// Whether the game's display canvas is GL-backed (set by JS each frame). The
// core presents the HW framebuffer when true, else the software raster — so a
// game that renders GL offscreen and composites onto a 2D display canvas (or a
// pure-2D game) presents the correct surface even when a GL context exists.
bool jsg_host_display_is_gl(void);

// GPU-composite present: the GL texture id holding the composited frame this
// frame (0 if the display 2D canvas isn't GPU-backed). Consumed-and-cleared.
unsigned jsg_host_gpu_texture(unsigned* width, unsigned* height);
// GPU composite: scene (opaque, returned) + HUD (transparent overlay, out-param)
// texture ids. Consumed-and-cleared per call.
unsigned jsg_host_gpu_composite(unsigned* hud, unsigned* width, unsigned* height);

// Gamepad snapshot written by the core before each frame; read by the JS shim.
// One entry per port. buttons: bit i = RETRO_DEVICE_ID_JOYPAD_* pressed.
// axes: lx, ly, rx, ry in [-32768, 32767]. triggers: l2, r2 in [0, 32767].
typedef struct {
    uint32_t buttons;
    int16_t  lx, ly, rx, ry;
    int16_t  l2, r2;
    uint8_t  connected;
} jsg_pad_t;

void jsg_host_set_pads(const jsg_pad_t pads[4]);

// Real time elapsed since the previous retro_run, in microseconds, as reported
// by the frontend via RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK. The frontend
// substitutes the reference value (1e6/fps) during fast-forward / slow-motion /
// frame-stepping / pause, so the JS clock stays deterministic in those modes
// while tracking real time during a genuine stall (idiomatic libretro timing;
// see retro_frame_time_callback). Read by the JS shim each frame to advance the
// game clock; 0 until the first callback fires (JS falls back to 1000/60 then).
void jsg_host_set_frame_time_us(int64_t usec);

// Enqueue a keyboard event (code/key must be static strings — the mapping
// table in libretro.c provides them). Drained into the realm each frame.
void jsg_host_key_event(int down, const char* code, const char* key);

// SRAM region (localStorage backing store). Pointer must stay valid for the
// core's lifetime; frontend persists it as .srm.
void jsg_host_set_sram(uint8_t* sram, size_t size);

// Async-audio mode: pushes block when the ring is full (audio-clock pacing).
void jsg_host_set_audio_backpressure(bool enable);

// Audio pushed by JS for the current frame (interleaved stereo int16).
// Returns frame count (0 = emit silence) and resets the pending buffer.
size_t jsg_host_audio(const int16_t** samples);

// Run the game entry. Called once by the core: after context_reset for GL
// games, or on the first frame for software. Deferred so getContext('webgl2')
// doesn't race the frontend's async GL-context grant.
void jsg_host_begin(void);

// GL proc table from the frontend's hw render context (binding_gl.cpp).
void jsg_gl_set_procs(void* get_proc_address, uintptr_t default_fbo);
// Live per-frame default-framebuffer getter (RetroArch's FBO can change each frame).
void jsg_gl_set_fb_getter(void* get_current_framebuffer);
bool jsg_gl_ready(void);

// Tell the GL binding it's on a DESKTOP GL core context (not GLES), so it
// translates "#version 300 es" shaders to "#version 330 core" (gl_bindings.cpp).
void jsg_gl_set_desktop(int on);

// Stop the JS runtime for the current content (environment teardown; V8 stays up).
void jsg_host_stop(void);

#ifdef __cplusplus
}
#endif

#endif

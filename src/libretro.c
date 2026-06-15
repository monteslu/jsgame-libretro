// libretro.c — jsgame-libretro core entry points (S2: software framebuffer path)
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libretro.h"
#include "node_host.h"
#include "embedded_runtime.h"
#include "gl_detect.h"

// gl_blit.c — software-framebuffer -> GL texture -> frontend FBO (for WebGL
// games that composite their final image onto a 2D display canvas).
int  jsg_gl_blit_init(void* get_proc, int is_gles);
void jsg_gl_blit_present(const uint32_t* pixels, int w, int h, unsigned fbo);
// GPU-composite path: blit an existing GL texture (Skia GPU surface) into the
// frontend FBO — pure GPU->GPU, no upload/readback.
void jsg_gl_blit_texture(unsigned tex_id, int w, int h, unsigned fbo);
// Blend an overlay (transparent Skia HUD) over the scene in fbo. swap=1 for BGRA.
void jsg_gl_blit_overlay(unsigned tex_id, int w, int h, unsigned fbo, int swap);

#define JSG_VERSION "0.1.0"
#define DEFAULT_WIDTH 640
#define DEFAULT_HEIGHT 480
#define MAX_WIDTH 1920
#define MAX_HEIGHT 1080
#define AUDIO_RATE 48000.0
#define FPS 60.0
#define SRAM_SIZE (128 * 1024)

static retro_environment_t environ_cb;
static retro_video_refresh_t video_cb;
static retro_audio_sample_batch_t audio_batch_cb;
static retro_input_poll_t input_poll_cb;
static retro_input_state_t input_state_cb;
static struct retro_log_callback log_cb_struct;
static retro_log_printf_t log_cb;

static bool content_loaded = false;
static bool async_audio = false;     // frontend pulls audio on its own thread
static bool audio_running = false;
static struct retro_hw_render_callback hw_render;
static bool gl_active = false;
static bool jsg_begun = false;
static bool gl_is_gles = false;   // negotiated context dialect (for the blit shader)
static bool gl_blit_ready = false;

static void core_log(enum retro_log_level level, const char* fmt, ...);
// Monotonic millisecond clock for frame pacing. CLOCK_MONOTONIC is POSIX-only
// (absent on MSVC), so use QueryPerformanceCounter on Windows.
#ifdef _WIN32
#include <windows.h>
static double now_ms_dbg(void){
    static LARGE_INTEGER freq; if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)freq.QuadPart;
}
static void sleep_ms_dbg(double ms){ if (ms > 0.0) Sleep((DWORD)(ms + 0.5)); }
#else
#include <time.h>
static double now_ms_dbg(void){struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);return ts.tv_sec*1000.0+ts.tv_nsec/1000000.0;}
static void sleep_ms_dbg(double ms){
    struct timespec ts;
    ts.tv_sec  = (time_t)(ms / 1000.0);
    ts.tv_nsec = (long)((ms - ts.tv_sec * 1000.0) * 1000000.0);
    nanosleep(&ts, NULL);
}
#endif
static int16_t silence[(int)(AUDIO_RATE / FPS) * 2];

static void context_reset(void) {
    jsg_gl_set_procs((void*)hw_render.get_proc_address,
                     (uintptr_t)hw_render.get_current_framebuffer());
    // RetroArch's default FBO can change per frame — give the GL binding the
    // live getter so bindFramebuffer(null) always targets the CURRENT FBO.
    jsg_gl_set_fb_getter((void*)hw_render.get_current_framebuffer);
    // Init the software->GL blit (used when a WebGL game composites onto a 2D
    // display canvas — HW render is active so we can't software-present directly).
    gl_blit_ready = jsg_gl_blit_init((void*)hw_render.get_proc_address, gl_is_gles ? 1 : 0);
    core_log(RETRO_LOG_INFO, "GL context ready (blit %s)", gl_blit_ready ? "ok" : "FAILED");
}
static void context_destroy(void) {
    core_log(RETRO_LOG_INFO, "GL context destroyed");
}

// Async audio: called on the frontend's AUDIO thread whenever it wants data.
// Decouples audio writes from the vsync'd video loop (blocking writes inside
// retro_run serialize with vblank waits and halve the frame rate).
static void audio_callback(void) {
    const int16_t* samples = NULL;
    size_t frames = jsg_host_audio(&samples);
    // Deliver only real data — injecting silence between chunks IS static.
    if (frames > 0) audio_batch_cb(samples, frames);
    // DIAGNOSTIC: how often does the frontend pull, and how much each time?
    static unsigned calls = 0, zero = 0; static double last = 0;
    calls++; if (frames == 0) zero++;
    double t = now_ms_dbg();
    if (t - last > 1000.0) {
        core_log(RETRO_LOG_INFO, "[audiocb] %u calls/sec, %u empty, last=%zu frames",
                 calls, zero, frames);
        calls = 0; zero = 0; last = t;
    }
}
static void audio_set_state(bool enable) { audio_running = enable; }
static unsigned cur_width = DEFAULT_WIDTH;
static unsigned cur_height = DEFAULT_HEIGHT;
static uint8_t sram[SRAM_SIZE];

static void core_log(enum retro_log_level level, const char* fmt, ...) {
    char buf[2048];
    va_list va;
    va_start(va, fmt);
    vsnprintf(buf, sizeof(buf), fmt, va);
    va_end(va);
    if (log_cb) log_cb(level, "%s\n", buf);
    else fprintf(stderr, "[jsgame] %s\n", buf);
}

// retro_key -> DOM {code,key}. Static strings (jsg_host_key_event stores ptrs).
// Covers the keys games actually use; unknowns fall through to no event.
static void map_key(unsigned k, const char** code, const char** key) {
    static char code_buf[8], key_buf[8];
    *code = NULL; *key = NULL;
    if (k >= 97 && k <= 122) {  // a-z (RETROK is lowercase ASCII)
        code_buf[0]='K';code_buf[1]='e';code_buf[2]='y';code_buf[3]=(char)(k-32);code_buf[4]=0;
        key_buf[0]=(char)k;key_buf[1]=0;
        *code=code_buf;*key=key_buf;return;
    }
    if (k >= 48 && k <= 57) {  // 0-9
        code_buf[0]='D';code_buf[1]='i';code_buf[2]='g';code_buf[3]='i';code_buf[4]='t';code_buf[5]=(char)k;code_buf[6]=0;
        key_buf[0]=(char)k;key_buf[1]=0;
        *code=code_buf;*key=key_buf;return;
    }
    switch (k) {
        case 276: *code="ArrowLeft";  *key="ArrowLeft";  break;
        case 275: *code="ArrowRight"; *key="ArrowRight"; break;
        case 273: *code="ArrowUp";    *key="ArrowUp";    break;
        case 274: *code="ArrowDown";  *key="ArrowDown";  break;
        case 32:  *code="Space";      *key=" ";          break;
        case 13:  *code="Enter";      *key="Enter";      break;
        case 27:  *code="Escape";     *key="Escape";     break;
        case 9:   *code="Tab";        *key="Tab";        break;
        case 8:   *code="Backspace";  *key="Backspace";  break;
        case 304: *code="ShiftLeft";  *key="Shift";      break;
        case 303: *code="ShiftRight"; *key="Shift";      break;
        case 306: *code="ControlLeft";*key="Control";    break;
        case 305: *code="ControlRight";*key="Control";   break;
        case 308: *code="AltLeft";    *key="Alt";        break;
        case 307: *code="AltRight";   *key="Alt";        break;
        default: break;
    }
}

static void keyboard_cb(bool down, unsigned keycode, uint32_t character, uint16_t key_modifiers) {
    (void)character; (void)key_modifiers;
    const char* code; const char* key;
    map_key(keycode, &code, &key);
    if (code) jsg_host_key_event(down ? 1 : 0, code, key);
}

static void host_log(int level, const char* msg) {
    enum retro_log_level lvl = RETRO_LOG_INFO;
    if (level <= 0) lvl = RETRO_LOG_DEBUG;
    else if (level == 2) lvl = RETRO_LOG_WARN;
    else if (level >= 3) lvl = RETRO_LOG_ERROR;
    core_log(lvl, "%s", msg);
}

// ─── libretro implementation ─────────────────────────────────────────────

RETRO_API void retro_set_environment(retro_environment_t cb) {
    environ_cb = cb;
    if (cb(RETRO_ENVIRONMENT_GET_LOG_INTERFACE, &log_cb_struct))
        log_cb = log_cb_struct.log;

    // Content is required (a .jsg marker or .jsgame zip).
    bool no_game = false;
    cb(RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME, &no_game);

    struct retro_keyboard_callback kbcb = { keyboard_cb };
    cb(RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK, &kbcb);
}

RETRO_API void retro_set_video_refresh(retro_video_refresh_t cb) { video_cb = cb; }
RETRO_API void retro_set_audio_sample(retro_audio_sample_t cb) { (void)cb; }
RETRO_API void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb) { audio_batch_cb = cb; }
RETRO_API void retro_set_input_poll(retro_input_poll_t cb) { input_poll_cb = cb; }
RETRO_API void retro_set_input_state(retro_input_state_t cb) { input_state_cb = cb; }

RETRO_API void retro_init(void) {}
RETRO_API void retro_deinit(void) {}

RETRO_API unsigned retro_api_version(void) { return RETRO_API_VERSION; }

RETRO_API void retro_get_system_info(struct retro_system_info* info) {
    memset(info, 0, sizeof(*info));
    info->library_name = "jsgame";
    info->library_version = JSG_VERSION;
    info->valid_extensions = "jsg|jsgame";
    info->need_fullpath = true;     // we read content from disk ourselves
    info->block_extract = true;     // never auto-extract .jsgame zips
}

RETRO_API void retro_get_system_av_info(struct retro_system_av_info* info) {
    memset(info, 0, sizeof(*info));
    info->geometry.base_width = cur_width;
    info->geometry.base_height = cur_height;
    info->geometry.max_width = MAX_WIDTH;
    info->geometry.max_height = MAX_HEIGHT;
    info->geometry.aspect_ratio = (float)cur_width / (float)cur_height;
    info->timing.fps = FPS;
    info->timing.sample_rate = AUDIO_RATE;
}

RETRO_API void retro_set_controller_port_device(unsigned port, unsigned device) {
    (void)port; (void)device;
}

RETRO_API void retro_reset(void) {
    // TODO: restart game realm
}

static void poll_pads(void) {
    jsg_pad_t pads[4];
    memset(pads, 0, sizeof(pads));
    for (unsigned p = 0; p < 4; p++) {
        uint32_t buttons = 0;
        for (unsigned id = 0; id <= RETRO_DEVICE_ID_JOYPAD_R3; id++) {
            if (input_state_cb(p, RETRO_DEVICE_JOYPAD, 0, id))
                buttons |= (1u << id);
        }
        pads[p].buttons = buttons;
        pads[p].lx = input_state_cb(p, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_LEFT, RETRO_DEVICE_ID_ANALOG_X);
        pads[p].ly = input_state_cb(p, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_LEFT, RETRO_DEVICE_ID_ANALOG_Y);
        pads[p].rx = input_state_cb(p, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_RIGHT, RETRO_DEVICE_ID_ANALOG_X);
        pads[p].ry = input_state_cb(p, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_RIGHT, RETRO_DEVICE_ID_ANALOG_Y);
        pads[p].l2 = input_state_cb(p, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_BUTTON, RETRO_DEVICE_ID_JOYPAD_L2);
        pads[p].r2 = input_state_cb(p, RETRO_DEVICE_ANALOG, RETRO_DEVICE_INDEX_ANALOG_BUTTON, RETRO_DEVICE_ID_JOYPAD_R2);
        pads[p].connected = 1;
    }
    jsg_host_set_pads(pads);
}

// Pace retro_run to 60fps. Audio is produced at real wall-clock rate in JS
// (decoupled from frame count), so this only governs VIDEO cadence — it does
// NOT affect audio rate. Needed because the software-framebuffer present path
// isn't throttled by the GL driver's vsync, so retro_run would free-run at
// thousands of fps. The GL hardware-render path is driver-paced; skip it there.
static void pace_60fps(void) {
    static double next = 0.0;
    const double period = 1000.0 / FPS;
    double t = now_ms_dbg();
    if (next == 0.0) { next = t + period; return; }
    double wait = next - t;
    // nanosleep overshoots (kernel tick granularity = several ms), so sleeping
    // the whole 'wait' lands LONG -> ~30fps -> game runs at half speed. Sleep
    // until ~1.5ms short of target, then busy-trim only that last ~1.5ms. The
    // per-frame work is ~1ms with huge headroom, so a 1.5ms trim is cheap and
    // does NOT starve the game (unlike busy-waiting the full 15ms).
    if (wait > 2.0) {
        sleep_ms_dbg(wait - 1.5);
    }
    while (now_ms_dbg() < next) { /* trim final ~1.5ms for 60fps accuracy */ }
    next += period;
    t = now_ms_dbg();
    if (t > next) next = t + period;  // resync after a hitch/pause, no burst
}

RETRO_API void retro_run(void) {
    input_poll_cb();
    poll_pads();

    // Pace to 60fps for BOTH software AND GL paths. The GL hardware-render
    // present here is NOT reliably vsync-throttled (observed 6000fps), which
    // free-runs the game loop and lets object/particle spawns explode -> freeze.
    // Audio is wall-clock based, so capping the frame rate doesn't affect it.
    pace_60fps();

    // Defer the game entry until GL is actually ready (context_reset fired),
    // or run it immediately for software. Then normal frames.
    if (!jsg_begun) {
        if (!gl_active || jsg_gl_ready()) {
            jsg_host_begin();
            jsg_begun = true;
        } else {
            return;  // GL requested but context not granted yet; wait a frame
        }
    }

    jsg_host_frame();

    // Present the HW framebuffer only when the GL context is live AND the
    // game's DISPLAY canvas is the GL one. A game can render GL into an
    // offscreen canvas and composite the final image onto a 2D display canvas
    // (with a HUD on top) — then the final pixels live in the software raster,
    // not the GL FBO, so we fall through to the framebuffer path below.
    // Path A: GL-native game (display canvas IS the GL canvas). Present the FBO.
    if (gl_active && jsg_gl_ready() && jsg_host_display_is_gl()) {
        video_cb(RETRO_HW_FRAME_BUFFER_VALID, cur_width, cur_height, 0);
        if (!async_audio) {
            const int16_t* gl_samples = NULL;
            size_t gl_frames = jsg_host_audio(&gl_samples);
            if (gl_frames > 0) audio_batch_cb(gl_samples, gl_frames);
            else audio_batch_cb(silence, (size_t)(AUDIO_RATE / FPS));
        }
        return;
    }

    // Path B-GPU: the display 2D canvas is GPU-backed (Ganesh). Its composited
    // scene+HUD already live in a GL texture — blit THAT into RA's FBO
    // (GPU->GPU, no readback, no upload). This is the zero-copy 3D path.
    if (gl_active && jsg_gl_ready() && gl_blit_ready) {
        unsigned gw = 0, gh = 0, hud = 0;
        unsigned scene_tex = jsg_host_gpu_composite(&hud, &gw, &gh);
        if (scene_tex) {
            if (gw != cur_width || gh != cur_height) {
                cur_width = gw; cur_height = gh;
                struct retro_game_geometry geom = {
                    .base_width = gw, .base_height = gh,
                    .max_width = MAX_WIDTH, .max_height = MAX_HEIGHT,
                    .aspect_ratio = (float)gw / (float)gh,
                };
                environ_cb(RETRO_ENVIRONMENT_SET_GEOMETRY, &geom);
            }
            unsigned curfb = (unsigned)hw_render.get_current_framebuffer();
            // Scene: opaque, RGBA (clears the FBO). HUD: transparent Skia overlay
            // (N32=BGRA), alpha-blended on top with swizzle.
            jsg_gl_blit_texture(scene_tex, (int)gw, (int)gh, curfb);
            if (hud) jsg_gl_blit_overlay(hud, (int)gw, (int)gh, curfb, 0);
            video_cb(RETRO_HW_FRAME_BUFFER_VALID, cur_width, cur_height, 0);
            if (!async_audio) {
                const int16_t* gs = NULL;
                size_t gf = jsg_host_audio(&gs);
                if (gf > 0) audio_batch_cb(gs, gf);
                else audio_batch_cb(silence, (size_t)(AUDIO_RATE / FPS));
            }
            return;
        }
    }

    unsigned w = 0, h = 0;
    const uint32_t* fb = jsg_host_framebuffer(&w, &h);
    if (fb && (w != cur_width || h != cur_height)) {
        cur_width = w; cur_height = h;
        struct retro_game_geometry geom = {
            .base_width = w, .base_height = h,
            .max_width = MAX_WIDTH, .max_height = MAX_HEIGHT,
            .aspect_ratio = (float)w / (float)h,
        };
        environ_cb(RETRO_ENVIRONMENT_SET_GEOMETRY, &geom);
    }

    // Path B: HW render is active (a WebGL game) but the DISPLAY is a 2D canvas
    // (3D composited into 2D + a HUD). RetroArch ignores software video_cb in HW
    // mode, so upload the software framebuffer as a GL texture and draw it into
    // the frontend FBO, then signal a valid HW frame.
    if (gl_active && jsg_gl_ready() && gl_blit_ready && fb) {
        jsg_gl_blit_present(fb, (int)w, (int)h,
                            (unsigned)hw_render.get_current_framebuffer());
        video_cb(RETRO_HW_FRAME_BUFFER_VALID, cur_width, cur_height, 0);
    }
    // Path C: pure software (no GL at all). Present the raster directly.
    else if (fb) {
        video_cb(fb, w, h, w * sizeof(uint32_t));
    } else {
        video_cb(NULL, cur_width, cur_height, cur_width * sizeof(uint32_t));
    }

    if (!async_audio) {
        const int16_t* samples = NULL;
        size_t frames = jsg_host_audio(&samples);
        if (frames > 0) audio_batch_cb(samples, frames);
        else audio_batch_cb(silence, (size_t)(AUDIO_RATE / FPS));
    }
}

RETRO_API bool retro_load_game(const struct retro_game_info* game) {
    if (!game || !game->path) return false;

    enum retro_pixel_format fmt = RETRO_PIXEL_FORMAT_XRGB8888;
    if (!environ_cb(RETRO_ENVIRONMENT_SET_PIXEL_FORMAT, &fmt)) {
        core_log(RETRO_LOG_ERROR, "XRGB8888 not supported by frontend");
        return false;
    }

    // GL is per-game and must be decided BEFORE bootstrap runs (the HW context
    // is requested here, in retro_load_game — by the time the game calls
    // getContext('webgl2') it's too late to ask the frontend). We predict it by
    // scanning the game's own source for a webgl getContext call (multi-canvas
    // safe; no author-facing config). JSGAME_GL=1 forces it on for a rare miss.
    // 2D-only games skip GL so the frontend keeps the software framebuffer path.
    bool wants_gl = getenv("JSGAME_GL") != NULL || jsg_game_wants_gl(game->path);
    if (wants_gl) {
        // Ask the frontend which GL API it provides (GET_PREFERRED_HW_RENDER),
        // rather than guessing per-target. Our WebGL2 binding (gl_bindings.cpp)
        // speaks GLES3 only — it calls GLES entry points (glClearDepthf,
        // glReleaseShaderCompiler, precision formats) absent on desktop GL-core,
        // so we can run ONLY on a GLES-family context. Android & handhelds are
        // native GLES3; a desktop frontend must offer GLES3 (e.g. via ANGLE).
        enum retro_hw_context_type pref = RETRO_HW_CONTEXT_NONE;
        bool flexible = environ_cb(RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER, &pref);
        core_log(RETRO_LOG_INFO, "preferred HW render: %d (frontend flexible=%d)", (int)pref, (int)flexible);

        // Pick the context type the frontend actually offers. Our WebGL2 binding
        // is written against GLES3 headers, but every GLES3 entry point it calls
        // also exists in desktop GL 3.3+ core — EXCEPT 5 (glClearDepthf,
        // glDepthRangef, glReleaseShaderCompiler, glGetShaderPrecisionFormat,
        // glShaderBinary), which gl_compat.c shims onto desktop-GL equivalents.
        // So accept desktop GL-core too: on a desktop frontend (RetroArch's
        // gl/glcore driver) that's what's on offer; GLES3 frontends (Android,
        // handhelds, ANGLE) still get GLES3.
        // GET_PREFERRED_HW_RENDER is unreliable: Android's GLES build reports
        // RETRO_HW_CONTEXT_OPENGL anyway, so we can't trust it to pick the type.
        // Instead, actually TRY each context type and keep the first SET_HW_RENDER
        // that succeeds. Order GLES3 first (Android/ANGLE/handhelds — our native
        // path), then desktop GL-core 3.3 (desktop Linux RetroArch gl/glcore),
        // then desktop GL. The frontend rejects mismatches, so this converges to
        // whatever it actually provides.
        (void)pref;
        struct { enum retro_hw_context_type type; unsigned maj, min; bool desktop; } tries[] = {
            { RETRO_HW_CONTEXT_OPENGLES3,   0, 0, false },
            { RETRO_HW_CONTEXT_OPENGL_CORE, 3, 3, true  },
            { RETRO_HW_CONTEXT_OPENGL,      0, 0, true  },
        };
        for (size_t i = 0; i < sizeof(tries)/sizeof(tries[0]) && !gl_active; i++) {
            memset(&hw_render, 0, sizeof(hw_render));
            hw_render.context_type    = tries[i].type;
            hw_render.version_major   = tries[i].maj;
            hw_render.version_minor   = tries[i].min;
            hw_render.context_reset   = context_reset;
            hw_render.context_destroy = context_destroy;
            hw_render.depth           = true;
            hw_render.stencil         = true;
            hw_render.bottom_left_origin = true;
            if (environ_cb(RETRO_ENVIRONMENT_SET_HW_RENDER, &hw_render)) {
                gl_active = true;
                gl_is_gles = !tries[i].desktop;   // for the blit shader dialect
                // Desktop GL needs GLES "#version 300 es" shaders translated to
                // "#version 330 core"; native GLES3 leaves them untouched.
                jsg_gl_set_desktop(tries[i].desktop);
                core_log(RETRO_LOG_INFO, "HW render negotiated (context type %d)",
                         (int)tries[i].type);
            }
        }
        if (!gl_active) {
            core_log(RETRO_LOG_WARN,
                "no GL context available; GL games unavailable on this frontend");
        }
    }

    const char* runtime_dir = getenv("JSGAME_RUNTIME_DIR");  // dev override
    if (!runtime_dir) {
        runtime_dir = jsg_extract_embedded_runtime();  // self-contained release
        if (!runtime_dir) {
            core_log(RETRO_LOG_ERROR,
                     "embedded runtime extraction failed and JSGAME_RUNTIME_DIR unset");
            return false;
        }
        core_log(RETRO_LOG_INFO, "using embedded runtime at %s", runtime_dir);
    }

    // The async audio callback (SET_AUDIO_CALLBACK) busy-spins: the frontend's
    // audio thread calls it ~23M times/sec, almost always on an empty ring
    // (audio is only produced 60x/sec by the video loop), which both starves
    // playback (choppy) and steals CPU (destabilizes video fps). Use the SYNC
    // path instead — deliver one tick of audio inside retro_run, paced by the
    // frontend's audio_sync. This is the PLAN's pull model. JSGAME_ASYNC_AUDIO=1
    // re-enables the old callback path for comparison.
    if (getenv("JSGAME_ASYNC_AUDIO")) {
        struct retro_audio_callback audio_cb_desc = { audio_callback, audio_set_state };
        async_audio = environ_cb(RETRO_ENVIRONMENT_SET_AUDIO_CALLBACK, &audio_cb_desc);
    } else {
        async_audio = false;
    }
    jsg_host_set_audio_backpressure(async_audio);
    core_log(RETRO_LOG_INFO, "audio: %s", async_audio ? "async (callback)" : "sync (per-frame)");

    jsg_host_set_sram(sram, SRAM_SIZE);
    core_log(RETRO_LOG_INFO, "loading content: %s", game->path);
    if (jsg_host_start(game->path, runtime_dir, host_log) != 0) {
        core_log(RETRO_LOG_ERROR, "JS runtime failed to start");
        return false;
    }
    content_loaded = true;
    return true;
}

RETRO_API bool retro_load_game_special(unsigned type, const struct retro_game_info* info, size_t num) {
    (void)type; (void)info; (void)num;
    return false;
}

RETRO_API void retro_unload_game(void) {
    if (content_loaded) {
        jsg_host_stop();
        content_loaded = false;
    }
}

RETRO_API unsigned retro_get_region(void) { return RETRO_REGION_NTSC; }

// No save states (V8 heap is not serializable). SRAM carries localStorage.
RETRO_API size_t retro_serialize_size(void) { return 0; }
RETRO_API bool retro_serialize(void* data, size_t size) { (void)data; (void)size; return false; }
RETRO_API bool retro_unserialize(const void* data, size_t size) { (void)data; (void)size; return false; }

RETRO_API void retro_cheat_reset(void) {}
RETRO_API void retro_cheat_set(unsigned index, bool enabled, const char* code) {
    (void)index; (void)enabled; (void)code;
}

RETRO_API void* retro_get_memory_data(unsigned id) {
    if (id == RETRO_MEMORY_SAVE_RAM) return sram;
    return NULL;
}

RETRO_API size_t retro_get_memory_size(unsigned id) {
    if (id == RETRO_MEMORY_SAVE_RAM) return SRAM_SIZE;
    return 0;
}

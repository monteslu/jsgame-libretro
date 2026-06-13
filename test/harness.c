// harness.c — headless libretro harness: dlopen the core, boot content,
// run frames, verify framebuffer pixels. Exit 0 = pass.
//
//   cc -o harness harness.c -ldl && ./harness ../build/jsgame_libretro.so <content>
#include <dlfcn.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../src/libretro.h"

#ifdef JSG_GL
#include <EGL/egl.h>
#include <GLES3/gl3.h>
static struct retro_hw_render_callback* g_hw = NULL;
static uint32_t g_gl_center;
static uintptr_t harness_get_fb(void) { return 0; }
static retro_proc_address_t harness_get_proc(const char* sym) {
    return (retro_proc_address_t)eglGetProcAddress(sym);
}
static int egl_init(int w, int h) {
    EGLDisplay d = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    eglInitialize(d, NULL, NULL);
    eglBindAPI(EGL_OPENGL_ES_API);
    EGLConfig cfg; EGLint n;
    EGLint attr[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE,
                     EGL_OPENGL_ES3_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8,
                     EGL_BLUE_SIZE, 8, EGL_DEPTH_SIZE, 16, EGL_NONE};
    eglChooseConfig(d, attr, &cfg, 1, &n);
    EGLint pba[] = {EGL_WIDTH, w, EGL_HEIGHT, h, EGL_NONE};
    EGLSurface s = eglCreatePbufferSurface(d, cfg, pba);
    EGLint ca[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    EGLContext c = eglCreateContext(d, cfg, EGL_NO_CONTEXT, ca);
    return eglMakeCurrent(d, s, s, c) ? 0 : -1;
}
#endif

static const uint32_t* g_fb;
static unsigned g_fb_w, g_fb_h;
static size_t g_audio_frames;

static void log_printf(enum retro_log_level level, const char* fmt, ...) {
    va_list va;
    va_start(va, fmt);
    fprintf(stderr, "[core:%d] ", level);
    vfprintf(stderr, fmt, va);
    va_end(va);
}

static bool env_cb(unsigned cmd, void* data) {
    switch (cmd) {
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
            return *(enum retro_pixel_format*)data == RETRO_PIXEL_FORMAT_XRGB8888;
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
            ((struct retro_log_callback*)data)->log = log_printf;
            return true;
        case RETRO_ENVIRONMENT_SET_GEOMETRY:
            return true;
#ifdef JSG_GL
        case RETRO_ENVIRONMENT_SET_HW_RENDER: {
            g_hw = (struct retro_hw_render_callback*)data;
            g_hw->get_current_framebuffer = harness_get_fb;
            g_hw->get_proc_address = harness_get_proc;
            return true;
        }
#endif
        default:
            return false;
    }
}

static void video_cb(const void* data, unsigned width, unsigned height, size_t pitch) {
    (void)pitch;
#ifdef JSG_GL
    if (data == RETRO_HW_FRAME_BUFFER_VALID) {
        uint8_t px[4] = {0};
        glReadPixels(width / 2, height / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
        g_gl_center = px[0] | (px[1] << 8) | (px[2] << 16);
        g_fb_w = width; g_fb_h = height;
        return;
    }
#endif
    g_fb = (const uint32_t*)data;
    g_fb_w = width;
    g_fb_h = height;
}

static int16_t g_audio_peak;
static int g_audio_maxjump;   /* max |delta| between consecutive L samples,
                                 across batch boundaries too — a 440Hz sine
                                 at 48k peaks ~943; garbage shows ~30000 */
static int g_last_l = 0;
static FILE* g_dump;
static size_t audio_batch_cb(const int16_t* data, size_t frames) {
    if (g_dump && data) fwrite(data, 4, frames, g_dump);
    for (size_t i = 0; data && i < frames; i++) {
        int16_t l = data[i * 2];
        int16_t a = l < 0 ? -l : l;
        if (a > g_audio_peak) g_audio_peak = a;
        int jump = l - g_last_l; if (jump < 0) jump = -jump;
        if (g_audio_frames + i > 0 && jump > g_audio_maxjump) g_audio_maxjump = jump;
        g_last_l = l;
    }
    g_audio_frames += frames;
    return frames;
}

static void input_poll_cb(void) {}
static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id) {
    // Pretend pad 0 holds START + dpad-right, lx = 12345
    if (port == 0 && device == RETRO_DEVICE_JOYPAD &&
        (id == RETRO_DEVICE_ID_JOYPAD_START || id == RETRO_DEVICE_ID_JOYPAD_RIGHT))
        return 1;
    if (port == 0 && device == RETRO_DEVICE_ANALOG &&
        index == RETRO_DEVICE_INDEX_ANALOG_LEFT && id == RETRO_DEVICE_ID_ANALOG_X)
        return 12345;
    return 0;
}

static void audio_cb(int16_t l, int16_t r) { (void)l; (void)r; }

#define LOAD(sym) sym = dlsym(core, #sym); if (!sym) { fprintf(stderr, "missing symbol %s\n", #sym); return 1; }

int main(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s <core.so> <content>\n", argv[0]);
        return 2;
    }
    void* core = dlopen(argv[1], RTLD_LAZY | RTLD_LOCAL);
    if (!core) {
        fprintf(stderr, "dlopen: %s\n", dlerror());
        return 1;
    }

    void (*retro_set_environment)(retro_environment_t);
    void (*retro_set_video_refresh)(retro_video_refresh_t);
    void (*retro_set_audio_sample)(retro_audio_sample_t);
    void (*retro_set_audio_sample_batch)(retro_audio_sample_batch_t);
    void (*retro_set_input_poll)(retro_input_poll_t);
    void (*retro_set_input_state)(retro_input_state_t);
    void (*retro_init)(void);
    bool (*retro_load_game)(const struct retro_game_info*);
    void (*retro_run)(void);
    void (*retro_unload_game)(void);
    void (*retro_deinit)(void);

    LOAD(retro_set_environment)
    LOAD(retro_set_video_refresh)
    LOAD(retro_set_audio_sample)
    LOAD(retro_set_audio_sample_batch)
    LOAD(retro_set_input_poll)
    LOAD(retro_set_input_state)
    LOAD(retro_init)
    LOAD(retro_load_game)
    LOAD(retro_run)
    LOAD(retro_unload_game)
    LOAD(retro_deinit)

    retro_set_environment(env_cb);
    retro_set_video_refresh(video_cb);
    retro_set_audio_sample(audio_cb);
    retro_set_audio_sample_batch(audio_batch_cb);
    retro_set_input_poll(input_poll_cb);
    retro_set_input_state(input_state_cb);
    retro_init();

#ifdef JSG_GL
    if (egl_init(640, 480) != 0) { fprintf(stderr, "FAIL: egl\n"); return 1; }
#endif
    struct retro_game_info game = {.path = argv[2], .data = NULL, .size = 0, .meta = NULL};
    if (!retro_load_game(&game)) {
        fprintf(stderr, "FAIL: retro_load_game\n");
        return 1;
    }

#ifdef JSG_GL
    if (g_hw && g_hw->context_reset) g_hw->context_reset();
#endif
    int frames = argc > 3 ? atoi(argv[3]) : 30;
    const char* dump = getenv("JSGAME_AUDIO_DUMP");
    if (dump) g_dump = fopen(dump, "wb");
    int pace_us = getenv("JSGAME_PACE_MS") ? atoi(getenv("JSGAME_PACE_MS")) * 1000 : 0;
    for (int i = 0; i < frames; i++) { retro_run(); if (pace_us) usleep(pace_us); }
    if (g_dump) fclose(g_dump);
#ifdef JSG_GL
    printf("gl center pixel: %06X\n", g_gl_center);
    printf(g_gl_center ? "PASS\n" : "FAIL: gl center black\n");
    retro_unload_game(); retro_deinit();
    return g_gl_center ? 0 : 1;
#endif

    if (!g_fb || g_fb_w == 0) {
        fprintf(stderr, "FAIL: no framebuffer presented after 30 frames\n");
        return 1;
    }
    printf("framebuffer: %ux%u, audio frames: %zu, audio peak: %d, audio maxjump: %d\n", g_fb_w, g_fb_h, g_audio_frames, g_audio_peak, g_audio_maxjump);

    // Diagnostic bars from bootstrap.js: red @ (100,80), green @ (260,80), blue @ (420,80)
    uint32_t red = g_fb[80 * g_fb_w + 100] & 0xFFFFFF;
    uint32_t green = g_fb[80 * g_fb_w + 260] & 0xFFFFFF;
    uint32_t blue = g_fb[80 * g_fb_w + 420] & 0xFFFFFF;
    printf("bars: red=%06X green=%06X blue=%06X\n", red, green, blue);

    int ok = (red == 0xFF0000) && (green == 0x00FF00) && (blue == 0x0000FF);
    if (!ok) {
        if (red == 0x0000FF && blue == 0xFF0000)
            fprintf(stderr, "FAIL: channels swapped (RGBA vs BGRA) — swizzle needed\n");
        else
            fprintf(stderr, "FAIL: unexpected colors\n");
    }

    retro_unload_game();
    retro_deinit();
    printf(ok ? "PASS\n" : "FAIL\n");
    return ok ? 0 : 1;
}

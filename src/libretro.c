// libretro.c — jsgame-libretro core entry points (S2: software framebuffer path)
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libretro.h"
#include "node_host.h"

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
static unsigned cur_width = DEFAULT_WIDTH;
static unsigned cur_height = DEFAULT_HEIGHT;
static uint8_t sram[SRAM_SIZE];
static int16_t silence[(int)(AUDIO_RATE / FPS) * 2];

static void core_log(enum retro_log_level level, const char* fmt, ...) {
    char buf[2048];
    va_list va;
    va_start(va, fmt);
    vsnprintf(buf, sizeof(buf), fmt, va);
    va_end(va);
    if (log_cb) log_cb(level, "%s\n", buf);
    else fprintf(stderr, "[jsgame] %s\n", buf);
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

RETRO_API void retro_run(void) {
    input_poll_cb();
    poll_pads();

    jsg_host_frame();

    unsigned w = 0, h = 0;
    const uint32_t* fb = jsg_host_framebuffer(&w, &h);
    if (fb) {
        if (w != cur_width || h != cur_height) {
            cur_width = w;
            cur_height = h;
            struct retro_game_geometry geom = {
                .base_width = w, .base_height = h,
                .max_width = MAX_WIDTH, .max_height = MAX_HEIGHT,
                .aspect_ratio = (float)w / (float)h,
            };
            environ_cb(RETRO_ENVIRONMENT_SET_GEOMETRY, &geom);
        }
        video_cb(fb, w, h, w * sizeof(uint32_t));
    } else {
        video_cb(NULL, cur_width, cur_height, cur_width * sizeof(uint32_t));
    }

    // S2: silence. Real audio lands in Phase 2.
    audio_batch_cb(silence, (size_t)(AUDIO_RATE / FPS));
}

RETRO_API bool retro_load_game(const struct retro_game_info* game) {
    if (!game || !game->path) return false;

    enum retro_pixel_format fmt = RETRO_PIXEL_FORMAT_XRGB8888;
    if (!environ_cb(RETRO_ENVIRONMENT_SET_PIXEL_FORMAT, &fmt)) {
        core_log(RETRO_LOG_ERROR, "XRGB8888 not supported by frontend");
        return false;
    }

    const char* runtime_dir = getenv("JSGAME_RUNTIME_DIR");  // dev mode
    if (!runtime_dir) {
        core_log(RETRO_LOG_ERROR,
                 "JSGAME_RUNTIME_DIR not set (embedded runtime not wired yet)");
        return false;
    }

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

// node_host.cpp — libnode embedding for jsgame-libretro.
// Chassis pattern from wasmcart-native: InitializeOncePerProcess +
// CommonEnvironmentSetup + LoadEnvironment + uv_run(NOWAIT) per frame.
// V8 is initialized once per process and never disposed (V8 cannot re-init).

// libnode.a references the embedded-snapshot accessor but doesn't define it
// for embedders; we don't use snapshots.
namespace node {
struct SnapshotData;
class SnapshotBuilder {
 public:
  static const SnapshotData* GetEmbeddedSnapshotData();
};
const SnapshotData* SnapshotBuilder::GetEmbeddedSnapshotData() { return nullptr; }
}  // namespace node

#include "node.h"
#include "node_api.h"
#include "uv.h"
#include "v8.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <memory>
#include <string>
#include <vector>

#include "node_host.h"

// @napi-rs/canvas staticlib registration entry (napi-rs emits this symbol).
extern "C" napi_value napi_register_module_v1(napi_env env, napi_value exports);
// GL binding (binding_gl.cpp)
extern "C" napi_value jsg_gl_register(napi_env env, napi_value exports);
// Audio binding (binding_audio.cpp)
extern "C" napi_value jsg_audio_register(napi_env env, napi_value exports);

// ─── Module state ────────────────────────────────────────────────────────

// Deliberately leaked (raw new, never deleted): static-dtor teardown of the
// Environment runs napi finalizers after Rust TLS is destroyed → abort at
// process exit (napi-rs raw_finalize_unchecked). The OS reclaims at exit.
static node::MultiIsolatePlatform* g_platform = nullptr;
static node::CommonEnvironmentSetup* g_setup = nullptr;
static v8::Isolate* g_isolate = nullptr;
static node::Environment* g_env = nullptr;
static bool g_v8_initialized = false;
static bool g_bootstrapped = false;
static jsg_log_fn g_log = nullptr;

static uint32_t* g_fb = nullptr;  // XRGB8888, owned here
static unsigned g_fb_w = 0, g_fb_h = 0;
static unsigned g_fb_cap = 0;  // allocated pixels

static jsg_pad_t g_pads[4];

static uint8_t* g_sram = nullptr;
static size_t g_sram_size = 0;

// Audio ring: JS pushes render output, retro_run drains everything pending.
// Accumulating (not overwriting) means a late video frame delivers queued
// audio instead of a 16ms silence pop.
#define JSG_AUDIO_RING_FRAMES 16384
static int16_t g_audio_ring[JSG_AUDIO_RING_FRAMES * 2];
static size_t g_audio_head = 0;  // frames
static size_t g_audio_count = 0; // frames pending
static int16_t g_audio_out[JSG_AUDIO_RING_FRAMES * 2];

static void logmsg(int level, const char* msg) {
  if (g_log) g_log(level, msg);
}

// ─── jsgame_io linked binding (raw N-API) ────────────────────────────────

// present(buffer: ArrayBuffer|TypedArray, width: number, height: number)
// Pixels must already be XRGB8888 little-endian (B,G,R,X byte order).
static napi_value io_present(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 3) return nullptr;

  uint32_t w = 0, h = 0;
  napi_get_value_uint32(env, argv[1], &w);
  napi_get_value_uint32(env, argv[2], &h);
  if (w == 0 || h == 0 || w > 4096 || h > 4096) return nullptr;

  void* data = nullptr;
  size_t len = 0;
  bool is_typedarray = false;
  napi_is_typedarray(env, argv[0], &is_typedarray);
  if (is_typedarray) {
    napi_typedarray_type type;
    napi_value ab;
    size_t offset;
    napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &offset);
  } else {
    napi_get_arraybuffer_info(env, argv[0], &data, &len);
  }
  if (!data || len < (size_t)w * h * 4) return nullptr;

  if ((size_t)w * h > g_fb_cap) {
    free(g_fb);
    g_fb_cap = w * h;
    g_fb = (uint32_t*)malloc((size_t)g_fb_cap * 4);
  }
  // canvas.data() is RGBA byte order; libretro XRGB8888 wants 0x00RRGGBB.
  const uint32_t* src = (const uint32_t*)data;
  const size_t n = (size_t)w * h;
  for (size_t i = 0; i < n; i++) {
    uint32_t v = src[i];  // little-endian: A<<24 | B<<16 | G<<8 | R
    g_fb[i] = ((v & 0xFF) << 16) | (v & 0xFF00) | ((v >> 16) & 0xFF);
  }
  g_fb_w = w;
  g_fb_h = h;
  return nullptr;
}

// log(level: number, msg: string)
static napi_value io_log(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) return nullptr;
  int32_t level = 1;
  napi_get_value_int32(env, argv[0], &level);
  char buf[2048];
  size_t copied = 0;
  napi_get_value_string_utf8(env, argv[1], buf, sizeof(buf), &copied);
  logmsg(level, buf);
  return nullptr;
}

// getPads() -> Int32Array[4 * 8]: buttons, lx, ly, rx, ry, l2, r2, connected
static napi_value io_get_pads(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value ab, ta;
  void* data = nullptr;
  napi_create_arraybuffer(env, 4 * 8 * sizeof(int32_t), &data, &ab);
  int32_t* out = (int32_t*)data;
  for (int i = 0; i < 4; i++) {
    out[i * 8 + 0] = (int32_t)g_pads[i].buttons;
    out[i * 8 + 1] = g_pads[i].lx;
    out[i * 8 + 2] = g_pads[i].ly;
    out[i * 8 + 3] = g_pads[i].rx;
    out[i * 8 + 4] = g_pads[i].ry;
    out[i * 8 + 5] = g_pads[i].l2;
    out[i * 8 + 6] = g_pads[i].r2;
    out[i * 8 + 7] = g_pads[i].connected;
  }
  napi_create_typedarray(env, napi_int32_array, 4 * 8, ab, 0, &ta);
  return ta;
}

// pushAudio(samples: Int16Array) — interleaved stereo for THIS video frame
static napi_value io_push_audio(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return nullptr;
  void* data = nullptr;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t offset;
  napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &offset);
  if (!data || type != napi_int16_array) return nullptr;
  size_t frames = len / 2;
  const int16_t* src = (const int16_t*)data;
  for (size_t f = 0; f < frames && g_audio_count < JSG_AUDIO_RING_FRAMES; f++) {
    size_t slot = (g_audio_head + g_audio_count) % JSG_AUDIO_RING_FRAMES;
    g_audio_ring[slot * 2] = src[f * 2];
    g_audio_ring[slot * 2 + 1] = src[f * 2 + 1];
    g_audio_count++;
  }
  return nullptr;
}

// sramRead() -> Uint8Array copy of the SRAM region (or null)
static napi_value io_sram_read(napi_env env, napi_callback_info info) {
  (void)info;
  if (!g_sram || g_sram_size == 0) return nullptr;
  napi_value ab, ta;
  void* data = nullptr;
  napi_create_arraybuffer(env, g_sram_size, &data, &ab);
  memcpy(data, g_sram, g_sram_size);
  napi_create_typedarray(env, napi_uint8_array, g_sram_size, ab, 0, &ta);
  return ta;
}

// sramWrite(bytes: Uint8Array) — copy into the SRAM region (clamped)
static napi_value io_sram_write(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1 || !g_sram) return nullptr;
  void* data = nullptr;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t offset;
  napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &offset);
  if (data && len > 0) memcpy(g_sram, data, len < g_sram_size ? len : g_sram_size);
  return nullptr;
}

static napi_value io_register(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "present", NAPI_AUTO_LENGTH, io_present, nullptr, &fn);
  napi_set_named_property(env, exports, "present", fn);
  napi_create_function(env, "log", NAPI_AUTO_LENGTH, io_log, nullptr, &fn);
  napi_set_named_property(env, exports, "log", fn);
  napi_create_function(env, "getPads", NAPI_AUTO_LENGTH, io_get_pads, nullptr, &fn);
  napi_set_named_property(env, exports, "getPads", fn);
  napi_create_function(env, "sramRead", NAPI_AUTO_LENGTH, io_sram_read, nullptr, &fn);
  napi_set_named_property(env, exports, "sramRead", fn);
  napi_create_function(env, "sramWrite", NAPI_AUTO_LENGTH, io_sram_write, nullptr, &fn);
  napi_set_named_property(env, exports, "sramWrite", fn);
  napi_create_function(env, "pushAudio", NAPI_AUTO_LENGTH, io_push_audio, nullptr, &fn);
  napi_set_named_property(env, exports, "pushAudio", fn);
  return exports;
}

// ─── V8 / Node init (once per process) ───────────────────────────────────

static int v8_init() {
  if (g_v8_initialized) return 0;

  // vm.SourceTextModule for the game realm's ESM loader — must be visible to
  // node's option parser at process init, so NODE_OPTIONS not exec_args.
  {
    const char* prev = getenv("NODE_OPTIONS");
    std::string opts = prev ? std::string(prev) + " --experimental-vm-modules"
                            : "--experimental-vm-modules";
#ifdef _WIN32
    _putenv_s("NODE_OPTIONS", opts.c_str());
#else
    setenv("NODE_OPTIONS", opts.c_str(), 1);
#endif
  }

  std::vector<std::string> args = {"jsgame"};
  auto result = node::InitializeOncePerProcess(
      args, {node::ProcessInitializationFlags::kNoInitializeV8,
             node::ProcessInitializationFlags::kNoInitializeNodeV8Platform});
  for (const std::string& err : result->errors()) logmsg(3, err.c_str());
  if (result->early_return() != 0) return -1;

  g_platform = node::MultiIsolatePlatform::Create(4).release();
  v8::V8::InitializePlatform(g_platform);
  v8::V8::Initialize();

  std::vector<std::string> errors;
  std::vector<std::string> exec_args;
  g_setup = node::CommonEnvironmentSetup::Create(g_platform, &errors, args,
                                                 exec_args)
                .release();
  if (!g_setup) {
    for (const std::string& err : errors) logmsg(3, err.c_str());
    return -1;
  }

  g_isolate = g_setup->isolate();
  g_env = g_setup->env();
  g_v8_initialized = true;
  return 0;
}

// ─── Public API ──────────────────────────────────────────────────────────

extern "C" int jsg_host_start(const char* content_path, const char* runtime_dir,
                              jsg_log_fn log) {
  g_log = log;
  if (v8_init() != 0) return -1;

  v8::Locker locker(g_isolate);
  v8::Isolate::Scope isolate_scope(g_isolate);
  v8::HandleScope handle_scope(g_isolate);
  v8::Context::Scope context_scope(g_setup->context());

  if (!g_bootstrapped) {
    node::AddLinkedBinding(g_env, "canvas", napi_register_module_v1);
    node::AddLinkedBinding(g_env, "jsgame_io", io_register);
    node::AddLinkedBinding(g_env, "jsgame_gl", jsg_gl_register);
    node::AddLinkedBinding(g_env, "jsgame_audio", jsg_audio_register);

    // Trampoline: stash paths, then load bootstrap.js via createRequire.
    // TODO(embedded runtime): incbin runtime.zip; for now runtime_dir required.
    std::string boot =
        "globalThis.__jsg_paths = { content: " +
        std::string("JSON.parse(process.env.JSGAME_ARGS_JSON).content, runtime: "
                    "JSON.parse(process.env.JSGAME_ARGS_JSON).runtime };") +
        "const { createRequire } = require('node:module');"
        "const __req = createRequire(globalThis.__jsg_paths.runtime + '/');"
        "__req('./bootstrap.js');";

    std::string args_json = std::string("{\"content\":\"") + (content_path ? content_path : "") +
                            "\",\"runtime\":\"" + (runtime_dir ? runtime_dir : "") + "\"}";
#ifdef _WIN32
    _putenv_s("JSGAME_ARGS_JSON", args_json.c_str());
#else
    setenv("JSGAME_ARGS_JSON", args_json.c_str(), 1);
#endif

    auto loadenv_ret = node::LoadEnvironment(g_env, boot.c_str());
    if (loadenv_ret.IsEmpty()) {
      logmsg(3, "jsgame: LoadEnvironment failed (bootstrap threw)");
      return -1;
    }
    uv_run(g_setup->event_loop(), UV_RUN_NOWAIT);
    g_bootstrapped = true;
    logmsg(1, "jsgame: runtime bootstrapped");
    return 0;
  }

  // Subsequent content load in the same process: call the JS hook.
  v8::Local<v8::Context> ctx = g_setup->context();
  v8::Local<v8::Value> hook;
  if (ctx->Global()
          ->Get(ctx, v8::String::NewFromUtf8Literal(g_isolate, "__jsg_start"))
          .ToLocal(&hook) &&
      hook->IsFunction()) {
    v8::Local<v8::Value> arg =
        v8::String::NewFromUtf8(g_isolate, content_path ? content_path : "")
            .ToLocalChecked();
    v8::TryCatch trycatch(g_isolate);
    (void)hook.As<v8::Function>()->Call(ctx, ctx->Global(), 1, &arg);
    if (trycatch.HasCaught()) {
      v8::String::Utf8Value msg(g_isolate, trycatch.Exception());
      logmsg(3, *msg ? *msg : "jsgame: __jsg_start threw");
      return -1;
    }
  }
  return 0;
}

extern "C" int jsg_host_frame(void) {
  if (!g_bootstrapped) return -1;

  v8::Locker locker(g_isolate);
  v8::Isolate::Scope isolate_scope(g_isolate);
  v8::HandleScope handle_scope(g_isolate);
  v8::Local<v8::Context> ctx = g_setup->context();
  v8::Context::Scope context_scope(ctx);

  v8::Local<v8::Value> fn;
  if (ctx->Global()
          ->Get(ctx, v8::String::NewFromUtf8Literal(g_isolate, "__jsg_frame"))
          .ToLocal(&fn) &&
      fn->IsFunction()) {
    v8::TryCatch trycatch(g_isolate);
    (void)fn.As<v8::Function>()->Call(ctx, ctx->Global(), 0, nullptr);
    if (trycatch.HasCaught()) {
      v8::String::Utf8Value msg(g_isolate, trycatch.Exception());
      logmsg(3, *msg ? *msg : "jsgame: __jsg_frame threw");
    }
  }

  // Full embedder pump: libuv callbacks, V8 platform tasks (ESM loading, WASM
  // compile), then microtasks. uv_run alone leaves import() pending forever.
  uv_run(g_setup->event_loop(), UV_RUN_NOWAIT);
  g_platform->DrainTasks(g_isolate);
  g_isolate->PerformMicrotaskCheckpoint();
  return 0;
}

extern "C" const uint32_t* jsg_host_framebuffer(unsigned* width, unsigned* height) {
  if (!g_fb || g_fb_w == 0) return nullptr;
  *width = g_fb_w;
  *height = g_fb_h;
  return g_fb;
}

extern "C" void jsg_host_set_pads(const jsg_pad_t pads[4]) {
  memcpy(g_pads, pads, sizeof(g_pads));
}

extern "C" void jsg_host_set_sram(uint8_t* sram, size_t size) {
  g_sram = sram;
  g_sram_size = size;
}

extern "C" size_t jsg_host_audio(const int16_t** samples) {
  // Deliver AT MOST one tick (800 frames) per retro_run — this delivery is
  // what lets the frontend's audio_sync throttle us. Draining the whole ring
  // after a fast-forward burst block-stalls the frontend for hundreds of ms
  // and sets up a starve/burst oscillation (the "rattling machine gun").
  const size_t TICK = 800;
  size_t frames = g_audio_count < TICK ? g_audio_count : TICK;
  for (size_t f = 0; f < frames; f++) {
    size_t slot = (g_audio_head + f) % JSG_AUDIO_RING_FRAMES;
    g_audio_out[f * 2] = g_audio_ring[slot * 2];
    g_audio_out[f * 2 + 1] = g_audio_ring[slot * 2 + 1];
  }
  g_audio_head = (g_audio_head + frames) % JSG_AUDIO_RING_FRAMES;
  g_audio_count -= frames;
  // Bound backlog to ~3 ticks: drop oldest so latency can't creep after bursts.
  while (g_audio_count > TICK * 3) {
    g_audio_head = (g_audio_head + TICK) % JSG_AUDIO_RING_FRAMES;
    g_audio_count -= TICK;
  }
  *samples = g_audio_out;
  return frames;
}

extern "C" void jsg_host_stop(void) {
  // V8/platform/env stay alive (cannot re-init V8 in-process; matches
  // wasmcart-libretro behavior). Game-realm teardown happens JS-side.
  if (!g_bootstrapped || !g_isolate) return;
  v8::Locker locker(g_isolate);
  v8::Isolate::Scope isolate_scope(g_isolate);
  v8::HandleScope handle_scope(g_isolate);
  v8::Local<v8::Context> ctx = g_setup->context();
  v8::Context::Scope context_scope(ctx);
  v8::Local<v8::Value> fn;
  if (ctx->Global()
          ->Get(ctx, v8::String::NewFromUtf8Literal(g_isolate, "__jsg_stop"))
          .ToLocal(&fn) &&
      fn->IsFunction()) {
    v8::TryCatch trycatch(g_isolate);
    (void)fn.As<v8::Function>()->Call(ctx, ctx->Global(), 0, nullptr);
  }
}

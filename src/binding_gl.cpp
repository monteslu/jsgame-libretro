// binding_gl.cpp — jsgame_gl registration shim.
// The full GLES 3.0 surface lives in src/gl/binding_gl_full.cpp (ported from
// native-gles, node-addon-api based). This bridges our raw node_api.h
// registration to that node-addon-api RegisterFullGL.
#include <napi.h>
#include "node_api.h"
#include "node_host.h"

Napi::Object RegisterFullGL(Napi::Env env, Napi::Object exports);

// GL proc table from the frontend (libretro hw render). gl_bindings.cpp calls
// GLES3 entry points directly against the linked libGLESv2, but we still record
// readiness + the default framebuffer for the realm's present/FBO logic.
static void* g_get_proc = nullptr;
static uintptr_t g_default_fbo = 0;

extern "C" void jsg_gl_set_procs(void* get_proc, uintptr_t default_fbo) {
  g_get_proc = get_proc;
  g_default_fbo = default_fbo;
}
extern "C" bool jsg_gl_ready(void) { return g_get_proc != nullptr; }
extern "C" uintptr_t jsg_gl_default_fbo(void) { return g_default_fbo; }

// default-framebuffer accessor for the realm (canvas binds null -> this FBO)
static napi_value jsg_gl_default_fb(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value v;
  napi_create_uint32(env, (uint32_t)g_default_fbo, &v);
  return v;
}

static napi_value jsg_gl_is_ready(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value v;
  napi_get_boolean(env, g_get_proc != nullptr, &v);
  return v;
}

extern "C" napi_value jsg_gl_register(napi_env env, napi_value exports) {
  Napi::Env napiEnv(env);
  Napi::Object obj(env, exports);
  RegisterFullGL(napiEnv, obj);
  // extra: expose the frontend's default framebuffer id
  napi_value fn;
  napi_create_function(env, "jsgDefaultFramebuffer", NAPI_AUTO_LENGTH,
                       jsg_gl_default_fb, nullptr, &fn);
  napi_set_named_property(env, exports, "jsgDefaultFramebuffer", fn);
  napi_value rfn;
  napi_create_function(env, "jsgReady", NAPI_AUTO_LENGTH, jsg_gl_is_ready, nullptr, &rfn);
  napi_set_named_property(env, exports, "jsgReady", rfn);
  return exports;
}

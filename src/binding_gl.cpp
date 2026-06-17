// binding_gl.cpp — jsgame_gl registration shim.
// The full GLES 3.0 surface lives in src/gl/binding_gl_full.cpp (ported from
// native-gles, node-addon-api based). This bridges our raw node_api.h
// registration to that node-addon-api RegisterFullGL.
#include <napi.h>
#include <GLES3/gl3.h>
#include "gl/gl_procs.h"  // redirects glXxx() -> p_glXxx loaded from RA get_proc_address
#include <cstdio>
#include "node_api.h"
#include "node_host.h"

// gl_blit.c: draw a texture into an FBO with optional R<->B swizzle (swap).
extern "C" void jsg_gl_blit_texture_swap(unsigned tex_id, int w, int h,
                                         unsigned fbo, int swap);
// Forward decl (defined later in this file): copy an FBO's color into a private
// sampleable texture and return its id.
extern "C" unsigned jsg_gl_copy_fbo_to_texture(unsigned src_fbo, int w, int h);

Napi::Object RegisterFullGL(Napi::Env env, Napi::Object exports);

// GL proc table from the frontend (libretro hw render). gl_bindings.cpp calls
// GLES3 entry points directly against the linked libGLESv2, but we still record
// readiness + the default framebuffer for the realm's present/FBO logic.
static void* g_get_proc = nullptr;
static uintptr_t g_default_fbo = 0;
// RetroArch's default framebuffer id can CHANGE every frame, so we must call
// get_current_framebuffer() live rather than cache one value. Without this,
// bindFramebuffer(null) (e.g. Three.js rendering to screen) targets a stale FBO
// and nothing reaches the display.
typedef uintptr_t (*get_cur_fb_fn)(void);
static get_cur_fb_fn g_get_cur_fb = nullptr;

extern "C" void jsg_gl_set_procs(void* get_proc, uintptr_t default_fbo) {
  g_get_proc = get_proc;
  g_default_fbo = default_fbo;
  // Load every GL entry point from the frontend's get_proc_address. This is what
  // makes the binding's glXxx() calls resolve to RetroArch's GL context (like
  // Flycast/mupen) instead of a linked libGLESv2 — so the core links NO GL lib.
  jsg_gl_procs_load(get_proc);
}
extern "C" void jsg_gl_set_fb_getter(void* get_cur_fb) {
  g_get_cur_fb = (get_cur_fb_fn)get_cur_fb;
}
extern "C" bool jsg_gl_ready(void) { return g_get_proc != nullptr; }


static uintptr_t jsg_gl_live_fbo(void) {
  return g_get_cur_fb ? g_get_cur_fb() : g_default_fbo;
}
extern "C" uintptr_t jsg_gl_default_fbo(void) { return jsg_gl_live_fbo(); }

// default-framebuffer accessor for the realm (canvas binds null -> this FBO).
// Re-queried each call so a per-frame FBO change is honored.
static napi_value jsg_gl_default_fb(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value v;
  napi_create_uint32(env, (uint32_t)jsg_gl_live_fbo(), &v);
  return v;
}

static napi_value jsg_gl_is_ready(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value v;
  napi_get_boolean(env, g_get_proc != nullptr, &v);
  return v;
}

// The GL texture id of COLOR_ATTACHMENT0 on a given FBO (0 if the attachment is
// a renderbuffer, not a texture, or none). Used by the GPU-composite path:
// Skia borrows this texture to draw the WebGL scene into the 2D GPU surface
// (GPU->GPU, no readback). Restores the previously-bound draw FBO.
extern "C" unsigned jsg_gl_fbo_color_texture(unsigned fbo) {
  GLint prevFbo = 0;
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevFbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)fbo);
  GLint objType = 0, objName = 0;
  glGetFramebufferAttachmentParameteriv(
      GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
      GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE, &objType);
  if (objType == GL_TEXTURE) {
    glGetFramebufferAttachmentParameteriv(
        GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
        GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME, &objName);
  }
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevFbo);
  return objType == GL_TEXTURE ? (unsigned)objName : 0;
}

// Blit the given FBO's color buffer into a private single-sample GL_TEXTURE_2D
// (created/resized on demand) and return its id. This gives Skia a clean,
// directly-sampleable copy of the WebGL scene — avoids feedback loops and any
// driver quirk sampling RA's own FBO attachment. Still GPU->GPU (a framebuffer
// blit), NO CPU readback. Restores the prior FBO bindings.
static GLuint g_scene_tex = 0, g_scene_fbo = 0;
static int g_scene_w = 0, g_scene_h = 0;
extern "C" unsigned jsg_gl_copy_fbo_to_texture(unsigned src_fbo, int w, int h) {
  if (w <= 0 || h <= 0) return 0;
  GLint prevRead = 0, prevDraw = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
  if (g_scene_tex == 0) {
    glGenTextures(1, &g_scene_tex);
    glGenFramebuffers(1, &g_scene_fbo);
  }
  if (w != g_scene_w || h != g_scene_h) {
    glBindTexture(GL_TEXTURE_2D, g_scene_tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glBindFramebuffer(GL_FRAMEBUFFER, g_scene_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_scene_tex, 0);
    g_scene_w = w; g_scene_h = h;
  }
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)src_fbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_scene_fbo);
  // V-flip on copy: the present quad also V-flips, and scene_tex is presented
  // directly — flip here so copy-flip + present-flip = upright. (The HUD Skia
  // surface is top-left already, so the present quad's flip is correct for it.)
  glBlitFramebuffer(0, 0, w, h, 0, h, w, 0, GL_COLOR_BUFFER_BIT, GL_NEAREST);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
  return g_scene_tex;
}

// Blit one FBO's color into a destination GL texture (dst_tex), by wrapping the
// destination texture in a scratch FBO and glBlitFramebuffer. Used to push the
// WebGL scene straight into a Skia GPU surface's backing texture (GPU->GPU),
// sidestepping Skia's broken drawImageRect-of-borrowed-texture path. The HUD is
// then drawn on top by Skia into the same surface. Restores prior FBO bindings.
static GLuint g_dst_fbo = 0;
extern "C" void jsg_gl_blit_fbo_to_texture(unsigned src_fbo, unsigned dst_tex,
                                           int w, int h) {
  if (!dst_tex || w <= 0 || h <= 0) return;
  // Step 1: copy the WebGL scene FBO (RGBA) into our private sampleable texture.
  unsigned scene_tex = jsg_gl_copy_fbo_to_texture(src_fbo, w, h);
  if (!scene_tex) return;
  // Step 2: draw it into the Skia surface's backing texture (via its FBO), no
  // swizzle — keep the scene in RGBA. gl_blit's V-flipped quad corrects the GL
  // bottom-up -> top-left orientation.
  GLint prevRead = 0, prevDraw = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
  if (g_dst_fbo == 0) glGenFramebuffers(1, &g_dst_fbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, g_dst_fbo);
  glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                         GL_TEXTURE_2D, (GLuint)dst_tex, 0);
  jsg_gl_blit_texture_swap(scene_tex, w, h, g_dst_fbo, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
}

// DEBUG: read one pixel from a texture (via a scratch FBO) and print its RGBA
// bytes — tells the actual byte order Skia/GL wrote, to resolve channel swaps.
extern "C" void jsg_gl_probe_texel(unsigned tex, int x, int y) {
  static int done = 0;
  if (done || !tex) return;
  done = 1;
  GLint prevRead = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
  static GLuint probeFbo = 0;
  if (!probeFbo) glGenFramebuffers(1, &probeFbo);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, probeFbo);
  glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                         GL_TEXTURE_2D, (GLuint)tex, 0);
  unsigned char px[4] = {0,0,0,0};
  glReadPixels(x, y, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
  fprintf(stderr, "[gl_probe] texel(%d,%d) RGBA bytes = %u %u %u %u\n",
          x, y, px[0], px[1], px[2], px[3]);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
}

// JS accessor: jsgBlitToTexture(srcFbo, dstTex, w, h)
static napi_value jsg_gl_blit_to_texture(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t srcFbo = 0, dstTex = 0, w = 0, h = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &srcFbo);
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &dstTex);
  if (argc >= 3) napi_get_value_uint32(env, argv[2], &w);
  if (argc >= 4) napi_get_value_uint32(env, argv[3], &h);
  jsg_gl_blit_fbo_to_texture(srcFbo, dstTex, (int)w, (int)h);
  return nullptr;
}

// JS accessor: jsgSceneTexture(srcFbo, w, h) -> a private texture holding a copy.
static napi_value jsg_gl_scene_texture(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t fbo = 0, w = 0, h = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &fbo);
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &w);
  if (argc >= 3) napi_get_value_uint32(env, argv[2], &h);
  napi_value v;
  napi_create_uint32(env, jsg_gl_copy_fbo_to_texture(fbo, (int)w, (int)h), &v);
  return v;
}

// JS accessor: jsgGetProcAddress() -> the frontend's GL get_proc_address pointer
// as a decimal STRING (JS numbers can't hold a 64-bit pointer). Skia's
// GrGLMakeAssembledInterface uses it to load every GL entry point.
static napi_value jsg_gl_get_proc(napi_env env, napi_callback_info info) {
  (void)info;
  char buf[24];
  snprintf(buf, sizeof(buf), "%llu", (unsigned long long)(uintptr_t)g_get_proc);
  napi_value v;
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &v);
  return v;
}

// JS accessor: jsgFboColorTexture(fboId) -> texture id (or 0).
static napi_value jsg_gl_fbo_color_tex(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t fbo = 0;
  if (argc >= 1) napi_get_value_uint32(env, argv[0], &fbo);
  napi_value v;
  napi_create_uint32(env, jsg_gl_fbo_color_texture(fbo), &v);
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
  napi_value tfn;
  napi_create_function(env, "jsgFboColorTexture", NAPI_AUTO_LENGTH,
                       jsg_gl_fbo_color_tex, nullptr, &tfn);
  napi_set_named_property(env, exports, "jsgFboColorTexture", tfn);
  napi_value pfn;
  napi_create_function(env, "jsgGetProcAddress", NAPI_AUTO_LENGTH,
                       jsg_gl_get_proc, nullptr, &pfn);
  napi_set_named_property(env, exports, "jsgGetProcAddress", pfn);
  napi_value sfn;
  napi_create_function(env, "jsgSceneTexture", NAPI_AUTO_LENGTH,
                       jsg_gl_scene_texture, nullptr, &sfn);
  napi_set_named_property(env, exports, "jsgSceneTexture", sfn);
  napi_value bfn;
  napi_create_function(env, "jsgBlitToTexture", NAPI_AUTO_LENGTH,
                       jsg_gl_blit_to_texture, nullptr, &bfn);
  napi_set_named_property(env, exports, "jsgBlitToTexture", bfn);
  return exports;
}

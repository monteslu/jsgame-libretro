// binding_gl.cpp — jsgame_gl linked binding: minimal WebGL2-shaped surface
// over the frontend's GL proc table (S5 spike set — enough for textured/
// shaded triangles; Phase 3 generates the full WebGL2 surface).
#include <stdint.h>
#include <string.h>

#include <string>

#include "node_api.h"
#include "node_host.h"

typedef void (*glfn)(void);
typedef glfn (*get_proc_fn)(const char*);
static get_proc_fn g_get_proc = nullptr;

typedef unsigned GLenum_;
typedef unsigned GLuint_;
typedef int GLint_;
typedef int GLsizei_;
typedef float GLfloat_;
typedef unsigned char GLboolean_;
typedef intptr_t GLsizeiptr_;

static GLuint_ (*p_glCreateShader)(GLenum_);
static void (*p_glShaderSource)(GLuint_, GLsizei_, const char* const*, const GLint_*);
static void (*p_glCompileShader)(GLuint_);
static void (*p_glGetShaderiv)(GLuint_, GLenum_, GLint_*);
static void (*p_glGetShaderInfoLog)(GLuint_, GLsizei_, GLsizei_*, char*);
static GLuint_ (*p_glCreateProgram)(void);
static void (*p_glAttachShader)(GLuint_, GLuint_);
static void (*p_glLinkProgram)(GLuint_);
static void (*p_glGetProgramiv)(GLuint_, GLenum_, GLint_*);
static void (*p_glUseProgram)(GLuint_);
static void (*p_glGenBuffers)(GLsizei_, GLuint_*);
static void (*p_glBindBuffer)(GLenum_, GLuint_);
static void (*p_glBufferData)(GLenum_, GLsizeiptr_, const void*, GLenum_);
static GLint_ (*p_glGetAttribLocation)(GLuint_, const char*);
static GLint_ (*p_glGetUniformLocation)(GLuint_, const char*);
static void (*p_glUniform4f)(GLint_, GLfloat_, GLfloat_, GLfloat_, GLfloat_);
static void (*p_glEnableVertexAttribArray)(GLuint_);
static void (*p_glVertexAttribPointer)(GLuint_, GLint_, GLenum_, GLboolean_, GLsizei_, const void*);
static void (*p_glGenVertexArrays)(GLsizei_, GLuint_*);
static void (*p_glBindVertexArray)(GLuint_);
static void (*p_glDrawArrays)(GLenum_, GLint_, GLsizei_);
static void (*p_glClearColor)(GLfloat_, GLfloat_, GLfloat_, GLfloat_);
static void (*p_glClear)(unsigned);
static void (*p_glViewport)(GLint_, GLint_, GLsizei_, GLsizei_);
static GLenum_ (*p_glGetError)(void);
static void (*p_glBindFramebuffer)(GLenum_, GLuint_);

static uintptr_t g_default_fbo = 0;

extern "C" void jsg_gl_set_procs(void* get_proc, uintptr_t default_fbo) {
  g_get_proc = (get_proc_fn)get_proc;
  g_default_fbo = default_fbo;
#define R(name) p_##name = (decltype(p_##name))g_get_proc(#name)
  R(glCreateShader); R(glShaderSource); R(glCompileShader); R(glGetShaderiv);
  R(glGetShaderInfoLog); R(glCreateProgram); R(glAttachShader); R(glLinkProgram);
  R(glGetProgramiv); R(glUseProgram); R(glGenBuffers); R(glBindBuffer);
  R(glBufferData); R(glGetAttribLocation); R(glGetUniformLocation);
  R(glUniform4f); R(glEnableVertexAttribArray); R(glVertexAttribPointer);
  R(glGenVertexArrays); R(glBindVertexArray); R(glDrawArrays); R(glClearColor);
  R(glClear); R(glViewport); R(glGetError); R(glBindFramebuffer);
#undef R
}

extern "C" bool jsg_gl_ready(void) { return g_get_proc != nullptr; }

// ── N-API helpers ────────────────────────────────────────────────────────
static double argd(napi_env env, napi_value v) {
  double d = 0;
  napi_get_value_double(env, v, &d);
  return d;
}
static std::string args(napi_env env, napi_value v) {
  size_t len = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  std::string s(len, 0);
  napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  return s;
}
#define ARGS(n)                                              \
  size_t argc = (n);                                         \
  napi_value argv[(n) > 0 ? (n) : 1];                        \
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr)
#define NUM(i) argd(env, argv[i])
static napi_value mknum(napi_env env, double d) {
  napi_value v;
  napi_create_double(env, d, &v);
  return v;
}

#define FN(name) static napi_value name(napi_env env, napi_callback_info info)

FN(js_createShader) { ARGS(1); return mknum(env, p_glCreateShader((GLenum_)NUM(0))); }
FN(js_shaderSource) {
  ARGS(2);
  std::string src = args(env, argv[1]);
  const char* p = src.c_str();
  GLint_ len = (GLint_)src.size();
  p_glShaderSource((GLuint_)NUM(0), 1, &p, &len);
  return nullptr;
}
FN(js_compileShader) { ARGS(1); p_glCompileShader((GLuint_)NUM(0)); return nullptr; }
FN(js_getShaderParameter) {
  ARGS(2);
  GLint_ out = 0;
  p_glGetShaderiv((GLuint_)NUM(0), (GLenum_)NUM(1), &out);
  return mknum(env, out);
}
FN(js_getShaderInfoLog) {
  ARGS(1);
  char buf[2048];
  GLsizei_ len = 0;
  p_glGetShaderInfoLog((GLuint_)NUM(0), sizeof(buf), &len, buf);
  napi_value v;
  napi_create_string_utf8(env, buf, len, &v);
  return v;
}
FN(js_createProgram) { return mknum(env, p_glCreateProgram()); }
FN(js_attachShader) { ARGS(2); p_glAttachShader((GLuint_)NUM(0), (GLuint_)NUM(1)); return nullptr; }
FN(js_linkProgram) { ARGS(1); p_glLinkProgram((GLuint_)NUM(0)); return nullptr; }
FN(js_getProgramParameter) {
  ARGS(2);
  GLint_ out = 0;
  p_glGetProgramiv((GLuint_)NUM(0), (GLenum_)NUM(1), &out);
  return mknum(env, out);
}
FN(js_useProgram) { ARGS(1); p_glUseProgram((GLuint_)NUM(0)); return nullptr; }
FN(js_createBuffer) {
  GLuint_ b = 0;
  p_glGenBuffers(1, &b);
  return mknum(env, b);
}
FN(js_bindBuffer) { ARGS(2); p_glBindBuffer((GLenum_)NUM(0), (GLuint_)NUM(1)); return nullptr; }
FN(js_bufferData) {
  ARGS(3);
  void* data = nullptr;
  size_t len = 0;
  napi_typedarray_type t;
  napi_value ab;
  size_t off;
  napi_get_typedarray_info(env, argv[1], &t, &len, &data, &ab, &off);
  size_t bytes = len;
  if (t == napi_float32_array || t == napi_int32_array || t == napi_uint32_array) bytes = len * 4;
  else if (t == napi_int16_array || t == napi_uint16_array) bytes = len * 2;
  p_glBufferData((GLenum_)NUM(0), (GLsizeiptr_)bytes, data, (GLenum_)NUM(2));
  return nullptr;
}
FN(js_getAttribLocation) {
  ARGS(2);
  return mknum(env, p_glGetAttribLocation((GLuint_)NUM(0), args(env, argv[1]).c_str()));
}
FN(js_getUniformLocation) {
  ARGS(2);
  return mknum(env, p_glGetUniformLocation((GLuint_)NUM(0), args(env, argv[1]).c_str()));
}
FN(js_uniform4f) {
  ARGS(5);
  p_glUniform4f((GLint_)NUM(0), NUM(1), NUM(2), NUM(3), NUM(4));
  return nullptr;
}
FN(js_enableVertexAttribArray) { ARGS(1); p_glEnableVertexAttribArray((GLuint_)NUM(0)); return nullptr; }
FN(js_vertexAttribPointer) {
  ARGS(6);
  p_glVertexAttribPointer((GLuint_)NUM(0), (GLint_)NUM(1), (GLenum_)NUM(2),
                          (GLboolean_)NUM(3), (GLsizei_)NUM(4),
                          (const void*)(uintptr_t)NUM(5));
  return nullptr;
}
FN(js_createVertexArray) {
  GLuint_ v = 0;
  p_glGenVertexArrays(1, &v);
  return mknum(env, v);
}
FN(js_bindVertexArray) { ARGS(1); p_glBindVertexArray((GLuint_)NUM(0)); return nullptr; }
FN(js_drawArrays) { ARGS(3); p_glDrawArrays((GLenum_)NUM(0), (GLint_)NUM(1), (GLsizei_)NUM(2)); return nullptr; }
FN(js_clearColor) { ARGS(4); p_glClearColor(NUM(0), NUM(1), NUM(2), NUM(3)); return nullptr; }
FN(js_clear) { ARGS(1); p_glClear((unsigned)NUM(0)); return nullptr; }
FN(js_viewport) { ARGS(4); p_glViewport((GLint_)NUM(0), (GLint_)NUM(1), (GLsizei_)NUM(2), (GLsizei_)NUM(3)); return nullptr; }
FN(js_getError) { return mknum(env, p_glGetError ? p_glGetError() : 0); }
FN(js_ready) {
  napi_value v;
  napi_get_boolean(env, g_get_proc != nullptr, &v);
  return v;
}
FN(js_bindDefaultFramebuffer) {
  if (p_glBindFramebuffer) p_glBindFramebuffer(0x8D40 /*GL_FRAMEBUFFER*/, (GLuint_)g_default_fbo);
  return nullptr;
}

extern "C" napi_value jsg_gl_register(napi_env env, napi_value exports) {
  struct {
    const char* name;
    napi_callback fn;
  } fns[] = {
      {"ready", js_ready}, {"createShader", js_createShader},
      {"shaderSource", js_shaderSource}, {"compileShader", js_compileShader},
      {"getShaderParameter", js_getShaderParameter},
      {"getShaderInfoLog", js_getShaderInfoLog},
      {"createProgram", js_createProgram}, {"attachShader", js_attachShader},
      {"linkProgram", js_linkProgram}, {"getProgramParameter", js_getProgramParameter},
      {"useProgram", js_useProgram}, {"createBuffer", js_createBuffer},
      {"bindBuffer", js_bindBuffer}, {"bufferData", js_bufferData},
      {"getAttribLocation", js_getAttribLocation},
      {"getUniformLocation", js_getUniformLocation}, {"uniform4f", js_uniform4f},
      {"enableVertexAttribArray", js_enableVertexAttribArray},
      {"vertexAttribPointer", js_vertexAttribPointer},
      {"createVertexArray", js_createVertexArray},
      {"bindVertexArray", js_bindVertexArray}, {"drawArrays", js_drawArrays},
      {"clearColor", js_clearColor}, {"clear", js_clear},
      {"viewport", js_viewport}, {"getError", js_getError},
      {"bindDefaultFramebuffer", js_bindDefaultFramebuffer},
  };
  for (auto& f : fns) {
    napi_value fn;
    napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &fn);
    napi_set_named_property(env, exports, f.name, fn);
  }
  return exports;
}

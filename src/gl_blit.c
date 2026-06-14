// gl_blit.c — upload a software RGBA framebuffer as a GL texture and draw it
// as a fullscreen quad into the frontend's FBO. Needed when a game uses WebGL
// (so the core is in hardware-render mode and RetroArch ignores software
// video_cb frames), but composites its final image onto a 2D display canvas
// (e.g. a Three.js scene + a 2D HUD). This presents that 2D image in HW mode.
//
// Loads all GL entry points dynamically from the frontend's get_proc_address,
// so it works against desktop GL core and GLES3 alike (GLSL is version-tagged
// per context type).
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>

// ── minimal GL typedefs (avoid pulling a full GL header / version conflicts) ──
typedef unsigned int  GLenum;
typedef unsigned char GLboolean;
typedef unsigned int  GLbitfield;
typedef int           GLint;
typedef int           GLsizei;
typedef unsigned int  GLuint;
typedef float         GLfloat;
typedef char          GLchar;
typedef ptrdiff_t     GLintptr;
typedef ptrdiff_t     GLsizeiptr;

#define GL_TEXTURE_2D            0x0DE1
#define GL_TEXTURE_MIN_FILTER    0x2801
#define GL_TEXTURE_MAG_FILTER    0x2800
#define GL_TEXTURE_WRAP_S        0x2802
#define GL_TEXTURE_WRAP_T        0x2803
#define GL_LINEAR                0x2601
#define GL_CLAMP_TO_EDGE         0x812F
#define GL_RGBA                  0x1908
#define GL_BGRA                  0x80E1
#define GL_UNSIGNED_BYTE         0x1401
#define GL_TEXTURE0              0x84C0
#define GL_ARRAY_BUFFER          0x8892
#define GL_STATIC_DRAW           0x88E4
#define GL_FRAGMENT_SHADER       0x8B30
#define GL_VERTEX_SHADER         0x8B31
#define GL_COMPILE_STATUS        0x8B81
#define GL_LINK_STATUS           0x8B82
#define GL_FLOAT                 0x1406
#define GL_FALSE                 0
#define GL_TRUE                  1
#define GL_TRIANGLE_STRIP        0x0005
#define GL_COLOR_BUFFER_BIT      0x00004000
#define GL_BLEND                 0x0BE2
#define GL_DEPTH_TEST            0x0B71
#define GL_CULL_FACE             0x0B44
#define GL_UNPACK_ALIGNMENT      0x0CF5
#define GL_UNPACK_ROW_LENGTH     0x0CF2
#define GL_TEXTURE_BINDING_2D    0x8069

typedef void* (*proc_loader_t)(const char*);

// GL function pointers we use
static void   (*p_glGenTextures)(GLsizei, GLuint*);
static void   (*p_glBindTexture)(GLenum, GLuint);
static void   (*p_glTexParameteri)(GLenum, GLenum, GLint);
static void   (*p_glTexImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*);
static void   (*p_glTexSubImage2D)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void*);
static void   (*p_glPixelStorei)(GLenum, GLint);
static void   (*p_glActiveTexture)(GLenum);
static GLuint (*p_glCreateShader)(GLenum);
static void   (*p_glShaderSource)(GLuint, GLsizei, const GLchar* const*, const GLint*);
static void   (*p_glCompileShader)(GLuint);
static void   (*p_glGetShaderiv)(GLuint, GLenum, GLint*);
static void   (*p_glGetShaderInfoLog)(GLuint, GLsizei, GLsizei*, GLchar*);
static GLuint (*p_glCreateProgram)(void);
static void   (*p_glAttachShader)(GLuint, GLuint);
static void   (*p_glLinkProgram)(GLuint);
static void   (*p_glGetProgramiv)(GLuint, GLenum, GLint*);
static void   (*p_glUseProgram)(GLuint);
static GLint  (*p_glGetUniformLocation)(GLuint, const GLchar*);
static GLint  (*p_glGetAttribLocation)(GLuint, const GLchar*);
static void   (*p_glUniform1i)(GLint, GLint);
static void   (*p_glGenBuffers)(GLsizei, GLuint*);
static void   (*p_glBindBuffer)(GLenum, GLuint);
static void   (*p_glBufferData)(GLenum, GLsizeiptr, const void*, GLenum);
static void   (*p_glEnableVertexAttribArray)(GLuint);
static void   (*p_glVertexAttribPointer)(GLuint, GLint, GLenum, GLboolean, GLsizei, const void*);
static void   (*p_glGenVertexArrays)(GLsizei, GLuint*);
static void   (*p_glBindVertexArray)(GLuint);
static void   (*p_glViewport)(GLint, GLint, GLsizei, GLsizei);
static void   (*p_glDisable)(GLenum);
static void   (*p_glClear)(GLbitfield);
static void   (*p_glClearColor)(GLfloat, GLfloat, GLfloat, GLfloat);
static void   (*p_glDrawArrays)(GLenum, GLint, GLsizei);
static void   (*p_glBindFramebuffer)(GLenum, GLuint);

static int    g_ready = 0;
static int    g_is_gles = 0;
static GLuint g_tex = 0, g_prog = 0, g_vao = 0, g_vbo = 0;
static GLsizei g_tw = 0, g_th = 0;
static GLint  g_aPos = -1, g_aUV = -1;

static GLuint compile(GLenum type, const char* src) {
  GLuint s = p_glCreateShader(type);
  p_glShaderSource(s, 1, &src, NULL);
  p_glCompileShader(s);
  GLint ok = 0; p_glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512]; p_glGetShaderInfoLog(s, sizeof(log), NULL, log);
    fprintf(stderr, "[gl_blit] shader compile failed: %s\n", log);
  }
  return s;
}

// Fullscreen-quad: pos (clip space) + uv. Two triangles via TRIANGLE_STRIP.
// Flip V so the (top-down) software framebuffer shows upright.
static const GLfloat QUAD[] = {
  // x     y     u    v
  -1.f, -1.f,  0.f, 1.f,
   1.f, -1.f,  1.f, 1.f,
  -1.f,  1.f,  0.f, 0.f,
   1.f,  1.f,  1.f, 0.f,
};

// is_gles: pick the matching GLSL dialect (300 es vs 330 core)
int jsg_gl_blit_init(void* get_proc, int is_gles) {
  if (g_ready) return 1;
  proc_loader_t L = (proc_loader_t)get_proc;
  if (!L) return 0;
  g_is_gles = is_gles;
  #define LD(name) p_##name = (void*)L(#name); if (!p_##name) { fprintf(stderr,"[gl_blit] missing %s\n", #name); return 0; }
  LD(glGenTextures) LD(glBindTexture) LD(glTexParameteri) LD(glTexImage2D) LD(glTexSubImage2D)
  LD(glPixelStorei) LD(glActiveTexture) LD(glCreateShader) LD(glShaderSource) LD(glCompileShader)
  LD(glGetShaderiv) LD(glGetShaderInfoLog) LD(glCreateProgram) LD(glAttachShader) LD(glLinkProgram)
  LD(glGetProgramiv) LD(glUseProgram) LD(glGetUniformLocation) LD(glGetAttribLocation) LD(glUniform1i)
  LD(glGenBuffers) LD(glBindBuffer) LD(glBufferData) LD(glEnableVertexAttribArray) LD(glVertexAttribPointer)
  LD(glViewport) LD(glDisable) LD(glClear) LD(glClearColor) LD(glDrawArrays) LD(glBindFramebuffer)
  #undef LD
  // VAO is optional (core profile needs it); load but don't fail if absent
  p_glGenVertexArrays = (void*)L("glGenVertexArrays");
  p_glBindVertexArray = (void*)L("glBindVertexArray");

  const char* vsrc_gles =
    "#version 300 es\nin vec2 aPos;in vec2 aUV;out vec2 vUV;"
    "void main(){vUV=aUV;gl_Position=vec4(aPos,0.0,1.0);}";
  const char* fsrc_gles =
    "#version 300 es\nprecision mediump float;in vec2 vUV;uniform sampler2D tex;out vec4 o;"
    "void main(){o=texture(tex,vUV);}";
  const char* vsrc_core =
    "#version 330 core\nin vec2 aPos;in vec2 aUV;out vec2 vUV;"
    "void main(){vUV=aUV;gl_Position=vec4(aPos,0.0,1.0);}";
  const char* fsrc_core =
    "#version 330 core\nin vec2 vUV;uniform sampler2D tex;out vec4 o;"
    "void main(){o=texture(tex,vUV);}";

  GLuint vs = compile(GL_VERTEX_SHADER,  is_gles ? vsrc_gles : vsrc_core);
  GLuint fs = compile(GL_FRAGMENT_SHADER, is_gles ? fsrc_gles : fsrc_core);
  g_prog = p_glCreateProgram();
  p_glAttachShader(g_prog, vs); p_glAttachShader(g_prog, fs);
  p_glLinkProgram(g_prog);
  GLint ok = 0; p_glGetProgramiv(g_prog, GL_LINK_STATUS, &ok);
  if (!ok) { fprintf(stderr, "[gl_blit] program link failed\n"); return 0; }
  g_aPos = p_glGetAttribLocation(g_prog, "aPos");
  g_aUV  = p_glGetAttribLocation(g_prog, "aUV");

  if (p_glGenVertexArrays && p_glBindVertexArray) { p_glGenVertexArrays(1, &g_vao); p_glBindVertexArray(g_vao); }
  p_glGenBuffers(1, &g_vbo);
  p_glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
  p_glBufferData(GL_ARRAY_BUFFER, sizeof(QUAD), QUAD, GL_STATIC_DRAW);

  p_glGenTextures(1, &g_tex);
  p_glBindTexture(GL_TEXTURE_2D, g_tex);
  p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  p_glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

  g_ready = 1;
  return 1;
}

// Upload the software RGBA framebuffer (top-down, w*h*4 bytes) and draw it as a
// fullscreen quad into the currently-bound (frontend) framebuffer.
void jsg_gl_blit_present(const uint32_t* pixels, int w, int h, unsigned fbo) {
  if (!g_ready || !pixels) return;
  p_glBindFramebuffer(0x8D40 /*GL_FRAMEBUFFER*/, fbo);
  p_glViewport(0, 0, w, h);
  p_glDisable(GL_DEPTH_TEST);
  p_glDisable(GL_CULL_FACE);
  p_glDisable(GL_BLEND);
  p_glClearColor(0, 0, 0, 1); p_glClear(GL_COLOR_BUFFER_BIT);

  p_glActiveTexture(GL_TEXTURE0);
  p_glBindTexture(GL_TEXTURE_2D, g_tex);
  p_glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  // canvas.data() is RGBA byte order; upload as RGBA directly.
  if (w != g_tw || h != g_th) {
    p_glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    g_tw = w; g_th = h;
  } else {
    p_glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  }

  p_glUseProgram(g_prog);
  if (g_vao && p_glBindVertexArray) p_glBindVertexArray(g_vao);
  p_glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
  if (g_aPos >= 0) { p_glEnableVertexAttribArray(g_aPos); p_glVertexAttribPointer(g_aPos, 2, GL_FLOAT, GL_FALSE, 4*sizeof(GLfloat), (void*)0); }
  if (g_aUV  >= 0) { p_glEnableVertexAttribArray(g_aUV);  p_glVertexAttribPointer(g_aUV,  2, GL_FLOAT, GL_FALSE, 4*sizeof(GLfloat), (void*)(2*sizeof(GLfloat))); }
  GLint loc = p_glGetUniformLocation(g_prog, "tex");
  if (loc >= 0) p_glUniform1i(loc, 0);
  p_glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

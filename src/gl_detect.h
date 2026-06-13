// gl_detect.h — predict whether a game needs a GPU (WebGL) context, decided at
// retro_load_game time (before any game JS runs — a hard libretro constraint).
#ifndef JSG_GL_DETECT_H
#define JSG_GL_DETECT_H

#ifdef __cplusplus
extern "C" {
#endif

// Returns 1 if the game at content_path requests a WebGL context anywhere in
// its source (any canvas), else 0. Scans dir-mode sibling JS files (.jsg) or
// .jsgame zip entries. Heuristic: looks for a getContext + webgl pairing.
int jsg_game_wants_gl(const char* content_path);

#ifdef __cplusplus
}
#endif

#endif  // JSG_GL_DETECT_H

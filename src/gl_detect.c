// gl_detect.c — decide BEFORE bootstrap whether a game needs a GPU context.
//
// libretro forces the choice up front: SET_HW_RENDER must be called in
// retro_load_game, before any game JS runs. By the time the game calls
// canvas.getContext('webgl2') it's far too late to ask the frontend for a GL
// context. jsgamelauncher (which owns its own window) can create GL lazily; we
// can't. So we predict GL use by scanning the game's own source for a webgl
// getContext call — multi-canvas safe (ANY canvas asking for webgl ⇒ GPU), no
// author-facing config field. JSGAME_GL=1 forces it on for the rare miss.
#include "gl_detect.h"
#include "vendor/miniz.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dirent.h>
#include <sys/stat.h>
#endif

// A webgl getContext appears as e.g. getContext('webgl2') / getContext("webgl").
// We don't parse JS — a substring scan for both tokens in the same file is
// enough (false positives only if a file literally contains both strings for
// other reasons, which still safely requests GL). Case-insensitive on "webgl".
static int blob_wants_gl(const char* buf, size_t n) {
    // memmem isn't portable to Windows; do a simple bounded search.
    static const char* GC = "getContext";
    static const char* WG = "webgl";
    int has_gc = 0, has_wg = 0;
    size_t gclen = strlen(GC), wglen = strlen(WG);
    for (size_t i = 0; i + gclen <= n && !has_gc; i++)
        if (memcmp(buf + i, GC, gclen) == 0) has_gc = 1;
    for (size_t i = 0; i + wglen <= n && !has_wg; i++)
        if (strncasecmp(buf + i, WG, wglen) == 0) has_wg = 1;
    return has_gc && has_wg;
}

static int has_js_ext(const char* name) {
    size_t n = strlen(name);
    if (n >= 3 && strcasecmp(name + n - 3, ".js") == 0) return 1;
    if (n >= 4 && strcasecmp(name + n - 4, ".mjs") == 0) return 1;
    if (n >= 4 && strcasecmp(name + n - 4, ".cjs") == 0) return 1;
    return 0;
}

#define MAX_SCAN_BYTES (4 * 1024 * 1024)  // skip huge bundles' tails; head is enough
#define MAX_FILES 2000                     // runaway guard

static int file_wants_gl(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return 0;
    // Read in capped chunks so a giant minified bundle doesn't blow memory; a
    // webgl getContext lives in the first few MB of any real game's code.
    static char buf[256 * 1024];
    size_t total = 0;
    int found = 0;
    char tail[16] = {0};  // bridge token across chunk boundaries
    size_t taillen = 0;
    while (total < MAX_SCAN_BYTES) {
        size_t n = fread(buf, 1, sizeof(buf), f);
        if (n == 0) break;
        total += n;
        if (blob_wants_gl(buf, n)) { found = 1; break; }
        // Cheap boundary bridge: prepend prior tail and re-test the seam.
        if (taillen) {
            char seam[16 + 32];
            size_t sl = taillen + (n < 32 ? n : 32);
            memcpy(seam, tail, taillen);
            memcpy(seam + taillen, buf, sl - taillen);
            if (blob_wants_gl(seam, sl)) { found = 1; break; }
        }
        taillen = n < sizeof(tail) ? n : sizeof(tail);
        memcpy(tail, buf + n - taillen, taillen);
    }
    fclose(f);
    return found;
}

#ifndef _WIN32
static int scan_dir(const char* dir, int depth, int* file_count) {
    if (depth > 6 || *file_count > MAX_FILES) return 0;
    DIR* d = opendir(dir);
    if (!d) return 0;
    int found = 0;
    struct dirent* e;
    while ((e = readdir(d)) != NULL && !found) {
        if (e->d_name[0] == '.') continue;  // skip dotfiles + . / ..
        if (strcmp(e->d_name, "node_modules") == 0) continue;  // deps don't decide
        char path[4096];
        if (snprintf(path, sizeof(path), "%s/%s", dir, e->d_name) >= (int)sizeof(path)) continue;
        struct stat st;
        if (stat(path, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            found = scan_dir(path, depth + 1, file_count);
        } else if (S_ISREG(st.st_mode) && has_js_ext(e->d_name)) {
            (*file_count)++;
            found = file_wants_gl(path);
        }
    }
    closedir(d);
    return found;
}
#else
static int scan_dir(const char* dir, int depth, int* file_count) {
    if (depth > 6 || *file_count > MAX_FILES) return 0;
    char glob[4096];
    if (snprintf(glob, sizeof(glob), "%s\\*", dir) >= (int)sizeof(glob)) return 0;
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(glob, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    int found = 0;
    do {
        if (fd.cFileName[0] == '.') continue;
        if (strcmp(fd.cFileName, "node_modules") == 0) continue;
        char path[4096];
        if (snprintf(path, sizeof(path), "%s\\%s", dir, fd.cFileName) >= (int)sizeof(path)) continue;
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            found = scan_dir(path, depth + 1, file_count);
        } else if (has_js_ext(fd.cFileName)) {
            (*file_count)++;
            found = file_wants_gl(path);
        }
    } while (FindNextFileA(h, &fd) && !found);
    FindClose(h);
    return found;
}
#endif

// Scan a .jsgame zip's JS entries via miniz (already vendored for the runtime).
static int zip_wants_gl(const char* zip_path) {
    mz_zip_archive zip;
    memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_file(&zip, zip_path, 0)) return 0;
    int found = 0;
    mz_uint count = mz_zip_reader_get_num_files(&zip);
    for (mz_uint i = 0; i < count && !found; i++) {
        mz_zip_archive_file_stat st;
        if (!mz_zip_reader_file_stat(&zip, i, &st)) continue;
        if (st.m_is_directory || !has_js_ext(st.m_filename)) continue;
        if (strstr(st.m_filename, "node_modules/")) continue;
        size_t sz = 0;
        void* p = mz_zip_reader_extract_to_heap(&zip, i, &sz, 0);
        if (p) {
            if (blob_wants_gl((const char*)p, sz)) found = 1;
            mz_free(p);
        }
    }
    mz_zip_reader_end(&zip);
    return found;
}

static int ends_with_ci(const char* s, const char* suf) {
    size_t ls = strlen(s), lf = strlen(suf);
    return ls >= lf && strcasecmp(s + ls - lf, suf) == 0;
}

int jsg_game_wants_gl(const char* content_path) {
    if (!content_path) return 0;
    if (ends_with_ci(content_path, ".jsgame") || ends_with_ci(content_path, ".zip"))
        return zip_wants_gl(content_path);

    // Dir mode: scan the game folder (the .jsg marker's directory).
    char dir[4096];
    strncpy(dir, content_path, sizeof(dir) - 1);
    dir[sizeof(dir) - 1] = '\0';
    char* slash = strrchr(dir, '/');
#ifdef _WIN32
    char* bslash = strrchr(dir, '\\');
    if (bslash > slash) slash = bslash;
#endif
    if (slash) *slash = '\0';
    else { dir[0] = '.'; dir[1] = '\0'; }
    int file_count = 0;
    return scan_dir(dir, 0, &file_count);
}

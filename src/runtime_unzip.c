// runtime_unzip.c — extract the embedded runtime zip (embedded_runtime.c) to a
// temp dir so the existing path-based loader (createRequire + new Worker(path))
// works with no JSGAME_RUNTIME_DIR. miniz reads the zip straight from the
// in-binary byte array; we mirror its entries into <tmp>/jsgame-runtime-<tag>/.
//
// miniz is compiled with MINIZ_NO_ZLIB_APIS + MINIZ_NO_ARCHIVE_WRITING_APIS
// (see CMakeLists) so it exposes only the mz_zip_reader_* surface and adds no
// zlib-compatible names that would collide with libnode's bundled zlib.
#include "embedded_runtime.h"
#include "vendor/miniz.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#define JSG_PATH_MAX MAX_PATH
#define jsg_mkdir(p) _mkdir(p)
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <limits.h>
#ifndef JSG_PATH_MAX
#ifdef PATH_MAX
#define JSG_PATH_MAX PATH_MAX
#else
#define JSG_PATH_MAX 4096
#endif
#endif
#define jsg_mkdir(p) mkdir((p), 0755)
#endif

// retro_load_game is driven single-threaded from the frontend, so a plain
// static guard is sufficient (no once-init needed).
static char g_dir[JSG_PATH_MAX];
static int g_done = 0;

static const char* temp_root(void) {
#ifdef _WIN32
    static char buf[JSG_PATH_MAX];
    DWORD n = GetTempPathA((DWORD)sizeof(buf), buf);
    if (n == 0 || n >= sizeof(buf)) return ".";
    // GetTempPathA leaves a trailing backslash — strip it for uniform joins.
    if (n > 0 && (buf[n - 1] == '\\' || buf[n - 1] == '/')) buf[n - 1] = '\0';
    return buf;
#else
    // Android's runtime sets TMPDIR to the app cache dir; honour it first.
    const char* t = getenv("TMPDIR");
    if (t && *t) return t;
    return "/tmp";
#endif
}

static int path_exists(const char* p) {
#ifdef _WIN32
    return GetFileAttributesA(p) != INVALID_FILE_ATTRIBUTES;
#else
    struct stat st;
    return stat(p, &st) == 0;
#endif
}

// mkdir -p for a directory path (all '/' separators; we feed miniz names which
// always use '/'). The buffer is mutated in place then restored.
static int mkdir_p(char* path) {
    for (char* s = path; *s; s++) {
        if (*s == '/' && s != path) {
            char saved = *s;
            *s = '\0';
            if (!path_exists(path) && jsg_mkdir(path) != 0 && !path_exists(path)) {
                *s = saved;
                return -1;
            }
            *s = saved;
        }
    }
    if (!path_exists(path) && jsg_mkdir(path) != 0 && !path_exists(path)) return -1;
    return 0;
}

const char* jsg_extract_embedded_runtime(void) {
    if (g_done) return g_dir[0] ? g_dir : NULL;
    g_done = 1;

    if (jsg_runtime_zip_len == 0) {
        // Empty blob (e.g. -DJSG_SKIP_EMBED dev build) — no embedded runtime.
        g_dir[0] = '\0';
        return NULL;
    }

    int n = snprintf(g_dir, sizeof(g_dir), "%s/jsgame-runtime-%s",
                     temp_root(), jsg_runtime_zip_tag);
    if (n <= 0 || (size_t)n >= sizeof(g_dir)) {
        g_dir[0] = '\0';
        return NULL;
    }

    // Sentinel for idempotence across launches: bootstrap.js is the entry the
    // trampoline requires, so its presence means a complete prior extraction.
    char sentinel[JSG_PATH_MAX];
    if (snprintf(sentinel, sizeof(sentinel), "%s/bootstrap.js", g_dir) > 0 &&
        path_exists(sentinel)) {
        return g_dir;
    }

    if (mkdir_p(g_dir) != 0) {
        g_dir[0] = '\0';
        return NULL;
    }

    mz_zip_archive zip;
    memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_mem(&zip, jsg_runtime_zip, jsg_runtime_zip_len, 0)) {
        g_dir[0] = '\0';
        return NULL;
    }

    int ok = 1;
    mz_uint count = mz_zip_reader_get_num_files(&zip);
    for (mz_uint i = 0; i < count; i++) {
        mz_zip_archive_file_stat st;
        if (!mz_zip_reader_file_stat(&zip, i, &st)) { ok = 0; break; }

        char dst[JSG_PATH_MAX];
        if (snprintf(dst, sizeof(dst), "%s/%s", g_dir, st.m_filename) >= (int)sizeof(dst)) {
            ok = 0; break;
        }

        if (st.m_is_directory) {
            if (mkdir_p(dst) != 0) { ok = 0; break; }
            continue;
        }

        // Ensure parent dirs exist before extracting the file.
        char parent[JSG_PATH_MAX];
        strncpy(parent, dst, sizeof(parent) - 1);
        parent[sizeof(parent) - 1] = '\0';
        char* slash = strrchr(parent, '/');
        if (slash && slash != parent) {
            *slash = '\0';
            if (mkdir_p(parent) != 0) { ok = 0; break; }
        }

        if (!mz_zip_reader_extract_to_file(&zip, i, dst, 0)) { ok = 0; break; }
    }

    mz_zip_reader_end(&zip);
    if (!ok) {
        g_dir[0] = '\0';
        return NULL;
    }
    return g_dir;
}

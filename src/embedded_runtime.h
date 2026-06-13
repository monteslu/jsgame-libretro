// embedded_runtime.h — the privileged JS runtime (runtime/) is zipped at build
// time and embedded in the .so as a byte array (generated embedded_runtime.c).
// On first content load it's extracted to a temp dir once per process; the
// existing runtime_dir code path then loads it exactly as in dev mode.
#ifndef JSG_EMBEDDED_RUNTIME_H
#define JSG_EMBEDDED_RUNTIME_H

#ifdef __cplusplus
extern "C" {
#endif

// Defined by the generated embedded_runtime.c (scripts/bin2c.js).
extern const unsigned char jsg_runtime_zip[];
extern const unsigned long jsg_runtime_zip_len;
extern const char jsg_runtime_zip_tag[];  // 8-hex crc32 — versions the dir

// Extract the embedded runtime zip to a temp dir once per process. Returns the
// absolute path to the extracted directory (owned internally, valid for the
// process lifetime), or NULL on failure. Idempotent: a dir already populated
// for this runtime's content tag is reused without re-extracting.
const char* jsg_extract_embedded_runtime(void);

#ifdef __cplusplus
}
#endif

#endif  // JSG_EMBEDDED_RUNTIME_H

// binding_audio.cpp — jsgame_audio linked binding over the natively-compiled
// webaudio engine (src/webaudio/, same sources webaudio-node ships as WASM).
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <string>

#include "node_api.h"

extern "C" {
int createAudioGraph(int sample_rate, int channels, int buffer_size, bool is_realtime);
void destroyAudioGraph(int graph_id);
int createNode(int graph_id, const char* type_str);
void connectNodes(int graph_id, int source_id, int dest_id, int output_idx, int input_idx);
void disconnectNodes(int, int, int);
void startNode(int graph_id, int node_id, double when);
void stopNode(int graph_id, int node_id, double when);
void setNodeParameter(int graph_id, int node_id, int param_id, float value);
void scheduleParamEvent(int graph_id, int node_id, int param_id, int kind, float value, double time, float timeConstant);
void processGraph(int graph_id, float* output, int frame_count);
double getGraphCurrentTime(int graph_id);
void setGraphCurrentTime(int graph_id, double time);
void setNodeBuffer(int graph_id, int node_id, float* data, int frames, int channels);
void registerBuffer(int graph_id, int buffer_id, float* data, int frames, int channels);
void setNodeBufferId(int graph_id, int node_id, int buffer_id);
int decodeAudio(const uint8_t* input, size_t inputSize, float** output, size_t* totalSamples, int* sampleRate);
float* resampleAudio(const float* input, size_t inputFrames, int channels, int fromRate, int toRate, size_t* outFrames);
void freeDecodedBuffer(float* buffer);
void deinterleaveAudio(float* interleaved, float* planar, int frame_count, int num_channels);
}

static double argnum(napi_env env, napi_value v) {
  double d = 0;
  napi_get_value_double(env, v, &d);
  return d;
}
static std::string argstr(napi_env env, napi_value v) {
  size_t len = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  std::string s(len, 0);
  napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  return s;
}
static void* argta(napi_env env, napi_value v, size_t* len) {
  void* data = nullptr;
  napi_typedarray_type t;
  napi_value ab;
  size_t off;
  napi_get_typedarray_info(env, v, &t, len, &data, &ab, &off);
  return data;
}
static napi_value mknum(napi_env env, double d) {
  napi_value v;
  napi_create_double(env, d, &v);
  return v;
}
#define ARGS(n)                                              \
  size_t argc = (n);                                         \
  napi_value argv[(n) > 0 ? (n) : 1];                        \
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr)
#define N(i) argnum(env, argv[i])
#define FN(name) static napi_value name(napi_env env, napi_callback_info info)

FN(a_createGraph) { ARGS(4); return mknum(env, createAudioGraph((int)N(0), (int)N(1), (int)N(2), N(3) != 0)); }
FN(a_destroyGraph) { ARGS(1); destroyAudioGraph((int)N(0)); return nullptr; }
FN(a_createNode) { ARGS(2); return mknum(env, createNode((int)N(0), argstr(env, argv[1]).c_str())); }
FN(a_connectNodes) { ARGS(5); connectNodes((int)N(0), (int)N(1), (int)N(2), (int)N(3), (int)N(4)); return nullptr; }
FN(a_disconnectNodes) { ARGS(3); disconnectNodes((int)N(0), (int)N(1), (int)N(2)); return nullptr; }
FN(a_startNode) { ARGS(3); startNode((int)N(0), (int)N(1), N(2)); return nullptr; }
FN(a_stopNode) { ARGS(3); stopNode((int)N(0), (int)N(1), N(2)); return nullptr; }
// param_id arrives as a NUMBER (the JS NativeAudioEngine converts the param name
// string → ParamID before calling native), so (int)N(2) is correct here.
FN(a_setNodeParameter) { ARGS(4); setNodeParameter((int)N(0), (int)N(1), (int)N(2), (float)N(3)); return nullptr; }
// scheduleParamEvent(graphId, nodeId, paramId, kind, value, time, timeConstant)
FN(a_scheduleParamEvent) { ARGS(7); scheduleParamEvent((int)N(0), (int)N(1), (int)N(2), (int)N(3), (float)N(4), N(5), (float)N(6)); return nullptr; }
FN(a_getCurrentTime) { ARGS(1); return mknum(env, getGraphCurrentTime((int)N(0))); }
FN(a_setCurrentTime) { ARGS(2); setGraphCurrentTime((int)N(0), N(1)); return nullptr; }

// processGraph(graphId, out: Float32Array, frames)
FN(a_processGraph) {
  ARGS(3);
  size_t len = 0;
  float* out = (float*)argta(env, argv[1], &len);
  if (out) processGraph((int)N(0), out, (int)N(2));
  return nullptr;
}

// setNodeBuffer(graphId, nodeId, data: Float32Array (interleaved), frames, channels)
FN(a_setNodeBuffer) {
  ARGS(5);
  size_t len = 0;
  float* data = (float*)argta(env, argv[2], &len);
  if (data) setNodeBuffer((int)N(0), (int)N(1), data, (int)N(3), (int)N(4));
  return nullptr;
}
FN(a_registerBuffer) {
  ARGS(5);
  size_t len = 0;
  float* data = (float*)argta(env, argv[2], &len);
  if (data) registerBuffer((int)N(0), (int)N(1), data, (int)N(3), (int)N(4));
  return nullptr;
}
FN(a_setNodeBufferId) { ARGS(3); setNodeBufferId((int)N(0), (int)N(1), (int)N(2)); return nullptr; }
// deinterleave(interleaved: Float32Array, planar: Float32Array, frames, channels)
// Splits interleaved [L,R,L,R,...] into channel-concatenated planar
// [L0..Ln, R0..Rn, ...] using the engine's SIMD/scalar deinterleave (native; far
// faster than a per-sample JS loop). The JS caller slices each channel out of
// planar. Used by AudioBuffer.getChannelData (cold path).
FN(a_deinterleave) {
  ARGS(4);
  size_t il = 0, pl = 0;
  float* interleaved = (float*)argta(env, argv[0], &il);
  float* planar = (float*)argta(env, argv[1], &pl);
  if (interleaved && planar) deinterleaveAudio(interleaved, planar, (int)N(2), (int)N(3));
  return nullptr;
}

// decode(bytes: Uint8Array, targetRate) -> Promise<{ channels, length, sampleRate, data: Float32Array }>
//
// ASYNC, like the browser: decodeAudioData must not block the JS thread. The decode
// + resample run on libnode's libuv thread pool (the Execute callback, which makes
// NO napi calls), and the result is built + the promise settled on the JS thread
// (Complete). Previously this ran decodeAudio() inline, so decoding large/long files
// (e.g. several multi-minute music tracks at once → hundreds of MB of PCM) stalled
// the game loop until every decode finished.
struct DecodeWork {
  napi_async_work work;
  napi_deferred deferred;
  // input (copied so it's safe to touch off the JS thread)
  uint8_t* input;
  size_t inputLen;
  int targetRate;
  // output (filled on the worker thread)
  float* out;
  size_t frames;
  int channels;
  int rate;
};

static void decode_execute(napi_env, void* data) {
  DecodeWork* w = (DecodeWork*)data;
  float* out = nullptr;
  size_t totalSamples = 0;
  int rate = 0;
  int channels = decodeAudio(w->input, w->inputLen, &out, &totalSamples, &rate);
  if (channels <= 0 || !out) { w->channels = -1; return; }
  size_t frames = totalSamples / channels;

  if (w->targetRate > 0 && rate != w->targetRate) {
    size_t outFrames = 0;
    float* res = resampleAudio(out, frames, channels, rate, w->targetRate, &outFrames);
    if (res) { freeDecodedBuffer(out); out = res; frames = outFrames; rate = w->targetRate; }
  }
  w->out = out; w->frames = frames; w->channels = channels; w->rate = rate;
}

// Finalizer for the external ArrayBuffer: frees the decoded PCM the buffer wraps,
// run by V8 when the ArrayBuffer is GC'd. (matches freeDecodedBuffer == free())
static void decode_buffer_finalize(node_api_basic_env, void* data, void*) {
  freeDecodedBuffer((float*)data);
}

static void decode_complete(napi_env env, napi_status status, void* data) {
  DecodeWork* w = (DecodeWork*)data;
  if (status != napi_ok || w->channels <= 0 || !w->out) {
    if (w->out) freeDecodedBuffer(w->out);  // error path: nothing wrapped it
    napi_value undef; napi_get_undefined(env, &undef);
    // Resolve with undefined; the JS layer turns a null/undefined result into the
    // 'unsupported or corrupt audio' error (keeps reject behavior consistent).
    napi_resolve_deferred(env, w->deferred, undef);
  } else {
    // ZERO-COPY: wrap the worker's decoded PCM as an external ArrayBuffer instead
    // of allocating a second buffer and memcpy'ing into it. For multi-minute music
    // that copy was ~100MB+ on the JS thread per track (a startup/boss-fight stall
    // source). The buffer is now owned by V8 and freed via the finalizer.
    napi_value result, ab, ta, v;
    size_t nbytes = w->frames * w->channels * sizeof(float);
    napi_create_external_arraybuffer(env, w->out, nbytes,
                                     decode_buffer_finalize, nullptr, &ab);
    w->out = nullptr;  // ownership transferred to the ArrayBuffer's finalizer
    napi_create_object(env, &result);
    napi_create_typedarray(env, napi_float32_array, w->frames * w->channels, ab, 0, &ta);
    napi_set_named_property(env, result, "data", ta);
    napi_create_int32(env, w->channels, &v); napi_set_named_property(env, result, "channels", v);
    napi_create_int32(env, (int)w->frames, &v); napi_set_named_property(env, result, "length", v);
    napi_create_int32(env, w->rate, &v); napi_set_named_property(env, result, "sampleRate", v);
    napi_resolve_deferred(env, w->deferred, result);
  }
  free(w->input);
  napi_delete_async_work(env, w->work);
  delete w;
}

FN(a_decode) {
  ARGS(2);
  size_t len = 0;
  uint8_t* bytes = (uint8_t*)argta(env, argv[0], &len);
  int targetRate = (int)N(1);

  napi_value promise;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);

  if (!bytes || len == 0) {
    napi_value undef; napi_get_undefined(env, &undef);
    napi_resolve_deferred(env, deferred, undef);
    return promise;
  }

  DecodeWork* w = new DecodeWork();
  w->deferred = deferred;
  w->inputLen = len;
  w->input = (uint8_t*)malloc(len);
  memcpy(w->input, bytes, len);  // copy NOW — the JS array may move/free after we return
  w->targetRate = targetRate;
  w->out = nullptr; w->frames = 0; w->channels = 0; w->rate = 0;

  napi_value name;
  napi_create_string_utf8(env, "jsgame:decodeAudio", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, decode_execute, decode_complete, w, &w->work);
  napi_queue_async_work(env, w->work);
  return promise;
}

extern "C" napi_value jsg_audio_register(napi_env env, napi_value exports) {
  struct {
    const char* name;
    napi_callback fn;
  } fns[] = {
      {"createGraph", a_createGraph}, {"destroyGraph", a_destroyGraph},
      {"createNode", a_createNode}, {"connectNodes", a_connectNodes},
      {"disconnectNodes", a_disconnectNodes}, {"startNode", a_startNode},
      {"stopNode", a_stopNode}, {"setNodeParameter", a_setNodeParameter},
      {"scheduleParamEvent", a_scheduleParamEvent},
      {"getCurrentTime", a_getCurrentTime}, {"setCurrentTime", a_setCurrentTime},
      {"processGraph", a_processGraph}, {"setNodeBuffer", a_setNodeBuffer},
      {"registerBuffer", a_registerBuffer}, {"setNodeBufferId", a_setNodeBufferId},
      {"deinterleave", a_deinterleave},
      {"decode", a_decode},
  };
  for (auto& f : fns) {
    napi_value fn;
    napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &fn);
    napi_set_named_property(env, exports, f.name, fn);
  }
  return exports;
}

// Audio format decoders using dr_libs and stb
// Public domain single-header audio decoders

#define DR_MP3_IMPLEMENTATION
#include "../vendor/dr_mp3.h"

#define DR_WAV_IMPLEMENTATION
#include "../vendor/dr_wav.h"

#define DR_FLAC_IMPLEMENTATION
#include "../vendor/dr_flac.h"

#include "../vendor/stb_vorbis.c"

// Opus (Ogg-Opus): libopus + libogg + opusfile (all BSD, royalty-free patents).
// opusfile is a real library (compiled separately + linked), not single-header, so
// we only include its API here. It always decodes to 48 kHz interleaved float.
extern "C" {
#include "../vendor/opusfile/include/opusfile.h"
}

// Speex resampler (BSD license)
#define OUTSIDE_SPEEX
#define RANDOM_PREFIX webaudio
#define FLOATING_POINT  // Use floating point (not fixed point)
#define EXPORT
#include "../vendor/resample.c"

// AAC: not supported. The old uaac decoder was x86-only inline asm (broke on
// ARM/MSVC) so it was compiled out on every platform — dead weight, now removed
// (along with src/vendor/uaac.h). AAC-LC is patent-free (US patents expired 2017),
// so a future AAC decoder is legally fine; the right library is Ittiam libxaac
// (Apache-2.0, actively maintained + fuzzed) — fdk-aac-free is abandonware with
// unpatched security bugs and faad2 is GPL. For now WAV/MP3/FLAC/Vorbis/Opus cover
// game audio and match Chrome's set (Chromium itself also ships no AAC).

#include <emscripten.h>
#include <cstdlib>
#include <cstring>
#include <vector>

extern "C" {

// Decode MP3 file to interleaved float samples
// Returns: number of channels (1 or 2), or -1 on error
// Output format: interleaved float32 samples [L, R, L, R, ...]
EMSCRIPTEN_KEEPALIVE
int decodeMP3(const uint8_t* input, size_t inputSize, float** output, size_t* totalSamples, int* sampleRate) {
    drmp3 mp3;

    if (!drmp3_init_memory(&mp3, input, inputSize, NULL)) {
        return -1;
    }

    // Get total frame count and allocate output buffer
    drmp3_uint64 totalFrames = drmp3_get_pcm_frame_count(&mp3);
    int channels = mp3.channels;
    *sampleRate = mp3.sampleRate;
    *totalSamples = totalFrames * channels;

    // Allocate output buffer (caller must free)
    *output = (float*)malloc(*totalSamples * sizeof(float));
    if (!*output) {
        drmp3_uninit(&mp3);
        return -1;
    }

    // Decode all frames at once
    drmp3_uint64 framesRead = drmp3_read_pcm_frames_f32(&mp3, totalFrames, *output);

    drmp3_uninit(&mp3);

    if (framesRead != totalFrames) {
        free(*output);
        return -1;
    }

    return channels;
}

// Decode WAV file to interleaved float samples
// Returns: number of channels (1 or 2), or -1 on error
// Output format: interleaved float32 samples [L, R, L, R, ...]
EMSCRIPTEN_KEEPALIVE
int decodeWAV(const uint8_t* input, size_t inputSize, float** output, size_t* totalSamples, int* sampleRate) {
    drwav wav;

    if (!drwav_init_memory(&wav, input, inputSize, NULL)) {
        return -1;
    }

    int channels = wav.channels;
    *sampleRate = wav.sampleRate;
    drwav_uint64 totalFrames = wav.totalPCMFrameCount;
    *totalSamples = totalFrames * channels;

    // Allocate output buffer (caller must free)
    *output = (float*)malloc(*totalSamples * sizeof(float));
    if (!*output) {
        drwav_uninit(&wav);
        return -1;
    }

    // Decode all frames at once
    drwav_uint64 framesRead = drwav_read_pcm_frames_f32(&wav, totalFrames, *output);

    drwav_uninit(&wav);

    if (framesRead != totalFrames) {
        free(*output);
        return -1;
    }

    return channels;
}

// Decode FLAC file to interleaved float samples
// Returns: number of channels, or -1 on error
// Output format: interleaved float32 samples [L, R, L, R, ...]
EMSCRIPTEN_KEEPALIVE
int decodeFLAC(const uint8_t* input, size_t inputSize, float** output, size_t* totalSamples, int* sampleRate) {
    drflac* flac = drflac_open_memory(input, inputSize, NULL);

    if (!flac) {
        return -1;
    }

    int channels = flac->channels;
    *sampleRate = flac->sampleRate;
    drflac_uint64 totalFrames = flac->totalPCMFrameCount;
    *totalSamples = totalFrames * channels;

    // Allocate output buffer (caller must free)
    *output = (float*)malloc(*totalSamples * sizeof(float));
    if (!*output) {
        drflac_close(flac);
        return -1;
    }

    // Decode all frames at once
    drflac_uint64 framesRead = drflac_read_pcm_frames_f32(flac, totalFrames, *output);

    drflac_close(flac);

    if (framesRead != totalFrames) {
        free(*output);
        return -1;
    }

    return channels;
}

// Decode Vorbis/OGG file to interleaved float samples
// Returns: number of channels, or -1 on error
// Output format: interleaved float32 samples [L, R, L, R, ...]
EMSCRIPTEN_KEEPALIVE
int decodeVorbis(const uint8_t* input, size_t inputSize, float** output, size_t* totalSamples, int* sampleRate) {
    int error = 0;
    stb_vorbis* vorbis = stb_vorbis_open_memory(input, inputSize, &error, NULL);

    if (!vorbis || error != 0) {
        return -1;
    }

    stb_vorbis_info info = stb_vorbis_get_info(vorbis);
    int channels = info.channels;
    *sampleRate = info.sample_rate;

    // Get total sample count
    int totalFrames = stb_vorbis_stream_length_in_samples(vorbis);
    *totalSamples = totalFrames * channels;

    // Allocate output buffer (caller must free)
    *output = (float*)malloc(*totalSamples * sizeof(float));
    if (!*output) {
        stb_vorbis_close(vorbis);
        return -1;
    }

    // stb_vorbis returns samples per channel, need to interleave
    // Allocate temp buffer for planar data
    float** channelData = (float**)malloc(channels * sizeof(float*));
    for (int i = 0; i < channels; i++) {
        channelData[i] = (float*)malloc(totalFrames * sizeof(float));
    }

    // Decode all samples
    int samplesRead = 0;
    int offset = 0;
    while (offset < totalFrames) {
        int n = stb_vorbis_get_samples_float(vorbis, channels, channelData, totalFrames - offset);
        if (n == 0) break;

        // Interleave samples
        for (int frame = 0; frame < n; frame++) {
            for (int ch = 0; ch < channels; ch++) {
                (*output)[(offset + frame) * channels + ch] = channelData[ch][frame];
            }
        }
        offset += n;
        samplesRead += n;
    }

    // Free temp buffers
    for (int i = 0; i < channels; i++) {
        free(channelData[i]);
    }
    free(channelData);

    stb_vorbis_close(vorbis);

    if (samplesRead != totalFrames) {
        free(*output);
        return -1;
    }

    return channels;
}

// Decode an Ogg-Opus stream to interleaved float. opusfile always outputs 48 kHz
// (Opus is internally always 48 kHz), so sampleRate is 48000 and no resample is
// needed for our 48 kHz context. Returns channel count, or -1 on error.
EMSCRIPTEN_KEEPALIVE
int decodeOpus(const uint8_t* input, size_t inputSize, float** output, size_t* totalSamples, int* sampleRate) {
    int err = 0;
    OggOpusFile* of = op_open_memory(input, inputSize, &err);
    if (!of || err != 0) { if (of) op_free(of); return -1; }

    int channels = op_channel_count(of, -1);   // -1 = whole stream (first link)
    if (channels < 1 || channels > 8) { op_free(of); return -1; }
    *sampleRate = 48000;  // opusfile always decodes to 48 kHz

    // op_read_float returns samples-per-channel per call; total length may be known
    // (seekable) but isn't guaranteed, so grow the buffer as we decode.
    ogg_int64_t hint = op_pcm_total(of, -1);    // total frames, or negative if unknown
    size_t cap = (hint > 0 ? (size_t)hint : 48000) * channels;  // start at hint, or ~1s
    float* out = (float*)malloc(cap * sizeof(float));
    if (!out) { op_free(of); return -1; }

    size_t filled = 0;            // total floats written
    const int CHUNK = 5760;       // frames per read (120ms @48k, opusfile-recommended)
    for (;;) {
        // ensure room for one more chunk (CHUNK frames * channels floats)
        size_t need = filled + (size_t)CHUNK * channels;
        if (need > cap) {
            cap = need * 2;
            float* grown = (float*)realloc(out, cap * sizeof(float));
            if (!grown) { free(out); op_free(of); return -1; }
            out = grown;
        }
        int n = op_read_float(of, out + filled, (int)((cap - filled)), NULL);
        if (n < 0) { free(out); op_free(of); return -1; }  // decode error
        if (n == 0) break;                                  // end of stream
        filled += (size_t)n * channels;
    }
    op_free(of);

    // Shrink to the actual size (best effort).
    float* fit = (float*)realloc(out, filled * sizeof(float));
    *output = fit ? fit : out;
    *totalSamples = filled;
    return channels;
}

// Resample audio using Speex resampler (high quality, SIMD-optimized)
// Returns: resampled buffer (caller must free), or NULL on error
// Output format: interleaved float32 samples at target sample rate
EMSCRIPTEN_KEEPALIVE
float* resampleAudio(const float* input, size_t inputFrames, int channels,
                     int sourceSampleRate, int targetSampleRate, size_t* outputFrames) {
    // No resampling needed
    if (sourceSampleRate == targetSampleRate) {
        *outputFrames = inputFrames;
        size_t totalSamples = inputFrames * channels;
        float* output = (float*)malloc(totalSamples * sizeof(float));
        if (output) {
            memcpy(output, input, totalSamples * sizeof(float));
        }
        return output;
    }

    // Initialize Speex resampler
    // Quality 1 = fast with decent quality (balance of speed and quality)
    // Quality 3 was adding 277% overhead for 44.1kHz->48kHz conversion
    // Quality 0 improved MP3 decode but may have quality issues
    int err = 0;
    SpeexResamplerState* resampler = speex_resampler_init(
        channels,
        sourceSampleRate,
        targetSampleRate,
        1,  // quality: 0=worst/fastest, 10=best/slowest
        &err
    );

    if (!resampler || err != RESAMPLER_ERR_SUCCESS) {
        if (resampler) {
            speex_resampler_destroy(resampler);
        }
        return NULL;
    }

    // Calculate approximate output size
    // Speex will tell us the exact output size during processing
    double ratio = (double)targetSampleRate / (double)sourceSampleRate;
    size_t estimatedOutputFrames = (size_t)((double)inputFrames * ratio + 1.0);

    float* output = (float*)malloc(estimatedOutputFrames * channels * sizeof(float));
    if (!output) {
        speex_resampler_destroy(resampler);
        return NULL;
    }

    // Speex processes interleaved data
    spx_uint32_t inLen = inputFrames;
    spx_uint32_t outLen = estimatedOutputFrames;

    err = speex_resampler_process_interleaved_float(
        resampler,
        input,
        &inLen,
        output,
        &outLen
    );

    speex_resampler_destroy(resampler);

    if (err != RESAMPLER_ERR_SUCCESS) {
        free(output);
        return NULL;
    }

    *outputFrames = outLen;
    return output;
}

// Free memory allocated by decoders
EMSCRIPTEN_KEEPALIVE
void freeDecodedBuffer(float* buffer) {
    if (buffer) {
        free(buffer);
    }
}

// Unified decoder with automatic format detection
// Returns: number of channels, or -1 on error
// Output format: interleaved float32 samples [L, R, L, R, ...]
EMSCRIPTEN_KEEPALIVE
int decodeAudio(const uint8_t* input, size_t inputSize, float** output, size_t* totalSamples, int* sampleRate) {
    if (inputSize < 4) {
        return -1; // Not enough data to detect format
    }

    // Check magic bytes to determine format
    // Note: MP3 must be checked before AAC since both use 0xFF 0xFx sync patterns
    // MP3's 0xFF 0xEx is more specific than AAC's 0xFF 0xFx

    // MP3: starts with 0xFF 0xEx or ID3 tag
    if ((input[0] == 0xFF && (input[1] & 0xE0) == 0xE0) ||
        (input[0] == 0x49 && input[1] == 0x44 && input[2] == 0x33)) {
        return decodeMP3(input, inputSize, output, totalSamples, sampleRate);
    }

    // AAC (ADTS sync 0xFF 0xFx, after MP3): not supported (no decoder — see note
    // at top; libxaac is the future path). Falls through to "unsupported".
    if (input[0] == 0xFF && (input[1] & 0xF0) == 0xF0) {
        return -1;
    }

    // WAV: starts with "RIFF"
    if (input[0] == 0x52 && input[1] == 0x49 &&
        input[2] == 0x46 && input[3] == 0x46) {
        return decodeWAV(input, inputSize, output, totalSamples, sampleRate);
    }

    // FLAC: starts with "fLaC"
    if (input[0] == 0x66 && input[1] == 0x4C &&
        input[2] == 0x61 && input[3] == 0x43) {
        return decodeFLAC(input, inputSize, output, totalSamples, sampleRate);
    }

    // OGG container ("OggS") — holds either Vorbis or Opus. The codec id lives in
    // the first page's body: "OpusHead" for Opus, "\x01vorbis" for Vorbis. Scan the
    // first page (its segment table starts at byte 27) for the marker.
    if (input[0] == 0x4F && input[1] == 0x67 &&
        input[2] == 0x67 && input[3] == 0x53) {
        // Look for "OpusHead" within the first ~512 bytes (first page header+body).
        size_t scan = inputSize < 512 ? inputSize : 512;
        for (size_t i = 0; i + 8 <= scan; i++) {
            if (memcmp(input + i, "OpusHead", 8) == 0) {
                return decodeOpus(input, inputSize, output, totalSamples, sampleRate);
            }
        }
        return decodeVorbis(input, inputSize, output, totalSamples, sampleRate);
    }

    // Unknown format
    return -1;
}

} // extern "C"

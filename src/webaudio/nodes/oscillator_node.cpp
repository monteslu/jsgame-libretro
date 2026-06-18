// OscillatorNode WASM implementation
// Generates periodic waveforms: sine, square, sawtooth, triangle

#include <emscripten.h>
#include <wasm_simd128.h>
#include <cmath>
#include <cstring>
#include <cstdio>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Wave types
enum class WaveType {
    SINE = 0,
    SQUARE = 1,
    SAWTOOTH = 2,
    TRIANGLE = 3,
    CUSTOM = 4
};

// OscillatorNode state
struct OscillatorNodeState {
    int sample_rate;
    int channels;
    bool is_active;

    WaveType wave_type;

    double phase;

    // Custom wavetable
    float* custom_wavetable;
    int wavetable_size;

    // Scheduled timing
    double scheduled_start_time;
    double scheduled_stop_time;
    double current_time;
    bool has_started;
    bool has_stopped;

    // Anti-click envelope: a short linear fade in on start / fade out on stop.
    // A bare start/stop hard-switches the output (… ±0.9 -> 0) which is a broadband
    // click/pop. Ramping over a few ms removes it, inaudible as a level change.
    // env ramps 0->1 while starting, 1->0 while stopping; samples are multiplied by it.
    float env;            // current envelope value [0,1]
    float env_step;       // per-sample delta (set on start/stop)
    bool stopping;        // fading out; deactivate when env hits 0
};

extern "C" {

EMSCRIPTEN_KEEPALIVE
OscillatorNodeState* createOscillatorNode(
    int sample_rate,
    int channels,
    int wave_type_int
) {
    OscillatorNodeState* state = new OscillatorNodeState();
    state->sample_rate = sample_rate;
    state->channels = channels;
    state->is_active = false;  // Oscillator starts stopped
    state->wave_type = static_cast<WaveType>(wave_type_int);
    state->phase = 0.0;
    state->custom_wavetable = nullptr;
    state->wavetable_size = 0;
    state->scheduled_start_time = -1.0;
    state->scheduled_stop_time = -1.0;
    state->current_time = 0.0;
    state->has_started = false;
    state->has_stopped = false;
    state->env = 0.0f;
    state->env_step = 0.0f;
    state->stopping = false;
    return state;
}

// ~3ms anti-click fade. Short enough to be inaudible as a level change, long
// enough (≈144 samples @ 48k) to kill the start/stop click.
static inline int osc_fade_samples(const OscillatorNodeState* s) {
    int n = s->sample_rate * 3 / 1000;
    return n < 1 ? 1 : n;
}

EMSCRIPTEN_KEEPALIVE
void destroyOscillatorNode(OscillatorNodeState* state) {
    if (!state) return;

    if (state->custom_wavetable) {
        delete[] state->custom_wavetable;
    }

    delete state;
}

EMSCRIPTEN_KEEPALIVE
void startOscillator(OscillatorNodeState* state, double when) {
    if (!state) return;
    state->scheduled_start_time = when;
    state->has_started = false;
    state->has_stopped = false;
    state->phase = 0.0;
    // Don't activate immediately - will activate when current_time >= scheduled_start_time
}

EMSCRIPTEN_KEEPALIVE
void stopOscillator(OscillatorNodeState* state, double when) {
    if (!state) return;
    state->scheduled_stop_time = when;
    // Will actually stop when current_time >= scheduled_stop_time (checked in setOscillatorCurrentTime)
}

EMSCRIPTEN_KEEPALIVE
void setOscillatorWaveType(OscillatorNodeState* state, int wave_type_int) {
    if (!state) return;
    state->wave_type = static_cast<WaveType>(wave_type_int);
}

EMSCRIPTEN_KEEPALIVE
void setPeriodicWave(OscillatorNodeState* state, float* wavetable, int size) {
    if (!state) return;

    // Free old wavetable
    if (state->custom_wavetable) {
        delete[] state->custom_wavetable;
    }

    // Allocate and copy new wavetable
    state->custom_wavetable = new float[size];
    memcpy(state->custom_wavetable, wavetable, size * sizeof(float));
    state->wavetable_size = size;
    state->wave_type = WaveType::CUSTOM;
}

EMSCRIPTEN_KEEPALIVE
void setOscillatorCurrentTime(OscillatorNodeState* state, double time) {
    if (!state) return;
    state->current_time = time;

    // Check if we should start — begin a short fade-IN (env 0->1) to avoid a click.
    if (!state->has_started && state->scheduled_start_time >= 0.0 && state->current_time >= state->scheduled_start_time) {
        state->has_started = true;
        state->is_active = true;
        state->env = 0.0f;
        state->env_step = 1.0f / (float)osc_fade_samples(state);
        state->stopping = false;
    }

    // Check if we should stop — begin a fade-OUT (env 1->0); the process loop
    // clears is_active once env reaches 0 (a hard cut here would click).
    if (state->has_started && !state->has_stopped && state->scheduled_stop_time >= 0.0 && state->current_time >= state->scheduled_stop_time) {
        state->has_stopped = true;
        state->stopping = true;
        state->env_step = -1.0f / (float)osc_fade_samples(state);
    }
}

// Generate single sample based on wave type
static inline float GenerateSample(OscillatorNodeState* state) {
    float sample = 0.0f;
    double phase = state->phase;

    switch (state->wave_type) {
        case WaveType::SINE:
            sample = std::sin(2.0 * M_PI * phase);
            break;

        case WaveType::SQUARE:
            sample = (phase < 0.5) ? 1.0f : -1.0f;
            break;

        case WaveType::SAWTOOTH:
            sample = 2.0f * phase - 1.0f;
            break;

        case WaveType::TRIANGLE:
            if (phase < 0.5) {
                sample = 4.0f * phase - 1.0f;
            } else {
                sample = -4.0f * phase + 3.0f;
            }
            break;

        case WaveType::CUSTOM:
            if (state->custom_wavetable && state->wavetable_size > 0) {
                // Linear interpolation from wavetable
                double index = phase * state->wavetable_size;
                int i0 = static_cast<int>(index) % state->wavetable_size;
                int i1 = (i0 + 1) % state->wavetable_size;
                float frac = index - std::floor(index);
                sample = state->custom_wavetable[i0] * (1.0f - frac) +
                         state->custom_wavetable[i1] * frac;
            }
            break;
    }

    return sample;
}

EMSCRIPTEN_KEEPALIVE
void processOscillatorNode(
    OscillatorNodeState* state,
    float* output,
    int frame_count,
    float frequency,
    float detune
) {
    if (!state) return;

    // If not active, output silence
    if (!state->is_active) {
        memset(output, 0, frame_count * state->channels * sizeof(float));
        return;
    }

    // Apply detune (cents to frequency multiplier)
    float detune_multiplier = std::pow(2.0f, detune / 1200.0f);
    float actual_frequency = frequency * detune_multiplier;

    double phase_increment = actual_frequency / static_cast<double>(state->sample_rate);

    // Optimized path for sawtooth (most common, simple math)
    if (state->wave_type == WaveType::SAWTOOTH) {
        for (int frame = 0; frame < frame_count; ++frame) {
            float sample = 2.0f * state->phase - 1.0f;

#ifdef __wasm_simd128__
            // SIMD-optimized channel duplication for 4+ channels
            if (state->channels >= 4) {
                v128_t sample_vec = wasm_f32x4_splat(sample);
                int ch = 0;

                // Write 4 channels at a time
                for (; ch + 4 <= state->channels; ch += 4) {
                    wasm_v128_store(&output[frame * state->channels + ch], sample_vec);
                }

                // Handle remaining channels
                for (; ch < state->channels; ++ch) {
                    output[frame * state->channels + ch] = sample;
                }
            } else
#endif
            {
                // Scalar fallback for < 4 channels
                for (int ch = 0; ch < state->channels; ++ch) {
                    output[frame * state->channels + ch] = sample;
                }
            }

            // Update phase
            state->phase += phase_increment;
            if (state->phase >= 1.0) {
                state->phase -= 1.0;
            }
        }
    } else {
        // General path for other wave types
        for (int frame = 0; frame < frame_count; ++frame) {
            float sample = GenerateSample(state);

#ifdef __wasm_simd128__
            // SIMD-optimized channel duplication
            if (state->channels >= 4) {
                v128_t sample_vec = wasm_f32x4_splat(sample);
                int ch = 0;

                for (; ch + 4 <= state->channels; ch += 4) {
                    wasm_v128_store(&output[frame * state->channels + ch], sample_vec);
                }

                for (; ch < state->channels; ++ch) {
                    output[frame * state->channels + ch] = sample;
                }
            } else
#endif
            {
                for (int ch = 0; ch < state->channels; ++ch) {
                    output[frame * state->channels + ch] = sample;
                }
            }

            // Update phase
            state->phase += phase_increment;
            if (state->phase >= 1.0) {
                state->phase -= 1.0;
            }
        }
    }

    // Anti-click envelope: apply a per-frame fade when ramping in/out. When fully
    // on (env==1, env_step==0) this is skipped for zero cost. When the fade-out
    // completes, the oscillator goes silent and inactive (no hard cut = no click).
    if (state->env_step != 0.0f || state->env < 1.0f) {
        const int ch = state->channels;
        for (int frame = 0; frame < frame_count; ++frame) {
            float e = state->env;
            for (int c = 0; c < ch; ++c) output[frame * ch + c] *= e;
            state->env += state->env_step;
            if (state->env >= 1.0f) { state->env = 1.0f; state->env_step = 0.0f; }
            else if (state->env <= 0.0f) {
                state->env = 0.0f;
                if (state->stopping) {
                    state->is_active = false; state->env_step = 0.0f; state->stopping = false;
                    // Zero the remainder of the buffer after the fade-out.
                    memset(&output[frame * ch], 0, (frame_count - frame) * ch * sizeof(float));
                    break;
                }
            }
        }
    }
}

} // extern "C"

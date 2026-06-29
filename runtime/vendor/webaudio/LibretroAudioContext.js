// LibretroAudioContext — realtime AudioContext whose sink is a frame-locked
// pull: the core asks for exactly sampleRate/fps frames per retro_run.
// Modeled on WasmOfflineAudioContext (same engine, no SDL device).

import { WasmAudioEngine, NativeAudioDecoders, nativeDeinterleave } from './NativeAudioEngine.js';
import { AudioDestinationNode } from './javascript/nodes/AudioDestinationNode.js';
import { GainNode } from './javascript/nodes/GainNode.js';
import { OscillatorNode } from './javascript/nodes/OscillatorNode.js';
import { AudioBufferSourceNode } from './javascript/nodes/AudioBufferSourceNode.js';
import { BiquadFilterNode } from './javascript/nodes/BiquadFilterNode.js';
import { DelayNode } from './javascript/nodes/DelayNode.js';
import { WaveShaperNode } from './javascript/nodes/WaveShaperNode.js';
import { ChannelMergerNode } from './javascript/nodes/ChannelMergerNode.js';
import { ChannelSplitterNode } from './javascript/nodes/ChannelSplitterNode.js';
import { ConvolverNode } from './javascript/nodes/ConvolverNode.js';
import { DynamicsCompressorNode } from './javascript/nodes/DynamicsCompressorNode.js';
import { StereoPannerNode } from './javascript/nodes/StereoPannerNode.js';
import { AnalyserNode } from './javascript/nodes/AnalyserNode.js';
import { IIRFilterNode } from './javascript/nodes/IIRFilterNode.js';
import { PannerNode } from './javascript/nodes/PannerNode.js';
import { ConstantSourceNode } from './javascript/nodes/ConstantSourceNode.js';
import { AudioBuffer } from './javascript/AudioBuffer.js';

// Route AudioBuffer's lazy de-interleave (getChannelData) through the engine's
// native (SIMD/scalar) deinterleave instead of a JS per-sample loop.
AudioBuffer._deinterleave = nativeDeinterleave;
import { AudioListener } from './javascript/AudioListener.js';
import { PeriodicWave } from './javascript/PeriodicWave.js';


const MAX_PULL_FRAMES = 4096;

export class LibretroAudioContext {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this._channels = 2;
    this.state = 'running';

    this._engine = new WasmAudioEngine(this._channels, 128 * 1000, this.sampleRate, true);

    const destNodeId = this._engine.createNode('destination');
    this.destination = new AudioDestinationNode(this, destNodeId);
    this.listener = new AudioListener(this);

    // The graph renders in 128-frame quanta. Asking _processGraph for a
    // non-multiple leaves the tail of the buffer unfilled (heap garbage =
    // full-scale noise). Render quantum-aligned into a FIFO, emit exact counts.
    this._quantum = 128;
    this._quantumBuf = new Float32Array(this._quantum * this._channels);
    this._fifo = new Float32Array((MAX_PULL_FRAMES + this._quantum) * 2 * this._channels);
    this._fifoLen = 0; // samples
    this._intBuf = new Int16Array(MAX_PULL_FRAMES * this._channels);
  }

  get currentTime() {
    return this._engine.getCurrentTime();
  }

  // Called by the bootstrap once per retro_run. Returns interleaved stereo
  // int16 (a view over a reused buffer — consume before the next pull).
  // Drain a fixed COPY BUDGET of deferred buffer registration per tick (see
  // decodeAudioData). The cost of registerBuffer is a memcpy of the interleaved
  // PCM into the engine heap; a multi-minute music track is ~125MB → 12-26ms,
  // which alone blows a 16ms frame. So copy at most SLICE_FLOATS per tick via the
  // incremental native path, spreading even a single huge track across several
  // frames → no frame ever hitches. A track is only marked registered once its
  // LAST slice lands; until then start() falls back to a full lazy registerBuffer
  // (rare — music doesn't play in the first second), so audio is never delayed.
  _drainRegistrationQueue() {
    const q = this._registerQueue;
    if (!q || q.length === 0) return;
    // ~2MB/tick (512K floats): ~1-2ms of memcpy, comfortably under frame budget.
    const SLICE_FLOATS = 512 * 1024;
    const buf = q[0];
    const key = `${buf._id}:${this.sampleRate}`;
    if (this._registeredBuffers.has(key)) { q.shift(); return; }  // done lazily already
    try {
      const data = buf._getInterleavedData();
      const total = data.length;                 // floats = frames*channels
      let off = buf._regOffset || 0;
      const slice = Math.min(SLICE_FLOATS, total - off);
      this._engine.registerBufferChunk(buf._id, data, off, slice, total,
        buf.length, buf.numberOfChannels);
      off += slice;
      buf._regOffset = off;
      if (off >= total) {                        // final slice landed → usable
        this._registeredBuffers.add(key);
        q.shift();
      }
    } catch (_) { q.shift(); /* fall back to lazy registration on first play */ }
  }

  pullFrames(numFrames) {
    this._drainRegistrationQueue();
    if (numFrames > MAX_PULL_FRAMES) numFrames = MAX_PULL_FRAMES;
    const ch = this._channels;
    const need = numFrames * ch;
    while (this._fifoLen < need) {
      this._engine.renderBlock(this._quantumBuf, this._quantum);
      this._fifo.set(this._quantumBuf, this._fifoLen);
      this._fifoLen += this._quantum * ch;
    }
    const i16 = this._intBuf.subarray(0, need);
    for (let i = 0; i < need; i++) {
      const v = this._fifo[i];
      i16[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : (v * 32767) | 0;
    }
    this._fifo.copyWithin(0, need, this._fifoLen);
    this._fifoLen -= need;
    return i16;
  }

  createOscillator(o) { return new OscillatorNode(this, o); }
  createGain(o) { return new GainNode(this, o); }
  createBufferSource(o) { return new AudioBufferSourceNode(this, o); }
  createBiquadFilter(o) { return new BiquadFilterNode(this, o); }
  createDelay(maxDelayTime) {
    const o = typeof maxDelayTime === 'number' ? { maxDelayTime } : maxDelayTime;
    return new DelayNode(this, o);
  }
  createWaveShaper(o) { return new WaveShaperNode(this, o); }
  createStereoPanner(o) { return new StereoPannerNode(this, o); }
  createConstantSource(o) { return new ConstantSourceNode(this, o); }
  createConvolver(o) { return new ConvolverNode(this, o); }
  createDynamicsCompressor(o) { return new DynamicsCompressorNode(this, o); }
  createAnalyser(o) { return new AnalyserNode(this, o); }
  createIIRFilter(ff, fb) { return new IIRFilterNode(this, { feedforward: ff, feedback: fb }); }
  createPanner(o) { return new PannerNode(this, o); }
  createChannelMerger(n) { return new ChannelMergerNode(this, { numberOfInputs: n }); }
  createChannelSplitter(n) { return new ChannelSplitterNode(this, { numberOfOutputs: n }); }
  createPeriodicWave(real, imag, constraints) { return new PeriodicWave(this, { real, imag, ...constraints }); }
  createBuffer(channels, length, sampleRate) {
    return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
  }

  async decodeAudioData(audioData, successCallback, errorCallback) {
    try {
      const decoded = await NativeAudioDecoders.decode(null, audioData, this.sampleRate);
      const audioBuffer = new AudioBuffer({
        length: decoded.length,
        numberOfChannels: decoded.channels,
        sampleRate: this.sampleRate,
      });
      // The decoder already returns interleaved float — adopt it directly instead
      // of a per-sample de-interleave loop. For multi-minute tracks that loop was
      // tens of millions of iterations on the main thread (the source of the
      // startup / boss-music fps stalls); the engine wants interleaved anyway, so
      // the de-interleave + later re-interleave were pure wasted work. _channels
      // stay lazy (only built if the game reads getChannelData).
      audioBuffer._setInterleavedBuffer(decoded.audioData);

      // Eagerly upload the decoded PCM into the engine NOW, while we're still in
      // the game's async load phase (loading screen / pre-gameloop await), rather
      // than lazily on the first start() of this buffer. registerBuffer does a
      // _malloc + full copy of the interleaved PCM into the WASM heap — for a
      // multi-minute music track that's tens of MB, ~20-30ms of work. Deferring it
      // to first play means that copy lands DURING gameplay (level/boss music
      // start) -> a one-frame stall -> the early-game fps dips. Doing it here moves
      // the cost to load time where it's invisible. We reuse the SAME dedupe set +
      // key that AudioBufferSourceNode.start() checks, so first play finds the
      // buffer already registered and skips straight to setNodeBufferId — no double
      // upload, no behavior change, just earlier. Best-effort: never let a
      // pre-registration error break decode.
      // Pre-register the decoded PCM into the engine heap so first play() is
      // instant — but DEFER it, one buffer per audio tick, instead of doing it
      // inline here. registerBuffer is a malloc + full memcpy of the interleaved
      // PCM into the WASM heap; for a multi-minute music track that's ~125MB and
      // 12-26ms of MAIN-THREAD work. The game decodes 8 tracks at boot, so doing
      // them all inline bunches ~150ms of copies onto a handful of boot frames →
      // visibly slow startup (measured: 2.5s of 22-32ms frames on Bazzite). Queue
      // them instead and drain one per pullFrames() (§ _drainRegistrationQueue);
      // spread over ~8 frames the cost is invisible, and music doesn't play in the
      // first second anyway so "registered before first play" still holds. start()
      // still lazily registers on the same dedupe key if a buffer is played before
      // its turn — so nothing is ever unregistered at play time.
      if (!this._registeredBuffers) this._registeredBuffers = new Set();
      if (!this._registerQueue) this._registerQueue = [];
      const key = `${audioBuffer._id}:${this.sampleRate}`;
      if (!this._registeredBuffers.has(key)) this._registerQueue.push(audioBuffer);

      if (successCallback) successCallback(audioBuffer);
      return audioBuffer;
    } catch (err) {
      if (errorCallback) errorCallback(err);
      throw err;
    }
  }

  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() {
    this.state = 'closed';
    if (this._engine) this._engine.destroy();
  }
}

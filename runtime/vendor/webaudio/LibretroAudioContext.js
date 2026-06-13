// LibretroAudioContext — realtime AudioContext whose sink is a frame-locked
// pull: the core asks for exactly sampleRate/fps frames per retro_run.
// Modeled on WasmOfflineAudioContext (same engine, no SDL device).

import { WasmAudioEngine } from './wasm-integration/WasmAudioEngine.js';
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
import { AudioListener } from './javascript/AudioListener.js';
import { PeriodicWave } from './javascript/PeriodicWave.js';
import { WasmAudioDecoders } from './wasm-integration/WasmAudioDecoders.js';

const MAX_PULL_FRAMES = 4096;

export class LibretroAudioContext {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this._channels = 2;
    this.state = 'running';

    this._engine = new WasmAudioEngine(this._channels, 0, this.sampleRate, true);

    const destNodeId = this._engine.createNode('destination');
    this.destination = new AudioDestinationNode(this, destNodeId);
    this.listener = new AudioListener(this);

    this._floatBuf = new Float32Array(MAX_PULL_FRAMES * this._channels);
    this._intBuf = new Int16Array(MAX_PULL_FRAMES * this._channels);
  }

  get currentTime() {
    return this._engine.getCurrentTime();
  }

  // Called by the bootstrap once per retro_run. Returns interleaved stereo
  // int16 (a view over a reused buffer — consume before the next pull).
  pullFrames(numFrames) {
    if (numFrames > MAX_PULL_FRAMES) numFrames = MAX_PULL_FRAMES;
    const n = numFrames * this._channels;
    const f32 = this._floatBuf.subarray(0, n);
    this._engine.renderBlock(f32, numFrames);
    const i16 = this._intBuf.subarray(0, n);
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      i16[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : (v * 32767) | 0;
    }
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
      const decoded = await WasmAudioDecoders.decode(this._engine.wasmModule, audioData, this.sampleRate);
      const audioBuffer = new AudioBuffer({
        length: decoded.length,
        numberOfChannels: decoded.channels,
        sampleRate: this.sampleRate,
      });
      for (let ch = 0; ch < decoded.channels; ch++) {
        const channelData = audioBuffer._channels[ch];
        for (let frame = 0; frame < decoded.length; frame++) {
          channelData[frame] = decoded.audioData[frame * decoded.channels + ch];
        }
      }
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

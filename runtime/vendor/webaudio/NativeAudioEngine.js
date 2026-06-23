// NativeAudioEngine — same interface as WasmAudioEngine, backed by the
// jsgame_audio linked binding (engine compiled natively into the core).
// Exotic surfaces (analyser reads, worklets, capture) warn-stub for now.

const native = process._linkedBinding('jsgame_audio');

// Must match PARAM_* in audio_graph_simple.cpp (and WasmAudioEngine.js).
const PARAM_ID_MAP = {
  frequency: 0,
  detune: 1,
  gain: 2,
  Q: 3,
  delayTime: 4,
  pan: 5,
  offset: 6,
  type: 7,
  playbackOffset: 8,
  playbackDuration: 9,
  loop: 10,
  loopStart: 11,
  loopEnd: 12,
  playbackRate: 13,
};

let warned = new Set();
function stubWarn(name) {
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`NativeAudioEngine: ${name} not implemented yet`);
  }
}

export class WasmAudioEngine {
  constructor(numberOfChannels, length, sampleRate, isRealtime = false) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.graphId = native.createGraph(sampleRate, numberOfChannels, 128, isRealtime ? 1 : 0);
    this.initialized = true;
  }

  createNode(type) {
    return native.createNode(this.graphId, type);
  }
  connectNodes(sourceId, destId, sourceOutput = 0, destInput = 0) {
    native.connectNodes(this.graphId, sourceId, destId, sourceOutput, destInput);
  }
  disconnectNodes(sourceId, destId, output = 0) {
    native.disconnectNodes(this.graphId, sourceId, destId);
  }
  connectToParam() { stubWarn('connectToParam'); }
  disconnectFromParam() { stubWarn('disconnectFromParam'); }
  disconnectOutput() { stubWarn('disconnectOutput'); }

  setNodeParameter(nodeId, paramName, value) {
    const paramId = PARAM_ID_MAP[paramName];
    if (paramId === undefined) {
      stubWarn('param:' + paramName);
      return;
    }
    native.setNodeParameter(this.graphId, nodeId, paramId, value);
  }
  // AudioParam automation. Every method (setValueAtTime / linearRamp / expoRamp /
  // setTarget / setValueCurve / cancel*) routes here as:
  //   (nodeId, paramName, KIND, value, time, extra)
  // We push the event onto the native param TIMELINE so it actually changes over
  // time (envelopes, sweeps). Earlier this applied the value immediately, which
  // collapsed a multi-point envelope to its last point (e.g. a 0→1→0 gain fade
  // ended at 0 = silence).
  scheduleParameterValue(nodeId, paramName, kind, value, time, extra) {
    const paramId = PARAM_ID_MAP[paramName];
    if (paramId === undefined) { stubWarn('param:' + paramName); return; }
    // kind int for native: 0 setValue, 1 linearRamp, 2 expoRamp, 3 setTarget,
    // 4 cancelScheduledValues/cancelAndHoldAtTime.
    let k;
    switch (kind) {
      case 'setValueAtTime': k = 0; break;
      case 'linearRampToValueAtTime': k = 1; break;
      case 'exponentialRampToValueAtTime': k = 2; break;
      case 'setTargetAtTime': k = 3; break;
      case 'cancelScheduledValues':
      case 'cancelAndHoldAtTime':
        // value carries the cancel TIME for these (AudioParam passes (… , cancelTime)).
        native.scheduleParamEvent(this.graphId, nodeId, paramId, 4, 0, value, 0);
        return;
      case 'setValueCurveAtTime':
        // Approximate a value curve as a sequence of setValueAtTime points across
        // [time, time+duration]. value=array, time=start, extra=duration.
        if (Array.isArray(value) && value.length > 0 && extra > 0) {
          const n = value.length, dur = extra;
          for (let i = 0; i < n; i++) {
            const tt = time + (dur * i) / (n - 1 || 1);
            native.scheduleParamEvent(this.graphId, nodeId, paramId, 0, value[i], tt, 0);
          }
        }
        return;
      default: k = 0; break;
    }
    const tc = (kind === 'setTargetAtTime') ? (extra || 0) : 0;
    native.scheduleParamEvent(this.graphId, nodeId, paramId, k, value, time, tc);
  }

  setNodeProperty(nodeId, propName, value) {
    this.setNodeParameter(nodeId, propName, value);
  }
  setNodeStringProperty() { stubWarn('setNodeStringProperty'); }

  startNode(nodeId, when = 0) {
    native.startNode(this.graphId, nodeId, when);
  }
  stopNode(nodeId, when = 0) {
    native.stopNode(this.graphId, nodeId, when);
  }

  setNodeBuffer(nodeId, bufferData, length, channels) {
    native.setNodeBuffer(this.graphId, nodeId, bufferData, length, channels);
  }
  registerBuffer(bufferId, bufferData, length, channels) {
    native.registerBuffer(this.graphId, bufferId, bufferData, length, channels);
  }
  setNodeBufferId(nodeId, bufferId) {
    native.setNodeBufferId(this.graphId, nodeId, bufferId);
  }

  renderBlock(outputArray, frameCount) {
    native.processGraph(this.graphId, outputArray, frameCount);
  }
  getCurrentTime() {
    return native.getCurrentTime(this.graphId);
  }
  setCurrentTime(t) {
    native.setCurrentTime(this.graphId, t);
  }

  setPeriodicWave() { stubWarn('setPeriodicWave'); }
  setWaveShaperCurve() { stubWarn('setWaveShaperCurve'); }
  setWaveShaperOversample() { stubWarn('setWaveShaperOversample'); }
  clearWaveShaperCurve() { stubWarn('clearWaveShaperCurve'); }
  setIIRFilterCoefficients() { stubWarn('setIIRFilterCoefficients'); }
  setAnalyserFFTSize() { stubWarn('analyser'); }
  setAnalyserSmoothingTimeConstant() { stubWarn('analyser'); }
  setAnalyserMinDecibels() { stubWarn('analyser'); }
  setAnalyserMaxDecibels() { stubWarn('analyser'); }
  getFloatTimeDomainData() { stubWarn('analyser'); }
  getFloatFrequencyData() { stubWarn('analyser'); }
  getByteTimeDomainData() { stubWarn('analyser'); }
  getByteFrequencyData() { stubWarn('analyser'); }
  getCompressorReduction() { return 0; }
  getIIRFilterFrequencyResponse() { stubWarn('iir'); }
  setWorkletProcessCallback() { stubWarn('worklet'); }
  addWorkletParameter() { stubWarn('worklet'); }
  startAudioCapture() { stubWarn('capture'); }
  stopAudioCapture() { stubWarn('capture'); }
  getInputDevices() { return []; }

  destroy() {
    if (this.initialized) {
      native.destroyGraph(this.graphId);
      this.initialized = false;
    }
  }
}

export const NativeAudioDecoders = {
  async decode(_wasmModule, audioData, targetSampleRate) {
    const bytes = audioData instanceof ArrayBuffer ? new Uint8Array(audioData)
      : ArrayBuffer.isView(audioData) ? new Uint8Array(audioData.buffer, audioData.byteOffset, audioData.byteLength)
      : null;
    if (!bytes) throw new Error('decodeAudioData: expected ArrayBuffer');
    // native.decode now returns a Promise — the decode + resample run on libnode's
    // libuv thread pool so this does NOT block the game loop (browser-accurate).
    const decoded = await native.decode(bytes, targetSampleRate || 0);
    if (!decoded) throw new Error('decodeAudioData: unsupported or corrupt audio');
    return { audioData: decoded.data, channels: decoded.channels, length: decoded.length, sampleRate: decoded.sampleRate };
  },
};

// Native (SIMD/scalar) interleaved→planar split, for AudioBuffer.getChannelData.
// Splits `interleaved` into channel-concatenated `planar` ([c0..., c1..., ...]).
export function nativeDeinterleave(interleaved, planar, frames, channels) {
  native.deinterleave(interleaved, planar, frames, channels);
}

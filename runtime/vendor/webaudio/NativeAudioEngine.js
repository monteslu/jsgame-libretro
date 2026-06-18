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
  // AudioParam.setValueAtTime calls this as (nodeId, paramName, kind, value,
  // startTime) — note the KIND string ('setValueAtTime') is arg 3, the VALUE is
  // arg 4. The old signature named arg 3 'value', so the oscillator frequency was
  // set to the string 'setValueAtTime' (= NaN/0) → silent oscillators. We don't
  // model the automation timeline; apply the value immediately so setValueAtTime
  // code is audible.
  // Used by setValueAtTime AND all the ramp/target methods (same call shape).
  scheduleParameterValue(nodeId, paramName, kind, value /*, startTime */) {
    this.setNodeParameter(nodeId, paramName, value);
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
    const decoded = native.decode(bytes, targetSampleRate || 0);
    if (!decoded) throw new Error('decodeAudioData: unsupported or corrupt audio');
    return { audioData: decoded.data, channels: decoded.channels, length: decoded.length, sampleRate: decoded.sampleRate };
  },
};

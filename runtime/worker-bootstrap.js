// worker-bootstrap.js — entry for game Web Workers. The game never sees
// worker_threads; this builds a curated worker-global surface and runs the
// game's worker script in a vm context. (S3 spike proved worker_threads +
// linked bindings work under the embedded environment.)
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const io = process._linkedBinding('jsgame_io');
const log = (...a) => io.log(1, '[worker] ' + a.join(' '));
const logErr = (...a) => io.log(3, '[worker] ' + a.join(' '));

// Read the worker script (dir mode; zip workers resolve via the script text
// passed in workerData.source when present).
let source = workerData.source;
if (!source && workerData.gameRoot) {
  try {
    source = fs.readFileSync(path.join(workerData.gameRoot, workerData.script), 'utf8');
  } catch (e) {
    logErr('cannot read worker script ' + workerData.script + ': ' + e.message);
  }
}
if (!source) {
  logErr('no worker source');
  return;
}

// Curated worker globals: DedicatedWorkerGlobalScope surface, no DOM/canvas.
const sandbox = {
  self: null,
  postMessage: (data, transfer) => parentPort.postMessage(data, transfer),
  onmessage: null,
  onerror: null,
  close: () => process.exit(0),
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000, timeOrigin: 0 },
  console: {
    log: (...a) => log(a.map(String).join(' ')),
    info: (...a) => log(a.map(String).join(' ')),
    warn: (...a) => io.log(2, '[worker] ' + a.map(String).join(' ')),
    error: (...a) => logErr(a.map(String).join(' ')),
    debug: () => {},
  },
  WebAssembly,
  TextEncoder, TextDecoder, URL, URLSearchParams,
  structuredClone,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  SharedArrayBuffer, Atomics,
  addEventListener: (type, fn) => { if (type === 'message') sandbox.onmessage = fn; if (type === 'error') sandbox.onerror = fn; },
  removeEventListener: () => {},
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox, { name: 'jsg-worker' });

parentPort.on('message', (data) => {
  const ev = { data, type: 'message' };
  if (typeof sandbox.onmessage === 'function') {
    try { sandbox.onmessage(ev); } catch (e) { logErr('onmessage: ' + e.stack || e.message); }
  }
});

try {
  // Worker scripts are classic by default; run as script (importScripts/ESM
  // workers are a later nicety).
  new vm.Script(source, { filename: 'jsg-worker://' + (workerData.script || 'inline') }).runInContext(context);
} catch (e) {
  logErr('worker script failed: ' + (e.stack || e.message));
  if (typeof sandbox.onerror === 'function') sandbox.onerror({ message: e.message });
}

// worker-module-bootstrap.mjs — bootstrap for a module Worker spawned by the
// realm's GameWorker. Two distinct kinds run through here (JSG_WORKER_KIND):
//
//   'plain'      — game code did `new Worker('./worker.js')`. It uses the BROWSER
//                  Worker API: self.onmessage / self.postMessage / addEventListener.
//                  We must provide that surface, bridged to parentPort, or the
//                  worker's messages go nowhere (the bug: worker never replied).
//
//   'em-pthread' — an emscripten wasm pthread (e.g. box2d3 deluxe). Emscripten's
//                  glue created this Worker itself with workerData:'em-pthread'.
//                  In Node mode it talks to worker_threads.parentPort DIRECTLY and
//                  wires its own messaging — so we DON'T shim a browser surface
//                  (doing so confused its env detection). Just import + step aside.
//
// SECURITY: the boundary is the MAIN realm thread (game code runs there in a
// browser sandbox, no process/fs). This worker runs trusted, bundled game/wasm
// code; it cannot reach or weaken the main realm's sandbox.
//
// Module URL + name come via env (the worker may be launched with
// workerData==='em-pthread', the string emscripten checks for ENVIRONMENT_IS_PTHREAD).
import { parentPort } from 'node:worker_threads';

const moduleUrl = process.env.JSG_WORKER_MODULE;
const kind = process.env.JSG_WORKER_KIND || 'plain';
// emscripten also checks self.name?.startsWith('em-pthread'); set it.
try { globalThis.name = process.env.JSG_WORKER_NAME || (kind === 'em-pthread' ? 'em-pthread' : 'worker'); } catch {}

function reportError(e) {
  try { parentPort.postMessage({ cmd: '__jsg_worker_error', message: String((e && e.stack) || e) }); } catch {}
}

if (kind === 'em-pthread') {
  // Emscripten wires parentPort itself. Just run the module.
  import(moduleUrl).catch(reportError);
} else {
  // Plain game worker: present the browser Worker surface bridged to parentPort.
  // `self` is the worker global; postMessage(data) -> parent; parent messages ->
  // onmessage + addEventListener('message') listeners as a { data } event.
  const msgListeners = [];
  const dispatchMessage = (data) => {
    const ev = { data, type: 'message' };
    const handler = globalThis.onmessage;
    if (typeof handler === 'function') { try { handler(ev); } catch (e) { reportError(e); } }
    for (const fn of msgListeners) { try { fn(ev); } catch (e) { reportError(e); } }
  };
  try {
    globalThis.self = globalThis;
    globalThis.postMessage = (data, _transfer) => parentPort.postMessage(data);
    globalThis.onmessage = null;
    globalThis.onmessageerror = null;
    globalThis.addEventListener = (type, fn) => {
      if (type === 'message') msgListeners.push(fn);
    };
    globalThis.removeEventListener = (type, fn) => {
      if (type === 'message') { const i = msgListeners.indexOf(fn); if (i >= 0) msgListeners.splice(i, 1); }
    };
    globalThis.close = () => { try { parentPort.close(); } catch {} };
    parentPort.on('message', dispatchMessage);
  } catch (e) { reportError(e); }

  import(moduleUrl).catch(reportError);
}

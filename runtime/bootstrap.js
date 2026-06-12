// bootstrap.js — privileged runtime bootstrap (S2 spike scope)
// Loaded by node_host.cpp via createRequire. Full Node available HERE only;
// the game realm (later) sees curated globals.

const io = process._linkedBinding('jsgame_io');
const canvasBinding = process._linkedBinding('canvas');

const log = (...args) => io.log(1, args.join(' '));
const logErr = (...args) => io.log(3, args.join(' '));

process.on('uncaughtException', (err) => {
  logErr('uncaughtException:', err && err.stack ? err.stack : String(err));
});

log('bootstrap: content=' + globalThis.__jsg_paths.content);
log('bootstrap: canvas binding keys: ' + Object.keys(canvasBinding).slice(0, 8).join(','));

const WIDTH = 640;
const HEIGHT = 480;

// S2: drive @napi-rs/canvas via the linked binding directly.
const canvas = new canvasBinding.CanvasElement(WIDTH, HEIGHT);
const ctx = canvas.getContext('2d');

// canvas.data() returns raw surface bytes. Skia N32 on little-endian is BGRA
// premultiplied, which matches libretro XRGB8888 byte order (B,G,R,X) for
// opaque pixels — verify with the color bars below (PLAN risk #10).
let frame = 0;

globalThis.__jsg_frame = () => {
  frame++;

  // Background
  ctx.fillStyle = '#202030';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Diagnostic color bars: must show RED, GREEN, BLUE left-to-right.
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(40, 40, 120, 80);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(200, 40, 120, 80);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(360, 40, 120, 80);

  // Moving box proves per-frame rendering
  const x = (frame * 3) % (WIDTH - 60);
  ctx.fillStyle = '#ffcc00';
  ctx.fillRect(x, 200, 60, 60);

  // Pad 0 button readout proves input path
  const pads = io.getPads();
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px sans-serif';
  ctx.fillText('jsgame S2  frame ' + frame, 40, 320);
  ctx.fillText('pad0 buttons: 0b' + (pads[0] >>> 0).toString(2).padStart(16, '0'), 40, 350);
  ctx.fillText('lx ' + pads[1] + '  ly ' + pads[2], 40, 380);

  const pixels = canvas.data();
  io.present(pixels, WIDTH, HEIGHT);
};

globalThis.__jsg_stop = () => {
  log('bootstrap: stop');
};

globalThis.__jsg_start = (contentPath) => {
  log('bootstrap: restart with ' + contentPath);
  frame = 0;
};

log('bootstrap: ready');

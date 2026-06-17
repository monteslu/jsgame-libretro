// gl-offscreen-2d — exercises the present-path fix: the game acquires a WebGL2
// context on an OFFSCREEN canvas (so the core requests + grants a GL context),
// but composites the final image onto the 2D DISPLAY canvas. The core must
// present the 2D raster (the bars), NOT the GL framebuffer.
const display = document.getElementById('gameCanvas');
const ctx = display.getContext('2d');
const { width, height } = display;

// Offscreen WebGL canvas — triggers GL detection (getContext('webgl2')) and
// uses the granted context, but is never the displayed surface.
const off = document.createElement('canvas');
off.width = 64; off.height = 64;
const gl = off.getContext('webgl2');
if (gl) {
  gl.clearColor(1, 0, 1, 1);   // magenta — would be wrong if presented
  gl.clear(gl.COLOR_BUFFER_BIT);
  console.log('offscreen webgl2 context acquired');
} else {
  console.log('no webgl2 context (still fine; 2D path is what we present)');
}

function gameLoop() {
  ctx.fillStyle = '#202030';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ff0000'; ctx.fillRect(40, 40, 120, 80);
  ctx.fillStyle = '#00ff00'; ctx.fillRect(200, 40, 120, 80);
  ctx.fillStyle = '#0000ff'; ctx.fillRect(360, 40, 120, 80);
  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);
console.log('gl-offscreen-2d booted');

// s2-demo — standard web game code (same surface as a jsgames demo).
// Renders the diagnostic bars test/harness.c asserts on.
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const { width, height } = canvas;

let frame = 0;

function gameLoop(time) {
  frame++;

  ctx.fillStyle = '#202030';
  ctx.fillRect(0, 0, width, height);

  // Diagnostic bars: must show RED, GREEN, BLUE left-to-right
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(40, 40, 120, 80);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(200, 40, 120, 80);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(360, 40, 120, 80);

  const x = (frame * 3) % (width - 60);
  ctx.fillStyle = '#ffcc00';
  ctx.fillRect(x, 200, 60, 60);

  const [p1] = navigator.getGamepads();
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px sans-serif';
  ctx.fillText('jsgame realm  frame ' + frame + '  t=' + time.toFixed(1), 40, 320);
  if (p1) {
    const pressed = p1.buttons.map((b, i) => (b.pressed ? i : null)).filter((v) => v !== null);
    ctx.fillText('pad0 std buttons: [' + pressed.join(',') + ']  lx=' + p1.axes[0].toFixed(3), 40, 350);
  }

  // localStorage round-trip proof
  localStorage.setItem('frames', String(frame));
  ctx.fillText('localStorage frames=' + localStorage.getItem('frames'), 40, 380);

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
console.log('s2-demo game booted');

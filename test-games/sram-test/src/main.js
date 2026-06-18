// SRAM / localStorage persistence test.
// Reads a launch counter from localStorage, increments it, writes it back.
// Each launch (or reset) the number goes up — proving localStorage is backed by
// libretro SRAM and persists across runs. The frontend saves SRAM to a .srm file.
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let launches = 0;
try {
  const stored = localStorage.getItem('launches');
  launches = stored ? parseInt(stored, 10) : 0;
  console.log('SRAM: read launches=' + launches);
} catch (e) {
  console.error('SRAM read failed: ' + e.message);
}
launches += 1;
try {
  localStorage.setItem('launches', String(launches));
  console.log('SRAM: wrote launches=' + launches);
} catch (e) {
  console.error('SRAM write failed: ' + e.message);
}

// Also store a timestamp-ish payload to verify multi-key + JSON survive.
try {
  const prev = localStorage.getItem('lastNote') || '(none)';
  console.log('SRAM: prev note=' + prev);
  localStorage.setItem('lastNote', 'launch#' + launches);
} catch {}

function loop() {
  ctx.fillStyle = '#102030';
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#fff';
  ctx.font = '32px sans-serif';
  ctx.fillText('SRAM launch count: ' + launches, 60, 220);
  ctx.font = '18px sans-serif';
  ctx.fillText('reset or reload -> number should increase', 60, 270);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

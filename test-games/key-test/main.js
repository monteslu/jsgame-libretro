const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let lastKey = 'none', downCount = 0;
window.addEventListener('keydown', (e) => { lastKey = e.key + '/' + e.code; downCount++; console.log('KEYDOWN ' + e.key + ' code=' + e.code); });
window.addEventListener('keyup', (e) => { console.log('KEYUP ' + e.key); });
let frame = 0;
function loop() {
  frame++;
  ctx.fillStyle = '#222'; ctx.fillRect(0,0,640,480);
  ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif';
  ctx.fillText('lastKey: ' + lastKey + '  downs: ' + downCount, 20, 240);
  if (frame === 20) console.log(downCount > 0 ? 'KEY OK' : 'KEY FAIL');
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

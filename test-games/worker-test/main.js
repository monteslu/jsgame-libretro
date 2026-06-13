const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const w = new Worker('./worker.js');
let result = null;
w.onmessage = (e) => { result = e.data; console.log('worker replied: ' + JSON.stringify(e.data)); };
w.postMessage(100000);
let frame = 0;
function loop() {
  frame++;
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif';
  ctx.fillText('worker result: ' + (result ? JSON.stringify(result) : 'pending'), 20, 240);
  if (frame === 180 && !result) console.error('WORKER FAIL: no reply by frame 50');
  if (frame === 180 && result) console.log('WORKER OK');
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

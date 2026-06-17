const canvas = document.getElementById('c');
const ctx2d = canvas.getContext('2d');
const ac = new AudioContext();
const osc = ac.createOscillator();
const gain = ac.createGain();
gain.gain.value = 0.5;
osc.frequency.value = 440;
osc.connect(gain);
gain.connect(ac.destination);
osc.start();
console.log('oscillator started, ctx state=' + ac.state);
function loop() {
  ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, 640, 480);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

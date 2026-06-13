const canvas = document.getElementById('c');
const ctx2d = canvas.getContext('2d');
const ac = new AudioContext();
let buf = null;
async function boot() {
  const resp = await fetch('sounds/tada.mp3');
  buf = await ac.decodeAudioData(await resp.arrayBuffer());
  console.log('decoded: ' + buf.duration.toFixed(2) + 's ' + buf.numberOfChannels + 'ch @' + buf.sampleRate);
  const play = () => {
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.onended = () => setTimeout(play, 300);
    src.start();
  };
  play();
}
boot();
function loop() {
  ctx2d.fillStyle = '#113311'; ctx2d.fillRect(0, 0, 640, 480);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

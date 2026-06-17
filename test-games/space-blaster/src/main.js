// space-blaster — a 3D Three.js space shooter. Fly the ship, blast the
// invaders. Dynamic lighting, emissive glow, explosion light-flashes.
// Delta-time movement (frame-rate independent). WebAudio SFX. Gamepad.
import * as THREE from 'three';

// ── TWO CANVASES ────────────────────────────────────────────────────────────
// 1) display canvas 'c' is 2D — it's what the frontend presents. Each frame we
//    blit the 3D render onto it (readPixels -> putImageData) and draw the HUD.
// 2) glCanvas is an offscreen WebGL canvas Three.js renders the 3D scene into.
const display = document.getElementById('c');
const W = display.width, H = display.height;
const hud = display.getContext('2d');

const glCanvas = document.createElement('canvas');
glCanvas.width = W; glCanvas.height = H;

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
renderer.setSize(W, H, false);
renderer.setClearColor(0x05070f, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;     // correct (brighter) output
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic; keeps glow controlled
renderer.toneMappingExposure = 1.6;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05070f, 0.01);        // lighter fog

const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
camera.position.set(0, 7, 16);
camera.lookAt(0, 1, -6);

// ── lighting (brighter) ──────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x6677aa, 1.8));
const key = new THREE.DirectionalLight(0xd8e4ff, 3.0);
key.position.set(5, 12, 10); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 1.2);
fill.position.set(-6, 4, 12); scene.add(fill);
const rimL = new THREE.PointLight(0x4499ff, 3.5, 90); rimL.position.set(-12, 6, -6); scene.add(rimL);
const rimR = new THREE.PointLight(0xff5599, 3.0, 90); rimR.position.set(12, 6, -6); scene.add(rimR);
// pool of explosion flash-lights (reused)
const flashes = [];
for (let i = 0; i < 5; i++) { const l = new THREE.PointLight(0xffaa33, 0, 30); scene.add(l); flashes.push({ light: l, life: 0 }); }
function flash(x, y, z, color) {
  const f = flashes.find(f => f.life <= 0) || flashes[0];
  f.light.color.setHex(color); f.light.position.set(x, y, z); f.light.intensity = 4; f.life = 0.35;
}

// ── starfield (points) ───────────────────────────────────────────────────────
{
  const g = new THREE.BufferGeometry();
  const N = 600, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { pos[i*3] = (Math.random()-0.5)*120; pos[i*3+1] = (Math.random()-0.5)*60; pos[i*3+2] = -Math.random()*180; }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x99bbff, size: 0.35, sizeAttenuation: true }));
  scene.add(stars);
  globalThis._stars = { mesh: stars, pos, N };
}

// ── ship hull texture (loaded via the engine's Image, wrapped in a THREE.Texture)
const hullTex = new THREE.Texture();
{
  const img = new Image();
  img.onload = () => { hullTex.image = img; hullTex.needsUpdate = true; };
  img.src = 'hull.png';
}
hullTex.colorSpace = THREE.SRGBColorSpace;

// ── player ship: a TEXTURED lit cone with an emissive cockpit + engine glow ──
const ship = new THREE.Group();
const hull = new THREE.Mesh(
  new THREE.ConeGeometry(0.9, 2.6, 5),
  new THREE.MeshStandardMaterial({ map: hullTex, color: 0xffffff, metalness: 0.6, roughness: 0.35, emissive: 0x0a1a2a })
);
hull.rotation.x = -Math.PI / 2; ship.add(hull);
const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 16),
  new THREE.MeshStandardMaterial({ color: 0x99eeff, emissive: 0x33aacc, emissiveIntensity: 1.4 }));
cockpit.position.set(0, 0.1, 0.2); ship.add(cockpit);
const engine = new THREE.PointLight(0x44ccff, 1.2, 8); engine.position.set(0, 0, 1.4); ship.add(engine);
ship.position.set(0, 0.5, 6); scene.add(ship);

// ── shared geometries/materials ─────────────────────────────────────────────
const boltGeo = new THREE.CapsuleGeometry(0.12, 0.6, 4, 8);
const boltMat = new THREE.MeshStandardMaterial({ color: 0xffee66, emissive: 0xffcc22, emissiveIntensity: 2 });
const enemyGeo = new THREE.IcosahedronGeometry(0.9, 0);
// ONE shared enemy material (creating a new/cloned material per enemy compiles a
// fresh shader each time -> hundreds of GPU shader compiles -> freeze).
const enemyMat = new THREE.MeshStandardMaterial({ color: 0xff4466, metalness: 0.4, roughness: 0.3, emissive: 0x330011, flatShading: true });
const partGeo = new THREE.TetrahedronGeometry(0.22);
// shared particle materials per color (NOT one per particle)
const partMatGold = new THREE.MeshStandardMaterial({ color: 0xffaa33, emissive: 0xffaa33, emissiveIntensity: 1.5 });
const partMatRed  = new THREE.MeshStandardMaterial({ color: 0xff3344, emissive: 0xff3344, emissiveIntensity: 1.5 });

// ── audio ────────────────────────────────────────────────────────────────────
const ac = new AudioContext();
const SFX = {};
async function load(n, f) { try { SFX[n] = await ac.decodeAudioData(await fetch('./sounds/' + f).then(r => r.arrayBuffer())); } catch (e) { console.log('sfx ' + f + ': ' + e.message); } }
function play(n, vol) { const b = SFX[n]; if (!b) return; const s = ac.createBufferSource(), g = ac.createGain(); g.gain.value = vol || 0.4; s.buffer = b; s.connect(g); g.connect(ac.destination); s.start(); s.onended = () => { s.disconnect(); g.disconnect(); }; }
Promise.all([load('shoot', 'laser.mp3'), load('boom', 'explosion.mp3'), load('hit', 'hit.mp3')]).then(() => console.log('sfx loaded'));

// ── state ────────────────────────────────────────────────────────────────────
let bolts = [], enemies = [], parts = [];
let score = 0, lives = 3, spawn = 0, cool = 0, gameOver = false, t = 0;

// ── input ────────────────────────────────────────────────────────────────────
const keys = Object.create(null);
window.addEventListener('keydown', e => keys[e.code] = true);
window.addEventListener('keyup', e => keys[e.code] = false);
function input() {
  let x = 0, fire = false, restart = false;
  const gp = (navigator.getGamepads && navigator.getGamepads())[0];
  if (gp) {
    if (Math.abs(gp.axes[0]) > 0.15) x += gp.axes[0];
    if (gp.buttons[14]?.pressed) x -= 1;
    if (gp.buttons[15]?.pressed) x += 1;
    fire = gp.buttons[0]?.pressed || gp.buttons[7]?.pressed;
    restart = gp.buttons[9]?.pressed;
  }
  if (keys.ArrowLeft) x -= 1;
  if (keys.ArrowRight) x += 1;
  if (keys.Space) fire = true;
  if (keys.Enter) restart = true;
  return { x: Math.max(-1, Math.min(1, x)), fire, restart };
}

function spawnEnemy() {
  const m = new THREE.Mesh(enemyGeo, enemyMat);
  m.position.set((Math.random()*2-1)*11, 0.5, -70);
  m.userData = { vz: 14 + Math.random()*10 + score*0.3, sway: Math.random()*6, amp: 1.5 + Math.random()*2, spin: Math.random()*2 };
  scene.add(m); enemies.push(m);
}
function explode(x, y, z, color) {
  flash(x, y, z, color);
  const pmat = color === 0xff3344 ? partMatRed : partMatGold;
  for (let i = 0; i < 12; i++) {
    const p = new THREE.Mesh(partGeo, pmat);
    p.position.set(x, y, z);
    p.userData = { v: new THREE.Vector3((Math.random()-0.5), (Math.random()-0.5), (Math.random()-0.5)).multiplyScalar(8 + Math.random()*6), life: 0.6 };
    scene.add(p); parts.push(p);
  }
}
function reset() {
  for (const e of enemies) scene.add(e), scene.remove(e); enemies = [];
  for (const b of bolts) scene.remove(b); bolts = [];
  for (const p of parts) scene.remove(p); parts = [];
  score = 0; lives = 3; gameOver = false; ship.position.x = 0;
}

function update(dt) {
  t += dt;
  const inp = input();
  if (gameOver) { if (inp.restart) { reset(); play('shoot'); } return; }

  // ship — 14 units/sec
  ship.position.x = Math.max(-12, Math.min(12, ship.position.x + inp.x * 14 * dt));
  ship.rotation.z = -inp.x * 0.4;           // bank
  ship.rotation.y = inp.x * 0.15;
  cockpit.material.emissiveIntensity = 1.2 + Math.sin(t * 8) * 0.3;
  // camera eases to follow
  camera.position.x += (ship.position.x * 0.5 - camera.position.x) * Math.min(1, dt * 4);
  camera.lookAt(ship.position.x * 0.3, 1, -8);

  // shoot
  cool -= dt;
  if (inp.fire && cool <= 0) {
    const b = new THREE.Mesh(boltGeo, boltMat);
    b.position.copy(ship.position); b.position.z -= 1; b.rotation.x = Math.PI/2;
    b.userData = { vz: -60 }; scene.add(b); bolts.push(b);
    cool = 0.16; play('shoot', 0.35);
  }
  // bolts
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i]; b.position.z += b.userData.vz * dt;
    if (b.position.z < -75) { scene.remove(b); bolts.splice(i, 1); }
  }

  // spawn
  spawn -= dt;
  if (spawn <= 0) { spawnEnemy(); spawn = Math.max(0.4, 1.3 - score * 0.02); }

  // enemies
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i], u = e.userData;
    u.sway += 2 * dt;
    e.position.z += u.vz * dt;
    e.position.x += Math.cos(u.sway) * u.amp * dt;
    e.rotation.x += u.spin * dt; e.rotation.y += u.spin * 1.3 * dt;
    // hit by bolt?
    let killed = false;
    for (let j = bolts.length - 1; j >= 0; j--) {
      if (bolts[j].position.distanceToSquared(e.position) < 1.6) { scene.remove(bolts[j]); bolts.splice(j, 1); killed = true; break; }
    }
    if (killed) { explode(e.position.x, e.position.y, e.position.z, 0xffaa33); scene.remove(e); enemies.splice(i, 1); score++; play('boom', 0.5); continue; }
    // reached player?
    if (e.position.z > 7) {
      if (Math.abs(e.position.x - ship.position.x) < 1.6) explode(ship.position.x, 0.5, 6, 0xff3344);
      scene.remove(e); enemies.splice(i, 1); lives--; play('hit', 0.6);
      if (lives <= 0) gameOver = true;
    }
  }

  // particles
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i], u = p.userData;
    p.position.addScaledVector(u.v, dt);
    u.v.multiplyScalar(1 - dt * 2);
    u.life -= dt;
    p.scale.setScalar(Math.max(0.01, u.life * 1.6));
    if (u.life <= 0) { scene.remove(p); parts.splice(i, 1); }
  }

  // flash lights decay
  for (const f of flashes) { if (f.life > 0) { f.life -= dt; f.light.intensity = Math.max(0, f.life * 12); } }

  // scroll stars toward camera, recycle
  const sp = globalThis._stars;
  for (let i = 0; i < sp.N; i++) {
    sp.pos[i*3+2] += 30 * dt;
    if (sp.pos[i*3+2] > 12) { sp.pos[i*3+2] = -180; sp.pos[i*3] = (Math.random()-0.5)*120; }
  }
  sp.mesh.geometry.attributes.position.needsUpdate = true;
  engine.intensity = 1.0 + Math.random() * 0.6;  // engine flicker
}


// Composite the WebGL canvas onto the 2D display canvas, then HUD on top.
// This is the STANDARD web pattern: ctx2d.drawImage(webglCanvas). Works in any
// browser; the jsgame engine supports it by reading the GL canvas's pixels.
function compositeAndHUD() {
  // 1) render 3D into the WebGL canvas
  renderer.render(scene, camera);
  // 2) blit the WebGL canvas onto the 2D display — plain web drawImage
  hud.drawImage(glCanvas, 0, 0);
  // 3) draw the 2D HUD on top
  hud.fillStyle = '#cfe6ff'; hud.font = 'bold 26px sans-serif';
  hud.fillStyle = '#cfe6ff'; hud.font = 'bold 26px sans-serif';
  hud.fillText('SCORE ' + score, 16, 34);
  hud.fillStyle = '#ff6677'; hud.font = '26px sans-serif';
  hud.fillText('♥'.repeat(Math.max(0, lives)), W - 150, 34);
  hud.fillStyle = '#6688cc'; hud.font = '15px sans-serif';
  hud.fillText('Move: stick/dpad   Shoot: A / Space', 16, H - 14);
  if (gameOver) {
    hud.fillStyle = 'rgba(0,0,0,0.55)'; hud.fillRect(0, 0, W, H);
    hud.textAlign = 'center';
    hud.fillStyle = '#ff5a4a'; hud.font = 'bold 52px sans-serif'; hud.fillText('GAME OVER', W/2, H/2 - 16);
    hud.fillStyle = '#fff'; hud.font = '24px sans-serif';
    hud.fillText('Score: ' + score, W/2, H/2 + 24);
    hud.fillText('Start / Enter to play again', W/2, H/2 + 60);
    hud.textAlign = 'left';
  }
}

let frame = 0, _last = 0;
function loop(ts) {
  if (!_last) _last = ts || 0;
  let dt = ((ts || 0) - _last) / 1000; _last = ts || 0;
  if (!(dt > 0) || dt > 0.1) dt = 1/60;
  update(dt);
  compositeAndHUD();
  if (++frame === 30) console.log('SPACE-BLASTER OK score=' + score);
  requestAnimationFrame(loop);
}
console.log('space-blaster: Three.js r' + THREE.REVISION + ' booting (3D shooter, 2-canvas)');
requestAnimationFrame(loop);

/**

three-game — a playable 3D game on Three.js, running in a libretro core
(jsgame-libretro) AND in the browser unchanged.

Steer the glowing ship with the D-pad / left stick (or arrow keys); fly into
the spinning gems to score. Pure Three.js WebGL2.

Authoring model (matches simple-threejs-game-starter):
  - `three` is an npm dependency, imported by bare specifier.
  - Vite bundles it (`npm run build` -> dist/) for distribution; in dev,
    `npm run dev` serves it from node_modules.
  - Input is normalized through getInput() in utils.js, so the same code reads
    a browser gamepad and the libretro RetroPad (jsgame-libretro shims
    navigator.getGamepads() to a standard-mapped pad — D-pad on buttons 12-15,
    analog on axes 0-1).

**/

import * as THREE from 'three';
import { getInput } from './utils.js';

const canvas = document.getElementById('game-canvas');
const W = canvas.width, H = canvas.height;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(W, H, false);
renderer.setClearColor(0x05060f, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05060f, 0.035);

const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);
camera.position.set(0, 6, 10);
camera.lookAt(0, 0, 0);

// ── lights ────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x4060ff, 0.4));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(4, 8, 6);
scene.add(key);
const rim = new THREE.PointLight(0xff5080, 1.2, 40);
rim.position.set(-6, 4, -4);
scene.add(rim);

// ── ground grid for a sense of motion ──────────────────────────────────────
const grid = new THREE.GridHelper(60, 30, 0x2040a0, 0x102040);
grid.position.y = -1.2;
scene.add(grid);

// ── the player ship (a lit, beveled-ish prism) ─────────────────────────────
const ship = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.ConeGeometry(0.7, 1.8, 6),
  new THREE.MeshStandardMaterial({ color: 0x33ddff, metalness: 0.6, roughness: 0.25, emissive: 0x0a3344 })
);
body.rotation.x = Math.PI / 2; // point "forward" (−Z)
ship.add(body);
const glow = new THREE.Mesh(
  new THREE.SphereGeometry(0.35, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0x66ffff })
);
glow.position.z = 0.9;
ship.add(glow);
scene.add(ship);

// ── collectible gems ────────────────────────────────────────────────────────
const gems = [];
const gemGeo = new THREE.IcosahedronGeometry(0.6, 0);
function spawnGem() {
  const m = new THREE.Mesh(
    gemGeo,
    new THREE.MeshStandardMaterial({ color: 0xffcc33, emissive: 0x553300, metalness: 0.3, roughness: 0.2, flatShading: true })
  );
  m.position.set((Math.random() * 2 - 1) * 12, 0, (Math.random() * 2 - 1) * 12);
  scene.add(m);
  gems.push(m);
}
for (let i = 0; i < 6; i++) spawnGem();

// ── input: normalized RetroPad / gamepad / keyboard via getInput() ──────────
// Combine the D-pad (buttons) with the left analog stick so the ship responds
// to a digital RetroPad D-pad AND an analog stick / xbox pad alike.
function readMove() {
  const player = getInput()[0]; // gamepad if present, else keyboard
  let x = 0, y = 0;
  if (player.DPAD_LEFT.pressed) x -= 1;
  if (player.DPAD_RIGHT.pressed) x += 1;
  if (player.DPAD_UP.pressed) y -= 1;
  if (player.DPAD_DOWN.pressed) y += 1;
  if (Math.abs(player.LEFT_STICK_X) > 0.2) x += player.LEFT_STICK_X;
  if (Math.abs(player.LEFT_STICK_Y) > 0.2) y += player.LEFT_STICK_Y;
  return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
}

// ── game state ──────────────────────────────────────────────────────────────
let score = 0;
const speed = 0.18;
let t = 0;

function update() {
  t += 1 / 60;
  const { x, y } = readMove();

  ship.position.x += x * speed;
  ship.position.z += y * speed;
  ship.position.x = Math.max(-14, Math.min(14, ship.position.x));
  ship.position.z = Math.max(-14, Math.min(14, ship.position.z));

  // bank the ship toward the direction of travel
  ship.rotation.z = -x * 0.5;
  ship.rotation.x = y * 0.4;
  glow.material.color.setHSL((t * 0.3) % 1, 1, 0.6);

  // camera chases the ship
  camera.position.x += (ship.position.x - camera.position.x) * 0.05;
  camera.position.z += (ship.position.z + 10 - camera.position.z) * 0.05;
  camera.lookAt(ship.position.x, 0, ship.position.z);

  // gems spin and get collected
  for (const g of gems) {
    g.rotation.x += 0.03;
    g.rotation.y += 0.05;
    g.position.y = Math.sin(t * 2 + g.position.x) * 0.3;
    const dx = g.position.x - ship.position.x;
    const dz = g.position.z - ship.position.z;
    if (dx * dx + dz * dz < 1.4) {
      g.position.set((Math.random() * 2 - 1) * 12, 0, (Math.random() * 2 - 1) * 12);
      score++;
      console.log('SCORE ' + score);
    }
  }
  rim.position.x = Math.cos(t) * 6;
  rim.position.z = Math.sin(t) * 6;
}

// ── per-frame perf instrument (opt-in) ──────────────────────────────────────
// Measures wall time of update()+render() — the same quantity the core reports
// as `timing/600f cb=…ms` — so the browser (DevTools) and the core measure the
// SAME work apples-to-apples. Enabled in the browser via ?perf in the URL; in
// the core it's harmless (no location.search) and the core's own timing line is
// the source of truth there. Logs avg/min/max over each 600-frame window.
const PERF =
  typeof location !== 'undefined' && /(?:\?|&)perf\b/.test(location.search || '');
let perfSum = 0, perfMax = 0, perfMin = Infinity, perfN = 0;

let frame = 0;
function loop() {
  const t0 = PERF ? performance.now() : 0;
  update();
  renderer.render(scene, camera);
  if (PERF) {
    const dt = performance.now() - t0;
    perfSum += dt; perfN++;
    if (dt > perfMax) perfMax = dt;
    if (dt < perfMin) perfMin = dt;
    if (perfN === 600) {
      console.log(
        `perf/600f: cb(update+render)=${(perfSum / 600).toFixed(3)}ms ` +
        `min=${perfMin.toFixed(3)}ms max=${perfMax.toFixed(3)}ms`,
      );
      perfSum = 0; perfMax = 0; perfMin = Infinity; perfN = 0;
    }
  }
  frame++;
  // one-shot self-check for the headless harness
  if (frame === 30) console.log(score >= 0 ? 'THREE OK score=' + score : 'THREE FAIL');
  requestAnimationFrame(loop);
}
console.log('three-game: Three.js r' + THREE.REVISION + ' booting');
requestAnimationFrame(loop);

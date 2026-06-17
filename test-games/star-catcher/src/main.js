// star-catcher — a 2D Canvas SHOOTER: fly the ship, blast the invaders.
// Image sprites + WebAudio sound effects (shots, explosions) + gamepad.
const canvas = document.getElementById('c');
const W = canvas.width, H = canvas.height;
const ctx = canvas.getContext('2d');

// ── image assets (from the .jsgame bundle) ─────────────────────────────────
const IMG = {};
for (const n of ['ship', 'enemy', 'bullet', 'boom']) {
  const im = new Image(); im.src = n + '.png'; IMG[n] = im;
}

// ── WebAudio: real .mp3 sound effects (fetch -> decode -> play) ─────────────
const ac = new AudioContext();
const SFX = {};                       // name -> decoded AudioBuffer
async function loadSound(name, file) {
  try {
    const ab = await fetch('./sounds/' + file).then(r => r.arrayBuffer());
    SFX[name] = await ac.decodeAudioData(ab);
  } catch (err) { console.log('sfx load failed ' + file + ': ' + err.message); }
}
function play(name, vol) {
  const buf = SFX[name]; if (!buf) return;
  const src = ac.createBufferSource(), g = ac.createGain();
  g.gain.value = vol || 0.4;
  src.buffer = buf; src.connect(g); g.connect(ac.destination);
  src.start();
  src.onended = () => { src.disconnect(); g.disconnect(); };
}
// load all SFX up front
Promise.all([
  loadSound('shoot', 'laser.mp3'),
  loadSound('boom',  'explosion.mp3'),
  loadSound('hit',   'hit.mp3'),
]).then(() => console.log('sfx loaded'));
const sShoot = () => play('shoot', 0.35);
const sBoom  = () => play('boom', 0.5);
const sHit   = () => play('hit', 0.6);

// ── starfield ───────────────────────────────────────────────────────────────
const bg = [];
for (let i = 0; i < 70; i++) bg.push({ x: Math.random()*W, y: Math.random()*H, s: Math.random()*2+0.5 });

// ── entities ────────────────────────────────────────────────────────────────
const ship = { x: W/2, y: H - 64, w: 48, h: 48, vx: 0, cool: 0 };
let bullets = [], enemies = [], booms = [];
let score = 0, lives = 3, t = 0, spawn = 0, gameOver = false;

function reset() { bullets=[]; enemies=[]; booms=[]; score=0; lives=3; gameOver=false; ship.x=W/2; }

// ── input ───────────────────────────────────────────────────────────────────
const keys = Object.create(null);
let prevFire = false;
window.addEventListener('keydown', e => keys[e.code] = true);
window.addEventListener('keyup',   e => keys[e.code] = false);
function readInput() {
  let x = 0, fire = false, restart = false;
  const gp = (navigator.getGamepads && navigator.getGamepads())[0];
  if (gp) {
    if (Math.abs(gp.axes[0]) > 0.15) x += gp.axes[0];
    if (gp.buttons[14]?.pressed) x -= 1;
    if (gp.buttons[15]?.pressed) x += 1;
    fire = gp.buttons[0]?.pressed || gp.buttons[7]?.pressed; // A or R2
    restart = gp.buttons[9]?.pressed;                         // Start
  }
  if (keys.ArrowLeft) x -= 1;
  if (keys.ArrowRight) x += 1;
  if (keys.Space) fire = true;
  if (keys.Enter) restart = true;
  return { x: Math.max(-1, Math.min(1, x)), fire, restart };
}

function spawnEnemy() {
  enemies.push({ x: Math.random()*(W-40), y: -40, w: 40, h: 40,
                 vy: (1.2 + Math.random()*1.5 + score*0.015) * 60, sway: Math.random()*Math.PI, amp: Math.random()*1.5 });
}

// All movement is per-SECOND and scaled by dt (delta seconds), so the game runs
// at the same real-world speed at any frame rate — low fps just looks less
// smooth, it doesn't slow the action down.
function update(dt) {
  t += dt;
  const inp = readInput();

  if (gameOver) { if (inp.restart) { reset(); sShoot(); } scrollBg(dt); return; }

  // ship — 390 px/sec (== old 6.5 px/frame * 60)
  ship.vx = inp.x * 390;
  ship.x = Math.max(0, Math.min(W - ship.w, ship.x + ship.vx * dt));
  if (ship.cool > 0) ship.cool -= dt;
  if (inp.fire && ship.cool <= 0) {
    bullets.push({ x: ship.x + ship.w/2 - 4, y: ship.y - 6, w: 8, h: 16, vy: -600 });
    ship.cool = 0.15; sShoot();   // 0.15s between shots (== old 9 frames)
  }

  // bullets — 600 px/sec up
  bullets = bullets.filter(b => { b.y += b.vy * dt; return b.y > -20; });

  // spawn enemies — interval in seconds, shrinks as score climbs
  spawn -= dt;
  if (spawn <= 0) { spawnEnemy(); spawn = Math.max(0.35, 1.15 - score * 0.015); }

  // enemies move + collide
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    e.sway += 3 * dt; e.y += e.vy * dt; e.x += Math.cos(e.sway) * e.amp * 60 * dt;
    // bullet hits enemy?
    let killed = false;
    for (let j = bullets.length - 1; j >= 0; j--) {
      const b = bullets[j];
      if (b.x < e.x+e.w && b.x+b.w > e.x && b.y < e.y+e.h && b.y+b.h > e.y) {
        bullets.splice(j, 1); killed = true; break;
      }
    }
    if (killed) {
      booms.push({ x: e.x+e.w/2-24, y: e.y+e.h/2-24, life: 0.23 });
      enemies.splice(i, 1); score++; sBoom(); continue;
    }
    // enemy reaches ship or bottom?
    if (e.y + e.h > ship.y + 8 && e.x+e.w > ship.x+6 && e.x < ship.x+ship.w-6) {
      booms.push({ x: ship.x, y: ship.y, life: 0.3 });
      enemies.splice(i, 1); lives--; sHit();
      if (lives <= 0) { gameOver = true; }
    } else if (e.y > H) {
      enemies.splice(i, 1); lives--; sHit();
      if (lives <= 0) { gameOver = true; }
    }
  }

  booms = booms.filter(x => { x.life -= dt; return x.life > 0; });
  scrollBg(dt);
}
function scrollBg(dt) { for (const b of bg) { b.y += b.s * 30 * dt; if (b.y > H) { b.y = 0; b.x = Math.random()*W; } } }

function draw() {
  ctx.fillStyle = '#04060e'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#9fb4ff';
  for (const b of bg) ctx.fillRect(b.x, b.y, b.s, b.s);

  for (const b of bullets) if (IMG.bullet.complete) ctx.drawImage(IMG.bullet, b.x, b.y, b.w, b.h);
  for (const e of enemies) if (IMG.enemy.complete) ctx.drawImage(IMG.enemy, e.x, e.y, e.w, e.h);
  for (const x of booms)   if (IMG.boom.complete)  {
    const k = x.life / 0.3; ctx.globalAlpha = Math.max(0, Math.min(1, k));
    ctx.drawImage(IMG.boom, x.x, x.y, 48, 48); ctx.globalAlpha = 1;
  }

  if (IMG.ship.complete && !gameOver) {
    // bank toward travel direction: vx is px/sec (±390), normalize to a small tilt
    ctx.save(); ctx.translate(ship.x+ship.w/2, ship.y+ship.h/2); ctx.rotate((ship.vx/390) * 0.35);
    ctx.drawImage(IMG.ship, -ship.w/2, -ship.h/2, ship.w, ship.h); ctx.restore();
  }

  ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif';
  ctx.fillText('Score: ' + score, 16, 32);
  ctx.fillText('Lives: ' + '♥'.repeat(Math.max(0, lives)), W - 170, 32);

  if (gameOver) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5a4a'; ctx.font = '52px sans-serif'; ctx.fillText('GAME OVER', W/2, H/2-20);
    ctx.fillStyle = '#fff'; ctx.font = '26px sans-serif'; ctx.fillText('Score: ' + score, W/2, H/2+22);
    ctx.fillText('Start / Enter to play again', W/2, H/2+62);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = '#6688cc'; ctx.font = '16px sans-serif';
    ctx.fillText('Move: stick/dpad   Shoot: A / Space', 16, H-16);
  }
}

let frame = 0;
let _last = 0;
function loop(ts) {
  // rAF passes a ms timestamp; derive delta-seconds, clamp so a hitch/pause
  // can't teleport everything across the screen in one giant step.
  if (!_last) _last = ts || 0;
  let dt = ((ts || 0) - _last) / 1000;
  _last = ts || 0;
  if (!(dt > 0) || dt > 0.1) dt = 1/60;   // first frame / hitch -> nominal step
  update(dt);
  draw();
  if (++frame === 30) console.log('STAR-CATCHER OK');
  requestAnimationFrame(loop);
}
console.log('star-catcher SHOOTER: booting (Canvas 2D + WebAudio + gamepad)');
requestAnimationFrame(loop);

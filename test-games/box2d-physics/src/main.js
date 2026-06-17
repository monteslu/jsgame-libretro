// box2d3-wasm physics demo for jsgame-libretro — boxes rain into a bin and
// pile up, rendered with Canvas2D. Pure 2D (no WebGL), so it runs on the CPU
// raster path.
//
// box2d3-wasm (npm). The build copies the threaded "deluxe" build into public/
// (-> dist root) and we load it from the on-disk sibling module. It must stay a
// real file (not bundled) so its emscripten pthread worker URL resolves; the
// core runs emscripten wasm pthreads via native worker_threads. We fetch the
// .wasm root-relative and pass the bytes as `wasmBinary` so emscripten doesn't
// locate it itself. (This demo uses b2CreateWorld — single-threaded — but rides
// the same deluxe/threaded build the other box2d3 games use.)
const { default: Box2DFactory } = await import('./Box2D.deluxe.mjs');

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

// ── load the wasm bytes and init box2d3 (compat build) ──
const wasmBinary = new Uint8Array(await (await fetch('Box2D.deluxe.wasm')).arrayBuffer());
const box2d = await Box2DFactory({ wasmBinary });
const {
  b2DefaultWorldDef, b2CreateWorld, b2World_Step,
  b2DefaultBodyDef, b2CreateBody, b2BodyType, b2DestroyBody,
  b2DefaultShapeDef, b2MakeBox, b2CreatePolygonShape,
  b2Body_GetPosition, b2Body_GetRotation, b2Rot_GetAngle,
  b2Vec2,
} = box2d;

// ── Coordinate mapping: physics is meters, y-up; canvas is pixels, y-down ──
// Put the world ~16m wide spanning the canvas; origin at bottom-centre-ish.
const PPM = W / 16;              // pixels per meter
const toX = (mx) => W / 2 + mx * PPM;
const toY = (my) => H - my * PPM; // flip y

// ── World + static container (floor + two walls), all thin boxes ──
const worldDef = b2DefaultWorldDef();
worldDef.gravity = new b2Vec2(0, -10);
const worldId = b2CreateWorld(worldDef);

function addStaticBox(cx, cy, hw, hh) {
  const bd = b2DefaultBodyDef();
  bd.position = new b2Vec2(cx, cy);
  const id = b2CreateBody(worldId, bd);
  const sd = b2DefaultShapeDef();
  sd.material.friction = 0.6;
  b2CreatePolygonShape(id, sd, b2MakeBox(hw, hh));
  return { id, hw, hh, dynamic: false };
}

const WORLD_HW = (W / PPM) / 2;     // half world width in meters
const statics = [
  addStaticBox(0, 0.3, WORLD_HW, 0.3),               // floor
  addStaticBox(-WORLD_HW + 0.3, 5, 0.3, 5),           // left wall
  addStaticBox(WORLD_HW - 0.3, 5, 0.3, 5),            // right wall
];

// ── Dynamic boxes: spawn on a timer, cap the count, recycle the oldest ──
const boxes = [];
const MAX_BOXES = 40;
let spawnAccumulator = 0;
let rngState = 1337;
function rnd() { // deterministic LCG so the scene is reproducible
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

function spawnBox() {
  const hw = 0.35 + rnd() * 0.35;
  const hh = 0.35 + rnd() * 0.35;
  const bd = b2DefaultBodyDef();
  bd.type = b2BodyType.b2_dynamicBody;
  bd.position = new b2Vec2((rnd() - 0.5) * (WORLD_HW * 1.2), 13 + rnd() * 2);
  const id = b2CreateBody(worldId, bd);
  const sd = b2DefaultShapeDef();
  sd.density = 1.0;
  sd.material.friction = 0.5;
  sd.material.restitution = 0.1;
  b2CreatePolygonShape(id, sd, b2MakeBox(hw, hh));
  const hue = Math.floor(rnd() * 360);
  boxes.push({ id, hw, hh, color: `hsl(${hue} 70% 55%)` });
  if (boxes.length > MAX_BOXES) {
    const old = boxes.shift();
    b2DestroyBody(old.id);
  }
}

// ── Draw one box body (position + rotation) as a filled rect ──
function drawBody(b, fill, stroke) {
  const p = b2Body_GetPosition(b.id);
  const angle = b2Rot_GetAngle(b2Body_GetRotation(b.id));
  ctx.save();
  ctx.translate(toX(p.x), toY(p.y));
  ctx.rotate(-angle); // physics CCW+ ; canvas y-down flips the sense
  ctx.fillStyle = fill;
  ctx.fillRect(-b.hw * PPM, -b.hh * PPM, b.hw * 2 * PPM, b.hh * 2 * PPM);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(-b.hw * PPM, -b.hh * PPM, b.hw * 2 * PPM, b.hh * 2 * PPM);
  }
  ctx.restore();
}

const dt = 1 / 60;
let frame = 0;

function loop() {
  frame++;
  // Spawn ~1 box every 12 frames until the cap, then keep recycling slowly.
  spawnAccumulator += 1;
  if (spawnAccumulator >= 12) { spawnAccumulator = 0; spawnBox(); }

  b2World_Step(worldId, dt, 4);

  // Render
  ctx.fillStyle = '#10131c';
  ctx.fillRect(0, 0, W, H);
  for (const s of statics) drawBody(s, '#3a4a63', '#5b7196');
  for (const b of boxes) drawBody(b, b.color, 'rgba(0,0,0,0.35)');

  ctx.fillStyle = '#ffffff';
  ctx.font = '18px sans-serif';
  ctx.fillText('box2d3-wasm — ' + boxes.length + ' bodies  frame ' + frame, 12, 26);

  requestAnimationFrame(loop);
}

console.log('[box2d-physics] box2d3-wasm booted; starting sim');
requestAnimationFrame(loop);

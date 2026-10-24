/**
 * The 3D-looking downhill scene (pseudo-3D, like old arcade racers).
 *
 * The camera stands at the bottom of the slope with the snowball throwers, looking UP the hill.
 * The rider comes down towards us, so we see his face; the piste, grooming lines, trees and
 * flags stream away to the horizon to show speed, and his carve tracks trail up the hill.
 *
 * Gameplay is unchanged: at the rider's depth, game x in [-1, 1] maps LINEARLY across the
 * screen, so the board drawn here is exactly the hit box used by round.ts.
 * Drawing only: no rules here.
 */
import { RIDER_HALF_WIDTH, type RoundState } from './round';

export const FONT_DISPLAY = '"Arial Black", Impact, "Trebuchet MS", sans-serif';
export const FONT_UI = '"Trebuchet MS", Tahoma, Verdana, sans-serif';

const reducedMotion =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- camera ----------
const CAM_H = 1; // camera height above the snow (world units)
const Z_RIDER = 4; // rider's distance from the camera
const Z_NEAR = 0.9;
const Z_FAR = 70;
const SPEED_PLAYING = 9; // world units per second
const SPEED_LOBBY = 3.5;

interface View {
  w: number;
  h: number;
  cx: number;
  horizon: number;
  f: number; // focal length in px
  L: number; // world width of game x = 1
}

function makeView(w: number, h: number): View {
  const horizon = h * 0.3;
  const f = ((h * 0.8 - horizon) * Z_RIDER) / CAM_H; // rider's feet land at 80% of the height
  const L = (w * 0.45 * Z_RIDER) / f; // game x = +-1 spans 90% of the width at the rider
  return { w, h, cx: w / 2, horizon, f, L };
}
const sx = (v: View, X: number, z: number) => v.cx + (X * v.f) / z;
const sy = (v: View, Y: number, z: number) => v.horizon + ((CAM_H - Y) * v.f) / z;

// ---------- deterministic scenery ----------
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const SPAN = Z_FAR - 1;
const trees = Array.from({ length: 46 }, (_, i) => ({
  side: i % 2 === 0 ? -1 : 1,
  out: 1.55 + rand() * 1.8, // lateral, in multiples of L
  u: rand() * SPAN,
  size: 0.8 + rand() * 0.7,
}));
const flags = Array.from({ length: 10 }, (_, i) => ({
  side: i % 2 === 0 ? -1 : 1,
  u: (i / 10) * SPAN,
  color: i % 4 < 2 ? '#e8202a' : '#1f5fe0',
}));
const flakes = Array.from({ length: 110 }, () => ({
  x: rand(),
  y: rand(),
  r: 1 + rand() * 2.6,
  speed: 0.05 + rand() * 0.09,
  phase: rand() * Math.PI * 2,
}));

// ---------- motion state (lives here; it's purely visual) ----------
let travel = 0;
let speed = SPEED_LOBBY;
let lastNow = 0;
const trail: { x: number; at: number }[] = [];
const spray: { x: number; y: number; vx: number; vy: number; life: number }[] = [];

export interface SceneInput {
  state: RoundState;
  now: number;
  hurt: boolean; // just got hit (flash + flinch)
  markers: { x: number; hit: boolean; name: string; born: number }[];
  nameOf: (playerId: string) => string;
}

export function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, inp: SceneInput) {
  const { state, now } = inp;
  const v = makeView(w, h);
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
  lastNow = now;

  // speed: cruise in the lobby, full speed in a round, slide to a stop on a wipeout
  const target =
    state.phase === 'playing'
      ? SPEED_PLAYING
      : state.result === 'lose'
        ? 0
        : state.phase === 'over'
          ? SPEED_LOBBY
          : SPEED_LOBBY;
  speed += (target - speed) * Math.min(1, dt * (target === 0 ? 1.5 : 2));
  if (!reducedMotion) travel += speed * dt;

  // rider's carve tracks
  trail.push({ x: state.riderX, at: travel });
  while (trail.length && travel - trail[0]!.at > 45) trail.shift();
  if (trail.length > 900) trail.splice(0, trail.length - 900);

  drawSky(ctx, v, now);
  drawPiste(ctx, v);
  drawTrail(ctx, v, state);
  drawHaze(ctx, v);
  drawSceneryFarToNear(ctx, v);

  // rider + spray
  const halfSpan = (v.L * v.f) / Z_RIDER;
  const halfW = RIDER_HALF_WIDTH * halfSpan;
  const riderPx = v.cx + state.riderX * halfSpan;
  const groundY = sy(v, 0, Z_RIDER);
  updateSpray(dt, riderPx, groundY, halfW, state);
  drawSpray(ctx);
  drawRider(ctx, riderPx, groundY, halfW, state.steer, now, state.result === 'lose', inp.hurt);

  // impact height: rider's chest, as a world height at the rider's depth
  const s = halfW / 60;
  const impactY = groundY - 70 * s;
  const impactWorldY = ((groundY - impactY) * Z_RIDER) / v.f;

  for (const m of inp.markers) {
    const age = (now - m.born) / 1000;
    if (age > 1) continue;
    drawSplat(ctx, v.cx + m.x * halfSpan, impactY, 1 - age, m.hit, m.name, s);
  }

  // snowballs in flight: from the throwers (near the camera) up the hill to the rider
  for (const b of state.snowballs) {
    drawFlyingSnowball(ctx, v, b.aim, b.ageMs / b.flightMs, impactWorldY, inp.nameOf(b.playerId));
  }

  drawSnowfall(ctx, v, now);
  if (inp.hurt) {
    ctx.fillStyle = 'rgba(255, 47, 160, 0.14)';
    ctx.fillRect(0, 0, w, h);
  }
}

// ---------- sky + mountains ----------
function drawSky(ctx: CanvasRenderingContext2D, v: View, now: number) {
  const { w, h, horizon } = v;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#1f7bff');
  sky.addColorStop(1, '#bfe6ff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon + 2);

  const sun = ctx.createRadialGradient(w * 0.82, h * 0.08, 0, w * 0.82, h * 0.08, h * 0.3);
  sun.addColorStop(0, 'rgba(255,255,255,0.95)');
  sun.addColorStop(0.18, 'rgba(255,255,240,0.55)');
  sun.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, horizon);

  // clouds drift slowly
  const drift = reducedMotion ? 0 : (now / 90000) % 1;
  for (const [cx, cy, sc] of [
    [0.12, 0.09, 0.8],
    [0.5, 0.05, 0.6],
    [0.7, 0.15, 0.7],
  ] as const) {
    const x = (((cx + drift) % 1.3) - 0.15) * w;
    const r = sc * h * 0.045;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(x, cy * h, r, 0, Math.PI * 2);
    ctx.arc(x + r * 0.9, cy * h - r * 0.35, r * 0.8, 0, Math.PI * 2);
    ctx.arc(x + r * 1.8, cy * h, r * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  // far mountains (two layers)
  mountains(ctx, w, horizon, h * 0.13, ['#9fb8de', '#d9e6f7'], 3);
  mountains(ctx, w, horizon, h * 0.08, ['#c6d8f0', '#f1f7ff'], 7);
}

function mountains(
  ctx: CanvasRenderingContext2D,
  w: number,
  base: number,
  peak: number,
  [rock, snow]: [string, string],
  s: number,
) {
  let r = s;
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  const pts: [number, number][] = [[0, base]];
  for (let x = 0; x <= w + 80; x += 80) pts.push([x, base - peak * (0.35 + rnd() * 0.65)]);
  pts.push([w, base]);
  ctx.fillStyle = rock;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  // snow caps
  ctx.fillStyle = snow;
  for (let i = 1; i < pts.length - 2; i++) {
    const [x, y] = pts[i]!;
    const [px, py] = pts[i - 1]!;
    const [nx, ny] = pts[i + 1]!;
    if (y > py || y > ny) continue;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (px - x) * 0.35, y + (py - y) * 0.35);
    ctx.lineTo(x + (nx - x) * 0.35, y + (ny - y) * 0.35);
    ctx.closePath();
    ctx.fill();
  }
}

// ---------- piste ----------
function drawPiste(ctx: CanvasRenderingContext2D, v: View) {
  const { w, h, horizon } = v;
  // deep snow everywhere below the horizon
  const off = ctx.createLinearGradient(0, horizon, 0, h);
  off.addColorStop(0, '#e9f3fc');
  off.addColorStop(1, '#ffffff');
  ctx.fillStyle = off;
  ctx.fillRect(0, horizon, w, h - horizon);

  // groomed piste: a trapezoid that narrows to the horizon
  const edge = 1.15 * v.L;
  const yFar = sy(v, 0, Z_FAR);
  const yNear = h + 10;
  const zAtNear = (CAM_H * v.f) / (yNear - horizon);
  const piste = ctx.createLinearGradient(0, yFar, 0, h);
  piste.addColorStop(0, '#dbeaf8');
  piste.addColorStop(1, '#f7fbff');
  ctx.fillStyle = piste;
  ctx.beginPath();
  ctx.moveTo(sx(v, -edge, Z_FAR), yFar);
  ctx.lineTo(sx(v, edge, Z_FAR), yFar);
  ctx.lineTo(sx(v, edge, zAtNear), yNear);
  ctx.lineTo(sx(v, -edge, zAtNear), yNear);
  ctx.closePath();
  ctx.fill();

  // corduroy grooming lines streaming up the hill: this is what sells the speed
  const gap = 1.6;
  const n = Math.ceil(SPAN / gap);
  for (let j = 0; j < n; j++) {
    const z = Z_NEAR + ((j * gap + travel) % SPAN);
    const z2 = z + 0.35;
    const y1 = sy(v, 0, z);
    const y2 = sy(v, 0, z2);
    if (y1 - y2 < 0.4) continue;
    ctx.fillStyle = `rgba(120,165,215,${0.16 * Math.min(1, 8 / z)})`;
    ctx.beginPath();
    ctx.moveTo(sx(v, -edge, z), y1);
    ctx.lineTo(sx(v, edge, z), y1);
    ctx.lineTo(sx(v, edge, z2), y2);
    ctx.lineTo(sx(v, -edge, z2), y2);
    ctx.closePath();
    ctx.fill();
  }

  // piste edge lines
  ctx.strokeStyle = 'rgba(90,140,200,0.35)';
  ctx.lineWidth = 2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sx(v, side * edge, Z_FAR), yFar);
    ctx.lineTo(sx(v, side * edge, zAtNear), yNear);
    ctx.stroke();
  }
}

function drawTrail(ctx: CanvasRenderingContext2D, v: View, state: RoundState) {
  if (trail.length < 2) return;
  const halfBoard = RIDER_HALF_WIDTH * v.L * 0.55;
  ctx.strokeStyle = 'rgba(110,150,205,0.45)';
  ctx.lineCap = 'round';
  for (const off of [-halfBoard, halfBoard]) {
    ctx.beginPath();
    let started = false;
    for (let i = trail.length - 1; i >= 0; i -= 2) {
      const p = trail[i]!;
      const z = Z_RIDER + (travel - p.at);
      const X = p.x * v.L + off;
      const x = sx(v, X, z);
      const y = sy(v, 0, z);
      ctx.lineWidth = Math.max(1, (0.06 * v.f) / z);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  void state;
}

// ---------- trees + flags ----------
function drawSceneryFarToNear(ctx: CanvasRenderingContext2D, v: View) {
  const items: { z: number; near: number; draw: () => void }[] = [];
  for (const t of trees) {
    const z = 1 + ((t.u + travel) % SPAN);
    items.push({ z, near: 2.2, draw: () => tree(ctx, v, t.side * t.out * v.L, z, t.size) });
  }
  for (const f of flags) {
    const z = 1 + ((f.u + travel) % SPAN);
    items.push({ z, near: 4, draw: () => flag(ctx, v, f.side * 1.12 * v.L, z, f.color) });
  }
  items.sort((a, b) => b.z - a.z);
  for (const it of items) {
    // fade in as they emerge beside the camera, fade out into the distance
    ctx.globalAlpha =
      Math.max(0, Math.min(1, (Z_FAR - it.z) / 12)) *
      Math.max(0, Math.min(1, (it.z - it.near) / 1.8));
    if (ctx.globalAlpha <= 0) continue;
    it.draw();
  }
  ctx.globalAlpha = 1;
}

function tree(ctx: CanvasRenderingContext2D, v: View, X: number, z: number, size: number) {
  const x = sx(v, X, z);
  const base = sy(v, 0, z);
  const hpx = (2.2 * size * v.f) / z;
  const wpx = hpx * 0.55;
  if (x + wpx < 0 || x - wpx > v.w || base - hpx > v.h) return;
  // trunk
  ctx.fillStyle = '#6b4423';
  ctx.fillRect(x - wpx * 0.07, base - hpx * 0.18, wpx * 0.14, hpx * 0.18);
  // three tiers of glossy green with snow on top
  for (let i = 0; i < 3; i++) {
    const tierBase = base - hpx * (0.12 + i * 0.27);
    const tierW = wpx * (1 - i * 0.25);
    const tierH = hpx * 0.42;
    const g = ctx.createLinearGradient(x - tierW / 2, 0, x + tierW / 2, 0);
    g.addColorStop(0, '#0f6b3a');
    g.addColorStop(0.5, '#1f9e55');
    g.addColorStop(1, '#0b5a2f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, tierBase - tierH);
    ctx.lineTo(x + tierW / 2, tierBase);
    ctx.lineTo(x - tierW / 2, tierBase);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.moveTo(x, tierBase - tierH);
    ctx.lineTo(x + tierW * 0.2, tierBase - tierH * 0.6);
    ctx.lineTo(x - tierW * 0.2, tierBase - tierH * 0.6);
    ctx.closePath();
    ctx.fill();
  }
}

function flag(ctx: CanvasRenderingContext2D, v: View, X: number, z: number, color: string) {
  const x = sx(v, X, z);
  const base = sy(v, 0, z);
  const hpx = (1.3 * v.f) / z;
  if (x < -50 || x > v.w + 50 || base - hpx > v.h) return;
  ctx.strokeStyle = '#333';
  ctx.lineWidth = Math.max(1, hpx * 0.03);
  ctx.beginPath();
  ctx.moveTo(x, base);
  ctx.lineTo(x, base - hpx);
  ctx.stroke();
  ctx.fillStyle = color;
  const dir = X < 0 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x, base - hpx);
  ctx.lineTo(x + dir * hpx * 0.45, base - hpx * 0.85);
  ctx.lineTo(x, base - hpx * 0.68);
  ctx.closePath();
  ctx.fill();
}

function drawHaze(ctx: CanvasRenderingContext2D, v: View) {
  const g = ctx.createLinearGradient(0, v.horizon - 6, 0, v.horizon + v.h * 0.06);
  g.addColorStop(0, 'rgba(230,242,255,0.75)');
  g.addColorStop(1, 'rgba(230,242,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, v.horizon - 6, v.w, v.h * 0.06 + 6);
}

// ---------- snow spray off the board ----------
function updateSpray(dt: number, x: number, y: number, halfW: number, state: RoundState) {
  if (!reducedMotion && state.phase === 'playing') {
    const carve = Math.abs(state.steer);
    const count = Math.round(1 + carve * 5);
    for (let i = 0; i < count; i++) {
      const side = state.steer >= 0 ? -1 : 1; // spray flies out from the trailing edge
      spray.push({
        x: x + side * halfW * (0.6 + Math.random() * 0.5),
        y: y - 2,
        vx: side * (40 + Math.random() * 140 * (0.3 + carve)),
        vy: -(60 + Math.random() * 120),
        life: 0.45 + Math.random() * 0.3,
      });
    }
  }
  for (const p of spray) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 420 * dt;
  }
  while (spray.length && (spray[0]!.life <= 0 || spray.length > 260)) spray.shift();
}

function drawSpray(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#ffffff';
  for (const p of spray) {
    if (p.life <= 0) continue;
    ctx.globalAlpha = Math.min(1, p.life * 2.2);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2 + p.life * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------- falling snow (screen space, in front of everything) ----------
function drawSnowfall(ctx: CanvasRenderingContext2D, v: View, now: number) {
  const t = reducedMotion ? 0 : now / 1000;
  ctx.fillStyle = '#ffffff';
  for (const f of flakes) {
    const y = ((f.y + t * f.speed) % 1) * v.h;
    const x = (f.x + Math.sin(t * 0.8 + f.phase) * 0.01) * v.w;
    ctx.globalAlpha = 0.5 + f.r / 8;
    ctx.beginPath();
    ctx.arc(x, y, f.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------- snowballs ----------
function drawFlyingSnowball(
  ctx: CanvasRenderingContext2D,
  v: View,
  aim: number,
  p: number,
  impactWorldY: number,
  name: string,
) {
  const t = Math.min(1, Math.max(0, p));
  const z0 = 1.5;
  const z = z0 + (Z_RIDER - z0) * t;
  const X = aim * v.L * (0.55 + 0.45 * t); // starts nearer the middle (the crowd), fans out
  const Y = 0.2 + (impactWorldY - 0.2) * t + Math.sin(Math.PI * t) * 0.9; // arc
  const x = sx(v, X, z);
  const y = sy(v, Y, z);
  const r = (0.07 * v.f) / z;

  // shadow on the snow under it
  ctx.fillStyle = `rgba(30,70,140,${0.1 + 0.2 * t})`;
  ctx.beginPath();
  ctx.ellipse(x, sy(v, 0, z), r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, 1, x, y, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.6, '#e9f4ff');
  g.addColorStop(1, '#8fbbe6');
  ctx.fillStyle = g;
  ctx.strokeStyle = '#2f6db5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (name) {
    ctx.font = `bold ${Math.round(Math.max(12, r * 0.5))}px ${FONT_UI}`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(name, x, y - r - 6);
    ctx.fillStyle = '#0b2a6b';
    ctx.fillText(name, x, y - r - 6);
    ctx.textAlign = 'start';
  }
}

function drawSplat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  alpha: number,
  hit: boolean,
  name: string,
  s: number,
) {
  ctx.globalAlpha = alpha;
  const grow = (1 + (1 - alpha) * 0.6) * Math.max(0.7, s);
  if (hit) {
    starburst(ctx, x, y, 34 * grow, '#ffe600', '#ff3d00');
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(47,109,181,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const r = (i % 2 === 0 ? 18 : 10) * grow;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.6);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.font = `bold 15px ${FONT_UI}`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText(name, x, y + 40 * grow);
  ctx.fillStyle = '#0b2a6b';
  ctx.fillText(name, x, y + 40 * grow);
  if (hit) {
    ctx.font = `italic 30px ${FONT_DISPLAY}`;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#7a1300';
    const ty = y - 46 * grow - (1 - alpha) * 30;
    ctx.strokeText('HIT! -10', x, ty);
    ctx.fillStyle = '#ffe600';
    ctx.fillText('HIT! -10', x, ty);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'start';
}

function starburst(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  stroke: string,
) {
  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.55;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
}

// ---------- the rider, facing the camera ----------
/**
 * Snowboarder coming down at us. Feet at groundY, centred on x. halfW is the hit half-width
 * in px, so the board is exactly the hit box. Leans into turns, flinches when hit,
 * lies in the snow after a wipeout.
 */
function drawRider(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  halfW: number,
  steer: number,
  now: number,
  knockedOut: boolean,
  hurt: boolean,
) {
  const s = halfW / 60; // artwork is designed for a 120 px wide board
  const bob = reducedMotion || knockedOut ? 0 : Math.sin(now / 140) * 2 * s;
  const shake = hurt && !reducedMotion ? Math.sin(now / 15) * 3 * s : 0;

  // shadow on the snow
  ctx.fillStyle = 'rgba(30,70,140,0.22)';
  ctx.beginPath();
  ctx.ellipse(x, groundY + 4 * s, halfW * 1.1, 9 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(x + shake, groundY - 6 * s + bob);
  if (knockedOut) {
    ctx.rotate(-Math.PI / 2 + 0.2);
    ctx.translate(-10 * s, -halfW * 0.15);
  } else {
    ctx.rotate(steer * 0.3); // lean into the carve
  }

  // board, seen from the front: glossy aqua deck with a little perspective (thicker near edge)
  const board = ctx.createLinearGradient(0, -8 * s, 0, 8 * s);
  board.addColorStop(0, '#c9efff');
  board.addColorStop(0.45, '#48b4ff');
  board.addColorStop(0.55, '#0a6fe0');
  board.addColorStop(1, '#5cc6ff');
  ctx.fillStyle = board;
  ctx.strokeStyle = '#0b3f8f';
  ctx.lineWidth = 2;
  rr(ctx, -halfW, -7 * s, halfW * 2, 14 * s, 7 * s);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  rr(ctx, -halfW + 8 * s, -5 * s, halfW * 2 - 16 * s, 3 * s, 2 * s);
  ctx.fill();
  // bindings
  ctx.fillStyle = '#1a1a2e';
  rr(ctx, -30 * s, -10 * s, 18 * s, 8 * s, 3 * s);
  ctx.fill();
  rr(ctx, 12 * s, -10 * s, 18 * s, 8 * s, 3 * s);
  ctx.fill();

  // legs, knees bent (more bend when carving)
  const bend = 6 + Math.abs(steer) * 8;
  ctx.strokeStyle = '#26314f';
  ctx.lineWidth = 11 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-21 * s, -10 * s);
  ctx.lineTo((-21 - bend) * s, -30 * s);
  ctx.lineTo(-10 * s, -48 * s);
  ctx.moveTo(21 * s, -10 * s);
  ctx.lineTo((21 + bend) * s, -30 * s);
  ctx.lineTo(10 * s, -48 * s);
  ctx.stroke();

  // puffy jacket (hot pink to purple, very 2002) with a zip
  const jacket = ctx.createLinearGradient(0, -96 * s, 0, -44 * s);
  jacket.addColorStop(0, '#ff6ad5');
  jacket.addColorStop(1, '#8a2be2');
  ctx.fillStyle = jacket;
  ctx.strokeStyle = '#4b0f7a';
  ctx.lineWidth = 2;
  rr(ctx, -23 * s, -96 * s, 46 * s, 52 * s, 16 * s);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  rr(ctx, -17 * s, -91 * s, 10 * s, 38 * s, 5 * s);
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,10,110,0.6)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(0, -94 * s);
  ctx.lineTo(0, -46 * s);
  ctx.stroke();

  // arms out for balance, one up one down with the lean; mittens
  const armL = hurt ? -20 : -6 + steer * 16;
  const armR = hurt ? -20 : -6 - steer * 16;
  ctx.strokeStyle = '#c23fd6';
  ctx.lineWidth = 10 * s;
  ctx.beginPath();
  ctx.moveTo(-20 * s, -86 * s);
  ctx.lineTo(-48 * s, (-74 + armL) * s);
  ctx.moveTo(20 * s, -86 * s);
  ctx.lineTo(48 * s, (-74 + armR) * s);
  ctx.stroke();
  ctx.fillStyle = '#ffe600';
  ctx.beginPath();
  ctx.arc(-50 * s, (-74 + armL) * s, 6.5 * s, 0, Math.PI * 2);
  ctx.arc(50 * s, (-74 + armR) * s, 6.5 * s, 0, Math.PI * 2);
  ctx.fill();

  // scarf
  ctx.fillStyle = '#00c2ff';
  rr(ctx, -16 * s, -100 * s, 32 * s, 9 * s, 4 * s);
  ctx.fill();
  ctx.fillRect(8 * s, -94 * s, 7 * s, 16 * s);

  // head
  ctx.fillStyle = '#ffd7b3';
  ctx.strokeStyle = '#8a5a3a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, -114 * s, 17 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // rosy cheeks
  ctx.fillStyle = 'rgba(255,90,120,0.35)';
  ctx.beginPath();
  ctx.arc(-10 * s, -108 * s, 4 * s, 0, Math.PI * 2);
  ctx.arc(10 * s, -108 * s, 4 * s, 0, Math.PI * 2);
  ctx.fill();
  // mouth: grin, "O" when hit, wobbly when knocked out
  ctx.strokeStyle = '#7a2e1a';
  ctx.lineWidth = 2.2 * s;
  ctx.beginPath();
  if (hurt || knockedOut) {
    ctx.ellipse(0, -103 * s, 4 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#7a2e1a';
    ctx.fill();
  } else {
    ctx.arc(0, -107 * s, 7 * s, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }

  // goggles (aqua gloss), with a reflection
  const gog = ctx.createLinearGradient(0, -124 * s, 0, -112 * s);
  gog.addColorStop(0, '#d8fbff');
  gog.addColorStop(0.5, '#28c6ff');
  gog.addColorStop(1, '#0a5bd6');
  ctx.fillStyle = gog;
  ctx.strokeStyle = '#06286b';
  ctx.lineWidth = 2;
  rr(ctx, -16 * s, -125 * s, 32 * s, 12 * s, 6 * s);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  rr(ctx, -12 * s, -123 * s, 9 * s, 3 * s, 1.5 * s);
  ctx.fill();
  if (knockedOut) {
    // dizzy X eyes on the lenses
    ctx.strokeStyle = '#06286b';
    ctx.lineWidth = 2 * s;
    for (const ex of [-7, 7]) {
      ctx.beginPath();
      ctx.moveTo((ex - 3) * s, -122 * s);
      ctx.lineTo((ex + 3) * s, -116 * s);
      ctx.moveTo((ex + 3) * s, -122 * s);
      ctx.lineTo((ex - 3) * s, -116 * s);
      ctx.stroke();
    }
  }

  // striped beanie with bobble
  ctx.fillStyle = '#ffe600';
  ctx.beginPath();
  ctx.arc(0, -124 * s, 17 * s, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#ff2fa0';
  ctx.fillRect(-17 * s, -129 * s, 34 * s, 4.5 * s);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, -143 * s, 6 * s, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // dizzy stars over a wiped-out rider
  if (knockedOut && !reducedMotion) {
    ctx.font = `${Math.round(18 * Math.max(0.8, s))}px ${FONT_UI}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd200';
    for (let i = 0; i < 3; i++) {
      const a = now / 400 + (i * Math.PI * 2) / 3;
      ctx.fillText('★', x - 40 * s + Math.cos(a) * 26 * s, groundY - 50 * s + Math.sin(a) * 9 * s);
    }
    ctx.textAlign = 'start';
  }
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

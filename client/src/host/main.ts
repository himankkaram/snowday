/**
 * Host screen: runs the game loop, owns the rules, and is the only thing that decides outcomes.
 * Open as /host.html?key=HOST_KEY  (optional &room=ABCD to keep a fixed room code).
 */
import QRCode from 'qrcode';
import { EV, makeRoomCode, type ActionRelay, type Roster } from '../../../shared/protocol';
import { connect, getClientId, join, onEveryConnect } from '../net/socket';
import type { SteeringController } from '../input/controller';
import { KeyboardController } from '../input/keyboard';
import { MockController } from '../input/mock';
import { WebSerialController } from '../input/webserial';
import { clamp } from '../input/steering';
import * as R from './round';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- room + identity ----------
const params = new URLSearchParams(location.search);
const hostKey = params.get('key') ?? '';
const room = (params.get('room') ?? makeRoomCode()).toUpperCase();
if (!params.get('room')) {
  params.set('room', room);
  history.replaceState(null, '', `?${params}`); // refresh keeps the same room code
}
$('room').textContent = room;

/**
 * The QR link phones open. Priority:
 *  1. VITE_PUBLIC_URL from .env (your tunnel URL)  -> https, motion works
 *  2. this page's own address, if it isn't localhost
 *  3. if this page is on localhost (needed for Web Serial), ask the server for the laptop's LAN IP
 */
async function joinBase(): Promise<string> {
  const pub = (import.meta.env.VITE_PUBLIC_URL as string | undefined)?.replace(/\/$/, '');
  if (pub) return pub;
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return location.origin;
  try {
    const { lan } = (await (await fetch('/info')).json()) as { lan: string[] };
    if (lan[0]) return `${location.protocol}//${lan[0]}${location.port ? `:${location.port}` : ''}`;
  } catch {
    /* fall through */
  }
  return location.origin;
}
void joinBase()
  .then((base) => {
    const joinUrl = `${base}/phone.html?room=${room}`;
    $('join-url').textContent = joinUrl;
    return QRCode.toDataURL(joinUrl, { margin: 1, width: 512, errorCorrectionLevel: 'M' }).then(
      (url) => ($<HTMLImageElement>('qr').src = url),
    );
  })
  .catch((err) => console.error('QR failed', err));

// ---------- controllers ----------
const keyboard = new KeyboardController();
void keyboard.connect();
const controllers: Record<string, SteeringController> = {
  keyboard,
  mock: new MockController(),
  serial: new WebSerialController(),
};
let active: SteeringController = keyboard;

async function selectController(key: string) {
  if (active !== keyboard) await active.disconnect();
  active = controllers[key] ?? keyboard;
  if (active === controllers.mock) await active.connect(); // mock needs no permission
}
$<HTMLSelectElement>('controller').addEventListener('change', (e) => {
  void selectController((e.target as HTMLSelectElement).value);
});
$('connect-board').addEventListener('click', async () => {
  $<HTMLSelectElement>('controller').value = 'serial';
  await selectController('serial');
  await active.connect(); // must run inside this click for the browser's port picker
});
$('recalibrate').addEventListener('click', () => active.recalibrate());

/** Keyboard is ALWAYS added on top, so a dead board never leaves the rider uncontrollable. */
function currentSteer(): number {
  const dev = active === keyboard ? 0 : active.readSteering();
  return clamp(dev + keyboard.readSteering());
}

// ---------- network ----------
const socket = connect();
const net = $('net');
let roster: Roster = { room, hostConnected: false, players: [] };
const names = new Map<string, string>();
let lastError = '';
let lastLatencyMs = 0;
let actionsThisSecond = 0;
let actionsPerSecond = 0;
setInterval(() => ((actionsPerSecond = actionsThisSecond), (actionsThisSecond = 0)), 1000);

function setNet(text: string, cls: 'ok' | 'bad' | 'warn') {
  net.textContent = text;
  net.className = `pill ${cls}`;
}

onEveryConnect(socket, async () => {
  setNet('joining', 'warn');
  const res = await join(socket, {
    room,
    role: 'host',
    name: 'Host',
    clientId: getClientId('snowday.hostId'),
    hostKey,
  });
  if (res.ok) setNet('online', 'ok');
  else {
    setNet(res.error.code === 'BAD_HOST_KEY' ? 'wrong key' : 'join failed', 'bad');
    lastError = res.error.message;
  }
});
socket.on('disconnect', () => setNet('offline', 'bad'));
socket.on(EV.ERROR, (e) => (lastError = `${e.code}: ${e.message}`));
socket.on(EV.ROSTER, (r) => {
  roster = r;
  for (const p of r.players) names.set(p.id, p.name);
  $('count').textContent = String(r.players.length);
  const ul = $('players');
  ul.replaceChildren(
    ...r.players.map((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.connected ? '●' : '○'} ${p.name}`; // textContent: names can't inject HTML
      li.className = p.connected ? '' : 'muted';
      return li;
    }),
  );
});

// ---------- game state ----------
let state = R.newRound();
interface Marker {
  x: number;
  hit: boolean;
  name: string;
  born: number;
}
const markers: Marker[] = [];
let flashUntil = 0;

socket.on(EV.ACTION_RELAY, (a: ActionRelay) => {
  actionsThisSecond++;
  lastLatencyMs = Date.now() - a.serverTime;
  if (a.action !== 'throw') return;
  const { state: next, outcome } = R.resolveThrow(state, a.aim, a.playerId);
  state = next;
  if (outcome === 'ignored') return;
  markers.push({
    x: a.aim,
    hit: outcome === 'hit',
    name: names.get(a.playerId) ?? '?',
    born: performance.now(),
  });
  if (markers.length > 40) markers.shift();
  socket.emit(EV.HOST_EVENT, { type: outcome, playerId: a.playerId, actionSeq: a.seq });
  if (outcome === 'hit') {
    active.sendHitFeedback();
    flashUntil = performance.now() + 150;
  }
});

function startRound() {
  const throwers = roster.players.filter((p) => p.connected && p.id !== state.riderId).length;
  state = R.start(state, throwers);
  active.setLedEffect('idle');
}
function resetRound() {
  state = R.reset(state);
  markers.length = 0;
}
$('start').addEventListener('click', startRound);
$('reset').addEventListener('click', resetRound);
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    startRound();
  }
  if (e.key === 'r' || e.key === 'R') resetRound();
  if (e.key === 'd' || e.key === 'D') {
    const d = $('debug');
    d.hidden = !d.hidden;
  }
  if (e.key === 'c' || e.key === 'C') active.recalibrate();
});

// Tell phones what's happening ~10x a second.
setInterval(() => {
  if (socket.connected) socket.emit(EV.HOST_STATE, R.toHostState(state));
}, 100);

// ---------- render loop ----------
const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
let last = performance.now();
let fps = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function frame(now: number) {
  const dt = now - last;
  last = now;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
  state = R.step(state, dt, currentSteer());
  draw(now);
  drawDebug();
  requestAnimationFrame(frame);
}

function draw(now: number) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const toPx = (x: number) => ((x + 1) / 2) * w;
  ctx.fillStyle = now < flashUntil ? '#ffd6d6' : '#dfeaf4';
  ctx.fillRect(0, 0, w, h);

  // throw markers fade over 1.5 s
  for (const m of markers) {
    const age = (now - m.born) / 1500;
    if (age > 1) continue;
    ctx.globalAlpha = 1 - age;
    ctx.fillStyle = m.hit ? '#1e8a4c' : '#7f8c99';
    ctx.beginPath();
    ctx.arc(toPx(m.x), h * 0.35 + age * h * 0.35, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '13px system-ui';
    ctx.fillText(m.name, toPx(m.x) + 14, h * 0.35 + age * h * 0.35 + 4);
  }
  ctx.globalAlpha = 1;

  // rider (placeholder box)
  const rw = (R.RIDER_HALF_WIDTH * w) / 2; // world x spans -1..1 = 2 units across w pixels
  ctx.fillStyle = '#1f6fd1';
  ctx.fillRect(toPx(state.riderX) - rw, h * 0.72, rw * 2, 36);

  // HUD
  ctx.fillStyle = '#12263a';
  ctx.font = 'bold 48px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(String(Math.ceil(state.timeLeftMs / 1000)), w / 2, 64);
  ctx.font = '22px system-ui';
  ctx.fillText(`Hits ${state.hits} / Throws ${state.throws}`, w / 2, 100);
  if (state.phase !== 'playing') {
    ctx.font = 'bold 36px system-ui';
    ctx.fillText(
      state.phase === 'lobby' ? 'Press Space to start' : `Round over: ${state.hits} hits`,
      w / 2,
      h / 2,
    );
  }
  ctx.textAlign = 'start';
}

function drawDebug() {
  const d = $('debug');
  if (d.hidden) return;
  const serial = controllers.serial as WebSerialController;
  d.textContent = [
    `fps ${fps.toFixed(0)}  socket ${socket.connected ? 'up' : 'DOWN'} (${socket.io.engine?.transport?.name ?? '-'})`,
    `room ${room}  players ${roster.players.filter((p) => p.connected).length}/${roster.players.length}`,
    `controller ${active.name}: ${active.status} (${active.detail})`,
    `serial lines/s ${serial.linesPerSecond}  board info: ${serial.lastInfo || '-'}`,
    `steer raw ${currentSteer().toFixed(2)}  applied ${state.steer.toFixed(2)}  x ${state.riderX.toFixed(2)}`,
    `actions/s ${actionsPerSecond}  last relay latency ${lastLatencyMs} ms`,
    `last error ${lastError || '-'}`,
  ].join('\n');
  const cs = $('ctrl-status');
  cs.textContent = `${active.name}: ${active.status}${active.detail ? ` (${active.detail})` : ''}`;
}

requestAnimationFrame(frame);

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
import * as T from './theme';
import * as S from './scene';

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
  // Launch a snowball. Hit or miss is decided when it lands (see handleLandings).
  const {
    state: next,
    outcome,
    cooldownMs,
  } = R.throwSnowball(state, {
    aim: a.aim,
    power: a.power,
    playerId: a.playerId,
    seq: a.seq,
  });
  state = next;
  // Tell the phone so it can show its recharge bar. cooldownMs is 0 if the round isn't running.
  if (outcome === 'thrown' || cooldownMs > 0) {
    socket.emit(EV.HOST_EVENT, {
      type: outcome === 'thrown' ? 'thrown' : 'cooldown',
      playerId: a.playerId,
      actionSeq: a.seq,
      cooldownMs: Math.round(cooldownMs),
    });
  }
});

/** Turn snowballs that landed this frame into splats, phone feedback and board buzzes. */
function handleLandings(now: number) {
  for (const l of state.landed) {
    markers.push({ x: l.aim, hit: l.hit, name: names.get(l.playerId) ?? '?', born: now });
    if (markers.length > 40) markers.shift();
    socket.emit(EV.HOST_EVENT, {
      type: l.hit ? 'hit' : 'miss',
      playerId: l.playerId,
      actionSeq: l.seq,
    });
    if (l.hit) {
      active.sendHitFeedback();
      flashUntil = now + 350;
    }
  }
}

let lastPhase = state.phase;
function onPhaseChange() {
  if (state.phase === lastPhase) return;
  lastPhase = state.phase;
  if (state.phase === 'over') {
    active.setLedEffect(state.result === 'lose' ? 'hit' : 'idle');
    socket.emit(EV.HOST_STATE, R.toHostState(state)); // tell phones the result straight away
  }
}

function startRound() {
  // Count the connected phones (not the rider) so the cooldown can scale with the crowd.
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
  handleLandings(now);
  onPhaseChange();
  draw(now);
  drawDebug();
  requestAnimationFrame(frame);
}

function draw(now: number) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // 3D downhill scene: slope, trees, rider, snowballs, splats (scene.ts)
  S.drawScene(ctx, w, h, {
    state,
    now,
    hurt: now < flashUntil,
    markers,
    nameOf: (id) => names.get(id) ?? '',
  });
  T.drawHud(ctx, w, h, state, now); // timer, score, health bar, lobby / win / lose (theme.ts)
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
    `health ${state.health}  in flight ${state.snowballs.length}  result ${state.result ?? '-'}`,
    `actions/s ${actionsPerSecond}  last relay latency ${lastLatencyMs} ms`,
    `last error ${lastError || '-'}`,
  ].join('\n');
  const cs = $('ctrl-status');
  cs.textContent = `${active.name}: ${active.status}${active.detail ? ` (${active.detail})` : ''}`;
}

requestAnimationFrame(frame);

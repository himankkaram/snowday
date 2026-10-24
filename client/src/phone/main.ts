/** Phone controller page: join, throw (button always; motion optional), show feedback. */
import { EV, type HostState } from '../../../shared/protocol';
import { connect, getClientId, join, onEveryConnect } from '../net/socket';
import { aimFromGamma, enableMotion, motionMagnitude, ThrowDetector } from './motion';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const roomInput = $<HTMLInputElement>('room-input');
const nameInput = $<HTMLInputElement>('name-input');
roomInput.value = (params.get('room') ?? '').toUpperCase();
nameInput.value = localStorage.getItem('snowday.name') ?? '';

const socket = connect();
const clientId = getClientId();
let joined: { room: string; name: string } | null = null;
let seq = 0;

function setNet(text: string, cls: 'ok' | 'bad' | 'warn') {
  const n = $('net');
  n.textContent = text;
  n.className = `pill ${cls}`;
}
function feedback(text: string, cls: '' | 'hit' | 'miss' | 'err' = '') {
  const f = $('feedback');
  f.textContent = text;
  f.className = `feedback ${cls}`;
}

async function doJoin(room: string, name: string): Promise<boolean> {
  const res = await join(socket, { room, role: 'player', name, clientId });
  if (!res.ok) {
    $('join-error').textContent = res.error.message;
    return false;
  }
  joined = { room: res.room, name };
  localStorage.setItem('snowday.name', name);
  $('room').textContent = res.room;
  $('join-view').hidden = true;
  $('play-view').hidden = false;
  setNet('online', 'ok');
  return true;
}

$('join-btn').addEventListener('click', async () => {
  $('join-error').textContent = '';
  const room = roomInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();
  if (!/^[A-Z0-9]{4}$/.test(room))
    return void ($('join-error').textContent = 'Enter the 4-character room code.');
  if (!name) return void ($('join-error').textContent = 'Enter a name.');
  if (!socket.connected)
    return void ($('join-error').textContent = 'Not connected to the game yet. Check Wi-Fi.');
  await doJoin(room, name);
});

// Re-join automatically after a dropped connection (same clientId = same player slot).
onEveryConnect(socket, () => {
  setNet(joined ? 'rejoining' : 'connected', 'warn');
  if (joined) void doJoin(joined.room, joined.name);
  // Refreshed page with room in the link and a saved name: skip the form.
  else if (/^[A-Z0-9]{4}$/.test(roomInput.value) && nameInput.value)
    void doJoin(roomInput.value, nameInput.value);
});
socket.on('disconnect', () => setNet('offline', 'bad'));
socket.on(EV.ERROR, (e) => feedback(e.code === 'RATE_LIMITED' ? 'Slow down!' : e.message, 'err'));
socket.on(EV.GAME_EVENT, (e) => {
  if (e.type === 'thrown') startRecharge(e.cooldownMs ?? 0);
  else if (e.type === 'cooldown') {
    startRecharge(e.cooldownMs ?? 0);
    feedback('Recharging…');
  } else if (e.type === 'hit') {
    feedback('Hit!', 'hit');
    navigator.vibrate?.(80); // Android only; iOS ignores it
  } else feedback('Missed', 'miss');
});
socket.on(EV.STATE, (s: HostState) => {
  $('phase').textContent =
    s.phase === 'playing'
      ? `Round on: ${Math.ceil(s.timeLeftMs / 1000)} s left · ${s.score.hits} hits`
      : s.phase === 'over'
        ? `Round over: ${s.score.hits} hits`
        : 'Waiting for the round to start';
});

// ---------- throwing ----------
const aimSlider = $<HTMLInputElement>('aim');

// Recharge bar. The host decides the cooldown and tells us how long it is; this just shows it
// and stops us sending throws the host would ignore anyway.
let readyAt = 0;
function startRecharge(ms: number) {
  readyAt = performance.now() + ms;
  const fill = $('recharge-fill');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetWidth; // make the browser apply 0% before animating to 100%
  fill.style.transition = `width ${ms}ms linear`;
  fill.style.width = '100%';
  $('throw').classList.add('cooling');
  setTimeout(() => {
    if (performance.now() >= readyAt) $('throw').classList.remove('cooling');
  }, ms);
}

function sendThrow(power: number, source: 'button' | 'motion') {
  if (!joined || !socket.connected) return feedback('Not connected', 'err');
  if (performance.now() < readyAt) return feedback('Recharging…');
  // Strictly increasing even across page reloads, so the server never drops it as a replay.
  seq = Math.max(seq + 1, Date.now());
  socket.emit(EV.ACTION, { seq, action: 'throw', aim: Number(aimSlider.value), power, source });
  feedback('Thrown…');
}
$('throw').addEventListener('click', () => sendThrow(0.7, 'button'));

// ---------- optional motion controls ----------
let neutralGamma = 0;
let lastGamma = 0;
const detector = new ThrowDetector();

$('motion-btn').addEventListener('click', async () => {
  const status = $('motion-status');
  const result = await enableMotion(); // must run inside this tap on iOS
  if (result === 'insecure')
    return void (status.textContent = 'Motion needs an https:// link. Use the button instead.');
  if (result === 'unsupported')
    return void (status.textContent = 'This phone has no motion sensors. Use the button.');
  if (result === 'denied')
    return void (status.textContent = 'Motion permission was refused. Use the button.');

  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma === null) return;
    lastGamma = e.gamma;
    aimSlider.value = String(aimFromGamma(e.gamma, neutralGamma));
  });
  window.addEventListener('devicemotion', (e) => {
    const m = motionMagnitude(e);
    if (m === null) return;
    const power = detector.feed(m, performance.now());
    if (power !== null) sendThrow(power, 'motion');
    status.textContent = `Motion on. Flick to throw. (peak ${detector.peak.toFixed(0)})`;
  });
  $('calibrate-btn').hidden = false;
  $('motion-btn').hidden = true;
  status.textContent = 'Motion on. Hold the phone straight up and tap Calibrate aim.';
});
$('calibrate-btn').addEventListener('click', () => {
  neutralGamma = lastGamma;
  aimSlider.value = '0';
});

/**
 * Simulates N phones throwing at a running server, with one fake host counting what arrives.
 * Usage:  npm run load-test -- [url] [phones] [seconds]
 *   e.g.  npm run load-test -- http://localhost:3000 30 10
 * Max is LIMITS.maxPlayersPerRoom (32); the 33rd phone is refused with ROOM_FULL by design.
 * Each phone throws ~3 times a second (an enthusiastic human), well under the rate limit.
 */
import 'dotenv/config';
import { io, type Socket } from 'socket.io-client';
import {
  EV,
  makeRoomCode,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '../shared/protocol.js';

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const [url = 'http://localhost:3000', phonesArg = '30', secondsArg = '10'] = process.argv.slice(2);
const PHONES = Number(phonesArg);
const SECONDS = Number(secondsArg);
const ROOM = makeRoomCode(); // fresh room each run (old runs' players sit in the 30 s grace period)

const connect = (): Promise<S> =>
  new Promise((res, rej) => {
    const s: S = io(url, { transports: ['websocket'], forceNew: true });
    s.once('connect', () => res(s));
    s.once('connect_error', rej);
  });
const joinAs = (s: S, role: 'host' | 'player', i: number) =>
  new Promise<boolean>((res) =>
    s.emit(
      EV.JOIN,
      {
        v: PROTOCOL_VERSION,
        room: ROOM,
        role,
        name: `${role}${i}`,
        clientId: `load-${role}-${i}-${Date.now()}`,
        hostKey: process.env.HOST_KEY,
      },
      (a) => {
        if (!a.ok) console.error(`${role} ${i}: ${a.error.code} ${a.error.message}`);
        res(a.ok);
      },
    ),
  );

const host = await connect();
if (!(await joinAs(host, 'host', 0))) {
  console.error('Host join failed: is HOST_KEY in .env the same as the server uses?');
  process.exit(1);
}
const latencies: number[] = [];
let received = 0;
host.on(EV.ACTION_RELAY, (a) => {
  received++;
  latencies.push(Date.now() - Math.floor(a.seq / 1000));
});

const phones: S[] = [];
for (let i = 0; i < PHONES; i++) {
  const p = await connect();
  if (!(await joinAs(p, 'player', i))) throw new Error(`phone ${i} failed to join`);
  phones.push(p);
}
console.log(`${PHONES} phones joined room ${ROOM}; throwing for ${SECONDS}s...`);

let sent = 0;
let rateLimited = 0;
const timers = phones.map((p) => {
  p.on(EV.ERROR, (e) => e.code === 'RATE_LIMITED' && rateLimited++);
  return setInterval(
    () => {
      sent++;
      // seq = send time, so the host can compute end-to-end latency on the same machine
      p.emit(EV.ACTION, {
        seq: Date.now() * 1000 + (sent % 1000),
        action: 'throw',
        aim: Math.random() * 2 - 1,
        power: 0.5,
        source: 'button',
      });
    },
    333 + Math.random() * 50,
  );
});

await new Promise((r) => setTimeout(r, SECONDS * 1000));
timers.forEach(clearInterval);
await new Promise((r) => setTimeout(r, 500));

latencies.sort((a, b) => a - b);
const pct = (p: number) =>
  latencies.length ? Math.round(latencies[Math.floor((latencies.length - 1) * p)]!) : NaN;
console.log({
  sent,
  received,
  lost: sent - received - rateLimited,
  rateLimited,
  p50ms: pct(0.5),
  p95ms: pct(0.95),
  maxMs: pct(1),
});
[host, ...phones].forEach((s) => s.disconnect());
process.exit(received >= sent * 0.99 ? 0 : 1);

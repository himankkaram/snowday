import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGameServer } from '../server/app';
import { EV } from '../shared/protocol';
import { client, joinAs, next, sleep, type TestSocket } from './helpers';

const KEY = 'test-key';
let server: ReturnType<typeof createGameServer>;
let port: number;
const sockets: TestSocket[] = [];
const open = async () => {
  const s = await client(port);
  sockets.push(s);
  return s;
};

beforeEach(async () => {
  server = createGameServer({ hostKey: KEY });
  port = await server.listen(0);
});
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  await server.close();
});

describe('health', () => {
  it('reports ok', async () => {
    const r = await fetch(`http://localhost:${port}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });
  it('/info lists LAN addresses for the QR code', async () => {
    const r = await fetch(`http://localhost:${port}/info`);
    expect(Array.isArray((await r.json()).lan)).toBe(true);
  });
});

describe('joining', () => {
  it('rejects a host with the wrong key', async () => {
    const h = await open();
    const res = await joinAs(h, 'ABCD', 'host', { hostKey: 'nope' });
    expect(res).toMatchObject({ ok: false, error: { code: 'BAD_HOST_KEY' } });
  });
  it('rejects a player for a room with no host', async () => {
    const p = await open();
    expect(await joinAs(p, 'ZZZZ', 'player')).toMatchObject({
      ok: false,
      error: { code: 'NOT_IN_ROOM' },
    });
  });
  it('host + several players join and everyone gets the roster', async () => {
    const h = await open();
    expect((await joinAs(h, 'ABCD', 'host', { hostKey: KEY })).ok).toBe(true);
    const players = await Promise.all([open(), open(), open()]);
    for (const p of players) expect((await joinAs(p, 'ABCD', 'player')).ok).toBe(true);
    await sleep(50);
    const roster = server.rooms.get('ABCD')!.roster();
    expect(roster.players).toHaveLength(3);
    expect(roster.hostConnected).toBe(true);
  });
  it('a second live host is refused', async () => {
    const h1 = await open();
    const h2 = await open();
    await joinAs(h1, 'ABCD', 'host', { hostKey: KEY });
    expect(await joinAs(h2, 'ABCD', 'host', { hostKey: KEY })).toMatchObject({
      ok: false,
      error: { code: 'HOST_TAKEN' },
    });
  });
});

describe('end-to-end action loop', () => {
  it('player throw reaches host stamped with playerId; host outcome reaches only that player', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY });
    const p1 = await open();
    const p2 = await open();
    const a1 = await joinAs(p1, 'ABCD', 'player');
    await joinAs(p2, 'ABCD', 'player');
    if (!a1.ok) throw new Error('join failed');

    const relayed = next(h, EV.ACTION_RELAY);
    p1.emit(EV.ACTION, { seq: 1, action: 'throw', aim: 0, power: 0.7, source: 'button' });
    const action = await relayed;
    expect(action.playerId).toBe(a1.playerId);
    expect(action.aim).toBe(0);

    let p2GotEvent = false;
    p2.on(EV.GAME_EVENT, () => (p2GotEvent = true));
    const outcome = next(p1, EV.GAME_EVENT);
    h.emit(EV.HOST_EVENT, { type: 'hit', playerId: a1.playerId, actionSeq: 1 });
    expect(await outcome).toMatchObject({ type: 'hit', actionSeq: 1 });
    await sleep(50);
    expect(p2GotEvent).toBe(false);
  });

  it('host state is broadcast to players', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY });
    const p = await open();
    await joinAs(p, 'ABCD', 'player');
    const got = next(p, EV.STATE);
    h.emit(EV.HOST_STATE, {
      phase: 'playing',
      timeLeftMs: 42000,
      riderId: null,
      score: { hits: 1, throws: 3 },
    });
    expect(await got).toMatchObject({ phase: 'playing', timeLeftMs: 42000 });
  });
});

describe('abuse and bad input', () => {
  it('players cannot declare hits (host-only event)', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY });
    const p = await open();
    const a = await joinAs(p, 'ABCD', 'player');
    if (!a.ok) throw new Error();
    const err = next(p, EV.ERROR);
    p.emit(EV.HOST_EVENT, { type: 'hit', playerId: a.playerId, actionSeq: 1 });
    expect(await err).toMatchObject({ code: 'NOT_HOST' });
  });

  it('malformed messages get an error and do not crash the server', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY });
    const p = await open();
    await joinAs(p, 'ABCD', 'player');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = p as any;
    const junk = [
      null,
      'throw',
      42,
      { seq: 'x' },
      { seq: 1, action: 'throw', aim: 99, power: 1, source: 'button' },
    ];
    for (const j of junk) {
      const err = next(p, EV.ERROR);
      raw.emit(EV.ACTION, j);
      expect(await err).toMatchObject({ code: 'BAD_MESSAGE' });
    }
    raw.emit(EV.JOIN, { totally: 'wrong' }, () => {});
    raw.emit('not-a-real-event', 1, 2, 3);
    await sleep(50);
    const r = await fetch(`http://localhost:${port}/health`);
    expect((await r.json()).ok).toBe(true);
  });

  it('drops replayed/old sequence numbers', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY });
    const p = await open();
    await joinAs(p, 'ABCD', 'player');
    let count = 0;
    h.on(EV.ACTION_RELAY, () => count++);
    for (const seq of [5, 5, 3, 6])
      p.emit(EV.ACTION, { seq, action: 'throw', aim: 0, power: 1, source: 'button' });
    await sleep(150);
    expect(count).toBe(2); // 5 and 6
  });

  it('rate-limits a spamming phone', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY });
    const p = await open();
    await joinAs(p, 'ABCD', 'player');
    let relayed = 0;
    let limited = 0;
    h.on(EV.ACTION_RELAY, () => relayed++);
    p.on(EV.ERROR, (e) => e.code === 'RATE_LIMITED' && limited++);
    for (let i = 1; i <= 50; i++)
      p.emit(EV.ACTION, { seq: i, action: 'throw', aim: 0, power: 1, source: 'button' });
    await sleep(200);
    expect(relayed).toBeLessThanOrEqual(10);
    expect(limited).toBeGreaterThan(30);
  });
});

describe('reconnection', () => {
  it('a phone that drops and rejoins with the same clientId keeps its playerId', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY });
    const p = await open();
    const first = await joinAs(p, 'ABCD', 'player', { clientId: 'phone-abc-123' });
    p.disconnect();
    await sleep(100);
    expect(server.rooms.get('ABCD')!.roster().players[0]!.connected).toBe(false);
    const p2 = await open();
    const second = await joinAs(p2, 'ABCD', 'player', { clientId: 'phone-abc-123' });
    expect(first.ok && second.ok && first.playerId === second.playerId).toBe(true);
    expect(server.rooms.get('ABCD')!.roster().players).toHaveLength(1);
  });

  it('host laptop tab can be replaced after it disconnects', async () => {
    const h = await open();
    await joinAs(h, 'ABCD', 'host', { hostKey: KEY, clientId: 'laptop-tab-1' });
    h.disconnect();
    await sleep(100);
    const h2 = await open();
    expect((await joinAs(h2, 'ABCD', 'host', { hostKey: KEY, clientId: 'laptop-tab-2' })).ok).toBe(
      true,
    );
  });
});

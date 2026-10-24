import { describe, expect, it } from 'vitest';
import * as R from '../client/src/host/round';

const run = (s: R.RoundState, ms: number, steer: number) => {
  for (let t = 0; t < ms; t += 16) s = R.step(s, 16, steer);
  return s;
};

describe('round state machine', () => {
  it('does not move or tick in the lobby', () => {
    const s = run(R.newRound(), 1000, 1);
    expect(s.riderX).toBe(0);
    expect(s.timeLeftMs).toBe(R.ROUND_MS);
  });
  it('steers right with positive input and stays on screen', () => {
    const s = run(R.start(R.newRound()), 5000, 1);
    expect(s.riderX).toBeCloseTo(1 - R.RIDER_HALF_WIDTH, 5);
  });
  it('steers left with negative input', () => {
    const s = run(R.start(R.newRound()), 300, -1);
    expect(s.riderX).toBeLessThan(0);
  });
  it('ends after 60 s and stops counting', () => {
    let s = run(R.start(R.newRound()), R.ROUND_MS + 500, 0);
    expect(s.phase).toBe('over');
    expect(s.timeLeftMs).toBe(0);
    expect(R.throwSnowball(s, { aim: 0, power: 1, playerId: 'p', seq: 1 }).outcome).toBe('ignored');
  });
  it('clamps huge frame gaps (hidden tab) instead of teleporting', () => {
    const s = R.step(R.start(R.newRound()), 10_000, 1);
    expect(s.riderX).toBeLessThan(0.2);
  });
  it('reset returns to lobby with zero score', () => {
    let s = R.start(R.newRound());
    s = R.throwSnowball(s, { aim: 0, power: 1, playerId: 'p', seq: 1 }).state;
    s = run(s, 1200, 0);
    s = R.reset(s);
    expect(s).toMatchObject({
      phase: 'lobby',
      hits: 0,
      throws: 0,
      timeLeftMs: R.ROUND_MS,
      health: R.MAX_HEALTH,
      snowballs: [],
      result: null,
    });
  });
});

let seq = 0;
// Each toss comes from a different player, so the per-player cooldown never blocks these tests.
const toss = (s: R.RoundState, aim: number, power = 1) =>
  R.throwSnowball(s, { aim, power, playerId: `p${++seq}`, seq }).state;
/** Step frame by frame and collect every landing. */
const runCollect = (s: R.RoundState, ms: number, steer: number) => {
  const landed: R.Landing[] = [];
  for (let t = 0; t < ms; t += 16) {
    s = R.step(s, 16, steer);
    landed.push(...s.landed);
  }
  return { s, landed };
};

describe('snowballs', () => {
  it('a throw flies first: nothing is decided at the moment of throwing', () => {
    let s = R.start(R.newRound());
    const r = R.throwSnowball(s, { aim: 0, power: 1, playerId: 'p1', seq: 1 });
    expect(r.outcome).toBe('thrown');
    s = r.state;
    expect(s).toMatchObject({ throws: 1, hits: 0, health: 100 });
    expect(s.snowballs).toHaveLength(1);
  });
  it('harder throws fly faster', () => {
    expect(R.flightMsFor(1)).toBe(R.FLIGHT_MS_FAST);
    expect(R.flightMsFor(0)).toBe(R.FLIGHT_MS_SLOW);
    expect(R.flightMsFor(1)).toBeLessThan(R.flightMsFor(0.3));
  });
  it('hits a rider who stays put, after the flight time, and takes 10 health', () => {
    const s0 = toss(R.start(R.newRound()), 0.02);
    const early = runCollect(s0, R.FLIGHT_MS_FAST - 50, 0);
    expect(early.landed).toHaveLength(0);
    const { s, landed } = runCollect(s0, R.FLIGHT_MS_FAST + 50, 0);
    expect(landed).toEqual([
      { playerId: expect.any(String), seq: expect.any(Number), aim: 0.02, hit: true },
    ]);
    expect(s).toMatchObject({ hits: 1, health: 90 });
    expect(s.snowballs).toHaveLength(0);
  });
  it('the rider can dodge by leaning while it flies', () => {
    const s0 = toss(R.start(R.newRound()), 0, 0); // slow throw at the rider's start position
    const { s, landed } = runCollect(s0, R.FLIGHT_MS_SLOW + 50, 1); // lean right the whole time
    expect(landed[0]?.hit).toBe(false);
    expect(s).toMatchObject({ hits: 0, health: 100 });
  });
  it('a ball touching the rider edge still hits', () => {
    expect(R.isHit(R.RIDER_HALF_WIDTH + R.SNOWBALL_RADIUS - 0.001, 0)).toBe(true);
    expect(R.isHit(R.RIDER_HALF_WIDTH + R.SNOWBALL_RADIUS + 0.01, 0)).toBe(false);
  });
  it('10 hits = 0 health = rider loses and the round ends', () => {
    let s = R.start(R.newRound());
    for (let i = 0; i < 10; i++) s = toss(s, 0);
    s = toss(s, 0); // an 11th ball in the air when the rider goes down
    const r = runCollect(s, R.FLIGHT_MS_FAST + 50, 0);
    expect(r.s).toMatchObject({ phase: 'over', result: 'lose', health: 0, hits: 10 });
    expect(r.s.snowballs).toHaveLength(0);
    expect(R.toHostState(r.s)).toMatchObject({ phase: 'over', result: 'lose', health: 0 });
  });
  it('surviving the full minute with health left = rider wins', () => {
    let s = toss(R.start(R.newRound()), 0);
    s = run(s, R.ROUND_MS + 100, 0);
    expect(s).toMatchObject({ phase: 'over', result: 'win', health: 90 });
  });
  it('misses never cost health', () => {
    let s = R.start(R.newRound());
    for (let i = 0; i < 5; i++) s = toss(s, 0.9);
    s = run(s, 1200, 0);
    expect(s).toMatchObject({ health: 100, hits: 0, throws: 5 });
  });
});

describe('throw cooldown', () => {
  const throwAs = (s: R.RoundState, playerId: string) =>
    R.throwSnowball(s, { aim: 0.9, power: 1, playerId, seq: 1 });

  it('ignores a second throw from the same player too soon, and says how long is left', () => {
    let s = throwAs(R.start(R.newRound(), 1), 'a').state;
    s = run(s, 500, 0);
    const early = throwAs(s, 'a');
    expect(early.outcome).toBe('ignored');
    expect(early.cooldownMs).toBeGreaterThan(0);
    expect(early.cooldownMs).toBeLessThanOrEqual(R.throwCooldownMs(1) - 500);
  });
  it('tells the player their full cooldown when a throw goes through', () =>
    expect(throwAs(R.start(R.newRound(), 1), 'a').cooldownMs).toBe(R.throwCooldownMs(1)));
  it('allows another throw once the cooldown is over', () => {
    let s = throwAs(R.start(R.newRound(), 1), 'a').state;
    s = run(s, R.throwCooldownMs(1) + 20, 0);
    expect(throwAs(s, 'a').outcome).toBe('thrown');
  });
  it('gives each player their own cooldown', () => {
    const s = throwAs(R.start(R.newRound(), 2), 'a').state;
    expect(throwAs(s, 'b').outcome).toBe('thrown');
  });
  it('scales with players and caps out', () => {
    expect(R.throwCooldownMs(1)).toBe(R.BASE_COOLDOWN_MS);
    expect(R.throwCooldownMs(4)).toBe(2 * R.BASE_COOLDOWN_MS);
    expect(R.throwCooldownMs(100)).toBe(R.MAX_COOLDOWN_MS);
  });
});

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
    expect(R.resolveThrow(s, 0).outcome).toBe('ignored');
  });
  it('clamps huge frame gaps (hidden tab) instead of teleporting', () => {
    const s = R.step(R.start(R.newRound()), 10_000, 1);
    expect(s.riderX).toBeLessThan(0.2);
  });
  it('reset returns to lobby with zero score', () => {
    let s = R.start(R.newRound());
    s = R.resolveThrow(s, 0).state;
    s = R.reset(s);
    expect(s).toMatchObject({ phase: 'lobby', hits: 0, throws: 0, timeLeftMs: R.ROUND_MS });
  });
});

describe('snowballs', () => {
  const flight = R.SNOWBALL_FLIGHT_MS;

  it('counts the throw straight away but not the hit until it lands', () => {
    let s = R.resolveThrow(R.start(R.newRound()), 0, 'a').state;
    expect(s).toMatchObject({ throws: 1, hits: 0 });
    s = run(s, flight / 2, 0);
    expect(s.hits).toBe(0);
    expect(s.snowballs).toHaveLength(1);
  });
  it('hits a rider who stays put', () => {
    let s = R.resolveThrow(R.start(R.newRound()), 0, 'a').state;
    s = run(s, flight + 50, 0);
    expect(s).toMatchObject({ hits: 1, throws: 1 });
    expect(s.snowballs).toHaveLength(0);
  });
  it('misses when aimed away from the rider', () => {
    let s = R.resolveThrow(R.start(R.newRound()), 0.9, 'a').state;
    s = run(s, flight + 50, 0);
    expect(s).toMatchObject({ hits: 0, throws: 1 });
  });
  it('lets the rider dodge while it is in the air', () => {
    let s = R.resolveThrow(R.start(R.newRound()), 0, 'a').state;
    s = run(s, flight + 50, 1);
    expect(s).toMatchObject({ hits: 0, throws: 1 });
  });
  it('reports each landing exactly once, with the thrower and their action number', () => {
    let s = R.resolveThrow(R.start(R.newRound()), 0, 'a', 7).state;
    const landings: R.Landing[] = [];
    for (let t = 0; t < flight + 500; t += 16) {
      s = R.step(s, 16, 0);
      landings.push(...s.landed);
    }
    expect(landings).toEqual([{ playerId: 'a', seq: 7, x: 0, hit: true }]);
  });
  it('drops snowballs still in the air when the round ends', () => {
    let s = run(R.start(R.newRound()), R.ROUND_MS - 100, 0);
    s = R.resolveThrow(s, 0, 'a').state;
    s = run(s, flight + 50, 0);
    expect(s.phase).toBe('over');
    expect(s).toMatchObject({ hits: 0, throws: 1 });
    expect(s.snowballs).toHaveLength(0);
  });
});

describe('throw cooldown', () => {
  it('ignores a second throw from the same player too soon', () => {
    const s = R.resolveThrow(R.start(R.newRound(), 1), 0, 'a').state;
    expect(R.resolveThrow(s, 0, 'a').outcome).toBe('ignored');
  });
  it('allows another throw once the cooldown is over', () => {
    let s = R.resolveThrow(R.start(R.newRound(), 1), 0, 'a').state;
    s = run(s, R.throwCooldownMs(1) + 20, 0);
    expect(R.resolveThrow(s, 0, 'a').outcome).not.toBe('ignored');
  });
  it('gives each player their own cooldown', () => {
    const s = R.resolveThrow(R.start(R.newRound(), 2), 0, 'a').state;
    expect(R.resolveThrow(s, 0, 'b').outcome).not.toBe('ignored');
  });
  it('scales with players and caps out', () => {
    expect(R.throwCooldownMs(1)).toBe(R.BASE_COOLDOWN_MS);
    expect(R.throwCooldownMs(4)).toBe(2 * R.BASE_COOLDOWN_MS);
    expect(R.throwCooldownMs(100)).toBe(R.MAX_COOLDOWN_MS);
  });
});

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

describe('placeholder hit rule', () => {
  it('hits when aim is on the rider, misses otherwise, counts both', () => {
    let s = R.start(R.newRound());
    const hit = R.resolveThrow(s, 0.05);
    expect(hit.outcome).toBe('hit');
    s = hit.state;
    const miss = R.resolveThrow(s, 0.9);
    expect(miss.outcome).toBe('miss');
    expect(miss.state).toMatchObject({ hits: 1, throws: 2 });
  });
});

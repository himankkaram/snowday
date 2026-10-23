import { describe, expect, it } from 'vitest';
import { angleToSteer, applyDeadzone, smooth } from '../client/src/input/steering';
import { ThrowDetector, aimFromGamma } from '../client/src/phone/motion';

describe('steering helpers', () => {
  it('deadzone zeroes small wobble and still reaches full lock', () => {
    expect(applyDeadzone(0.05, 0.1)).toBe(0);
    expect(applyDeadzone(1, 0.1)).toBe(1);
    expect(applyDeadzone(-1, 0.1)).toBe(-1);
  });
  it('maps angle to steer relative to calibrated neutral', () => {
    expect(angleToSteer(3, 2, 15)).toBe(0); // 1 degree off neutral is inside deadzone
    expect(angleToSteer(17, 2, 15)).toBe(1);
    expect(angleToSteer(-40, 2, 15)).toBe(-1);
  });
  it('smoothing converges toward the target', () => {
    let v = 0;
    for (let i = 0; i < 60; i++) v = smooth(v, 1, 1 / 60, 0.08);
    expect(v).toBeGreaterThan(0.99);
  });
});

describe('ThrowDetector (synthetic data; real-phone tuning still needed)', () => {
  it('fires once per spike and respects cooldown', () => {
    const d = new ThrowDetector(18, 600);
    const fired: number[] = [];
    // quiet, spike lasting 5 samples, quiet, second spike too soon, then a later spike
    const samples = [
      ...Array(10).fill(1),
      ...Array(5).fill(30),
      ...Array(10).fill(1), // throw 1 at t=160
      ...Array(3).fill(30), // t=400..432: within cooldown, ignored
      ...Array(30).fill(1),
      ...Array(3).fill(25), // t=~1000: allowed
    ];
    samples.forEach((m, i) => {
      if (d.feed(m, i * 16) !== null) fired.push(i * 16);
    });
    expect(fired.length).toBe(2);
  });
  it('ignores normal handling below threshold', () => {
    const d = new ThrowDetector();
    for (let i = 0; i < 500; i++) expect(d.feed(5 + Math.sin(i) * 5, i * 16)).toBeNull();
  });
  it('aim from tilt is relative to calibration and clamped', () => {
    expect(aimFromGamma(10, 10)).toBe(0);
    expect(aimFromGamma(80, 0)).toBe(1);
  });
});

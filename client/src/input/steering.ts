/** Pure helpers for turning noisy sensor numbers into steering. Unit-tested. */

export const clamp = (v: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));

/** Ignore small wobbles around neutral, then rescale so output still reaches ±1. */
export function applyDeadzone(value: number, deadzone: number): number {
  const a = Math.abs(value);
  if (a <= deadzone) return 0;
  return Math.sign(value) * clamp((a - deadzone) / (1 - deadzone), 0, 1);
}

/**
 * Exponential smoothing (a low-pass filter). alpha=1 means no smoothing, alpha=0.1 is heavy.
 * Frame-rate independent: pass dt in seconds and a time constant tau in seconds.
 */
export function smooth(previous: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0) return target;
  const alpha = 1 - Math.exp(-dtS / tauS);
  return previous + (target - previous) * alpha;
}

/** Map a tilt angle (degrees) to [-1, 1], with `maxDeg` giving full lock. */
export function angleToSteer(
  angleDeg: number,
  neutralDeg: number,
  maxDeg: number,
  deadzone = 0.08,
): number {
  return applyDeadzone(clamp((angleDeg - neutralDeg) / maxDeg), deadzone);
}

/**
 * Phone motion: permission handling + a throw detector.
 *
 * Facts that bite (see docs/ARCHITECTURE.md for sources):
 *  - Motion/orientation events only fire in a SECURE CONTEXT (https://, or http://localhost).
 *    http://192.168.x.x from a phone is NOT secure, so you get nothing, silently.
 *  - iOS Safari additionally requires DeviceMotionEvent.requestPermission(), called from a tap.
 *  - Android Chrome needs no prompt, but still needs HTTPS.
 *
 * STATUS: detector logic is unit-tested with synthetic data; thresholds are NOT yet tuned on
 * real phones. Tune THROW_THRESHOLD with the debug readout on the phone page.
 */

type PermissionFn = () => Promise<'granted' | 'denied'>;

export type MotionAvailability = 'ok' | 'insecure' | 'unsupported' | 'denied';

export async function enableMotion(): Promise<MotionAvailability> {
  if (!window.isSecureContext) return 'insecure';
  if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
  const motionReq = (DeviceMotionEvent as unknown as { requestPermission?: PermissionFn })
    .requestPermission;
  const orientReq = (DeviceOrientationEvent as unknown as { requestPermission?: PermissionFn })
    .requestPermission;
  try {
    // iOS: request both inside the same tap. Start both before awaiting either, because
    // awaiting the first can use up the tap's "user activation" before the second call.
    const results = await Promise.all([motionReq?.() ?? 'granted', orientReq?.() ?? 'granted']);
    if (results.some((r) => r !== 'granted')) return 'denied';
  } catch {
    return 'denied';
  }
  return 'ok';
}

export const THROW_THRESHOLD = 18; // m/s^2 of linear acceleration; a flick is ~20-40
export const THROW_COOLDOWN_MS = 600;
export const THROW_MAX_FOR_POWER = 40;

/**
 * Detects a sharp spike in acceleration. Fires once on the rising edge, then waits for the
 * cooldown AND for the signal to settle, so one throw can't fire twice.
 */
export class ThrowDetector {
  private lastFire = -Infinity;
  private armed = true;
  peak = 0;

  constructor(
    private threshold = THROW_THRESHOLD,
    private cooldownMs = THROW_COOLDOWN_MS,
  ) {}

  /** Feed one sample. Returns a power in (0, 1] when a throw is detected, else null. */
  feed(magnitude: number, tMs: number): number | null {
    this.peak = Math.max(this.peak * 0.95, magnitude);
    if (!this.armed) {
      if (magnitude < this.threshold * 0.5 && tMs - this.lastFire >= this.cooldownMs)
        this.armed = true;
      return null;
    }
    if (magnitude >= this.threshold) {
      this.armed = false;
      this.lastFire = tMs;
      return Math.min(1, magnitude / THROW_MAX_FOR_POWER);
    }
    return null;
  }
}

/** Linear acceleration magnitude from a DeviceMotionEvent, falling back to gravity-included. */
export function motionMagnitude(e: DeviceMotionEvent): number | null {
  const a = e.acceleration;
  if (a && a.x !== null && a.y !== null && a.z !== null) return Math.hypot(a.x, a.y, a.z);
  const g = e.accelerationIncludingGravity;
  if (g && g.x !== null && g.y !== null && g.z !== null)
    return Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
  return null;
}

/**
 * Aim from left/right tilt of the phone in portrait (DeviceOrientationEvent.gamma,
 * -90..90 degrees). `neutral` is captured when the player taps "Calibrate".
 * Hold the phone tilted back a bit, like reading it: if it's held dead upright, gamma gets
 * jumpy and can flip sign, which makes the aim swing about.
 */
export function aimFromGamma(gamma: number, neutral: number, maxDeg = 35): number {
  return Math.max(-1, Math.min(1, (gamma - neutral) / maxDeg));
}

/** How far back to look for the aim when a flick is detected. */
export const AIM_LOOKBACK_MS = 250;
/** Smoothing for the aim. Lower = steadier but slower to follow the phone. */
export const AIM_SMOOTHING = 0.3;

/**
 * Remembers recent aim values. By the time a flick is detected, the phone has already been
 * swung and tilted by the throw itself, so the aim *at that moment* is junk. Using the aim
 * from just before the flick started gives the direction the player was actually pointing.
 */
export class AimHistory {
  private samples: { t: number; aim: number }[] = [];

  constructor(private keepMs = 1000) {}

  push(aim: number, tMs: number) {
    this.samples.push({ t: tMs, aim });
    while (this.samples.length > 1 && tMs - this.samples[0]!.t > this.keepMs) this.samples.shift();
  }

  /** The aim as it was `ms` before `tMs`, or the oldest one we have, or 0 if none yet. */
  before(tMs: number, ms = AIM_LOOKBACK_MS): number {
    const target = tMs - ms;
    let best: number | null = null;
    for (const s of this.samples) {
      if (s.t <= target) best = s.aim;
      else break;
    }
    return best ?? this.samples[0]?.aim ?? 0;
  }
}

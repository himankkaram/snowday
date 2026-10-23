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
 * Aim from left/right tilt of the phone held upright in portrait (DeviceOrientationEvent.gamma,
 * -90..90 degrees). `neutral` is captured when the player taps "Calibrate".
 */
export function aimFromGamma(gamma: number, neutral: number, maxDeg = 35): number {
  return Math.max(-1, Math.min(1, (gamma - neutral) / maxDeg));
}

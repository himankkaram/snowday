/**
 * Token bucket: each key gets `ratePerSec` tokens per second, up to `burst`.
 * Pure and clock-injectable so it can be unit tested.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private ratePerSec: number,
    private burst: number = ratePerSec,
    private now: () => number = Date.now,
  ) {}

  /** Returns true if the event is allowed (and consumes a token). */
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, last: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.last) / 1000) * this.ratePerSec);
    b.last = t;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(key, b);
    return allowed;
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }
}

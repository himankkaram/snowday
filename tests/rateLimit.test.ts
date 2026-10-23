import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../server/rateLimit';

describe('RateLimiter', () => {
  it('allows a burst then blocks, then refills over time', () => {
    let t = 0;
    const rl = new RateLimiter(4, 4, () => t);
    for (let i = 0; i < 4; i++) expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    t += 250; // one token at 4/s
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });
  it('tracks keys independently', () => {
    const rl = new RateLimiter(1, 1, () => 0);
    expect(rl.take('a')).toBe(true);
    expect(rl.take('b')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });
});

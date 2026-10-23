import { describe, expect, it } from 'vitest';
import { MockController } from '../client/src/input/mock';
import * as R from '../client/src/host/round';

describe('mock hardware controller', () => {
  it('reports steering and records feedback while connected', async () => {
    let t = 0;
    const c = new MockController(() => t);
    await c.connect();
    t = 1400; // ~quarter period
    expect(Math.abs(c.readSteering())).toBeGreaterThan(0.5);
    c.sendHitFeedback();
    c.setLedEffect('hit');
    expect(c.hits).toBe(1);
    expect(c.led).toBe('hit');
  });

  it('a disconnected controller reads neutral, so the game keeps running (keyboard still applies)', async () => {
    let t = 1400;
    const c = new MockController(() => t);
    await c.connect();
    c.fail();
    expect(c.status).toBe('error');
    expect(c.readSteering()).toBe(0);
    // Host combines device + keyboard; with the device dead, keyboard alone still steers.
    const keyboardSteer = 1;
    const steer = c.readSteering() + keyboardSteer;
    let s = R.start(R.newRound());
    for (let i = 0; i < 30; i++) s = R.step(s, 16, steer);
    expect(s.riderX).toBeGreaterThan(0);
  });
});

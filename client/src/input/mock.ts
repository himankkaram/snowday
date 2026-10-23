import type { LedEffect } from '../../../shared/protocol';
import type { SteeringController, ControllerStatus } from './controller';

/**
 * Pretends to be the board: sways side to side and records feedback calls.
 * Use it to develop the game before the hardware works, and in tests.
 * `fail()` simulates a yanked USB cable.
 */
export class MockController implements SteeringController {
  readonly name = 'Mock board';
  status: ControllerStatus = 'disconnected';
  detail = 'simulated sway';
  hits = 0;
  led: LedEffect = 'off';
  private t0 = 0;

  constructor(private now: () => number = () => performance.now()) {}

  async connect() {
    this.t0 = this.now();
    this.status = 'connected';
    this.detail = 'simulated sway';
  }
  readSteering() {
    if (this.status !== 'connected') return 0;
    return Math.sin((this.now() - this.t0) / 900) * 0.8;
  }
  sendHitFeedback() {
    if (this.status === 'connected') this.hits++;
  }
  setLedEffect(effect: LedEffect) {
    if (this.status === 'connected') this.led = effect;
  }
  recalibrate() {
    this.t0 = this.now();
  }
  fail(reason = 'cable unplugged (simulated)') {
    this.status = 'error';
    this.detail = reason;
  }
  async disconnect() {
    this.status = 'disconnected';
  }
}

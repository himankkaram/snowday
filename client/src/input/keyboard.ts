import type { SteeringController, ControllerStatus } from './controller';

/** Arrow keys or A/D. Always available: this is the demo's last line of defence. */
export class KeyboardController implements SteeringController {
  readonly name = 'Keyboard';
  status: ControllerStatus = 'disconnected';
  detail = '← → or A / D';
  private left = false;
  private right = false;

  private onDown = (e: KeyboardEvent) => this.set(e.key, true);
  private onUp = (e: KeyboardEvent) => this.set(e.key, false);

  private set(key: string, down: boolean) {
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') this.left = down;
    if (key === 'ArrowRight' || key === 'd' || key === 'D') this.right = down;
  }

  async connect() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.release);
    this.status = 'connected';
  }

  private release = () => {
    this.left = this.right = false;
  };

  readSteering() {
    return (this.right ? 1 : 0) - (this.left ? 1 : 0);
  }
  sendHitFeedback() {}
  setLedEffect() {}
  recalibrate() {}

  async disconnect() {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.release);
    this.release();
    this.status = 'disconnected';
  }
}

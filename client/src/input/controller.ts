/**
 * Every steering device (keyboard, mock, USB board, a phone) implements this.
 * The game only ever calls these methods, so swapping devices never touches game code.
 */
import type { LedEffect } from '../../../shared/protocol';

export type ControllerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SteeringController {
  readonly name: string;
  status: ControllerStatus;
  /** Last error or info message, for the debug overlay. */
  detail: string;
  connect(): Promise<void>;
  /** Latest steering value in [-1, 1]. Must be cheap: called every frame. */
  readSteering(): number;
  sendHitFeedback(): void;
  setLedEffect(effect: LedEffect): void;
  /** Ask the device to treat its current position as neutral. */
  recalibrate(): void;
  disconnect(): Promise<void>;
}

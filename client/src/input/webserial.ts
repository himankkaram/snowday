/**
 * The physical board over USB, via the Web Serial API (Chrome / Edge desktop only).
 * Line protocol is defined in shared/protocol.ts.
 *
 * STATUS: written against the Web Serial spec; NOT yet tested with a real board.
 * First run: click "Connect board", pick the ESP32's port in Chrome's dialog.
 * After that, Chrome remembers the permission and we re-open it automatically on replug.
 */
import { parseBoardLine, SERIAL_BAUD, type LedEffect } from '../../../shared/protocol';
import type { SteeringController, ControllerStatus } from './controller';

const STALE_AFTER_MS = 500;

export class WebSerialController implements SteeringController {
  readonly name = 'USB board';
  status: ControllerStatus = 'disconnected';
  detail = 'not connected';
  lastInfo = '';
  linesPerSecond = 0;

  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private readDone: Promise<void> | null = null;
  private steer = 0;
  private lastLineAt = 0;
  private lineCount = 0;
  private rateTimer: number | undefined;
  private encoder = new TextEncoder();

  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  constructor() {
    if (!WebSerialController.supported()) return;
    // Board unplugged: drop to neutral immediately so the rider doesn't drift.
    navigator.serial.addEventListener('disconnect', (e) => {
      if (this.port && e.target === this.port) {
        this.status = 'error';
        this.detail = 'board unplugged; replug to reconnect';
        void this.teardown();
      }
    });
    // Board plugged back in: if we've been granted this port before, reopen without a prompt.
    navigator.serial.addEventListener('connect', (e) => {
      if (this.status !== 'connected') void this.open(e.target as SerialPort);
    });
  }

  /** Must be called from a click handler the first time (browser permission rule). */
  async connect() {
    if (!WebSerialController.supported()) {
      this.status = 'error';
      this.detail = 'Web Serial needs desktop Chrome or Edge';
      return;
    }
    this.status = 'connecting';
    try {
      const known = await navigator.serial.getPorts();
      const port = known[0] ?? (await navigator.serial.requestPort());
      await this.open(port);
    } catch (err) {
      this.status = 'error';
      this.detail = err instanceof Error ? err.message : String(err);
    }
  }

  private async open(port: SerialPort) {
    try {
      await port.open({ baudRate: SERIAL_BAUD });
    } catch (err) {
      // "already open" happens if Arduino IDE's Serial Monitor is still open.
      this.status = 'error';
      this.detail = `could not open port (is Serial Monitor open?) ${err instanceof Error ? err.message : ''}`;
      return;
    }
    this.port = port;
    this.status = 'connected';
    this.detail = 'waiting for data';
    this.readDone = this.readLoop(port);
    this.rateTimer = window.setInterval(() => {
      this.linesPerSecond = this.lineCount;
      this.lineCount = 0;
    }, 1000);
    this.setLedEffect('idle');
  }

  private async readLoop(port: SerialPort) {
    if (!port.readable) return;
    const decoder = new TextDecoderStream();
    const piped = port.readable
      .pipeTo(decoder.writable as WritableStream<Uint8Array>)
      .catch(() => {});
    this.reader = decoder.readable.getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          this.handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
        if (buffer.length > 1000) buffer = ''; // garbage with no newlines: resync
      }
    } catch (err) {
      this.status = 'error';
      this.detail = `read failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.reader?.releaseLock();
      await piped;
    }
  }

  private handleLine(line: string) {
    const parsed = parseBoardLine(line);
    if (!parsed) return;
    if (parsed.kind === 'steer') {
      this.steer = parsed.value;
      this.lastLineAt = performance.now();
      this.lineCount++;
      this.detail = 'streaming';
    } else {
      this.lastInfo = parsed.text;
    }
  }

  readSteering() {
    if (this.status !== 'connected') return 0;
    if (performance.now() - this.lastLineAt > STALE_AFTER_MS) {
      this.detail = 'no data from board';
      return 0;
    }
    return this.steer;
  }

  private write(text: string) {
    const w = this.port?.writable;
    if (!w || w.locked) return;
    const writer = w.getWriter();
    writer
      .write(this.encoder.encode(text + '\n'))
      .catch(() => {})
      .finally(() => writer.releaseLock());
  }

  sendHitFeedback() {
    this.write('H');
  }
  setLedEffect(effect: LedEffect) {
    this.write(`L,${effect}`);
  }
  recalibrate() {
    this.write('C');
  }

  private async teardown() {
    window.clearInterval(this.rateTimer);
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    await this.readDone;
    try {
      await this.port?.close();
    } catch {
      /* already closed or unplugged */
    }
    this.port = null;
    this.reader = null;
    this.steer = 0;
  }

  async disconnect() {
    await this.teardown();
    this.status = 'disconnected';
    this.detail = 'not connected';
  }
}

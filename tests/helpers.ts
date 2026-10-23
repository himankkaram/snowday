import { io as ioc, type Socket } from 'socket.io-client';
import {
  EV,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type JoinAck,
  type ServerToClientEvents,
} from '../shared/protocol';

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function client(port: number): Promise<TestSocket> {
  const s: TestSocket = ioc(`http://localhost:${port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  return new Promise((res, rej) => {
    s.once('connect', () => res(s));
    s.once('connect_error', rej);
  });
}

let n = 0;
export function joinAs(
  s: TestSocket,
  room: string,
  role: 'host' | 'player',
  extra: { hostKey?: string; clientId?: string; name?: string } = {},
): Promise<JoinAck> {
  n++;
  return new Promise((res) =>
    s.emit(
      EV.JOIN,
      {
        v: PROTOCOL_VERSION,
        room,
        role,
        name: extra.name ?? `${role}${n}`,
        clientId: extra.clientId ?? `test-client-${n}-${Math.random().toString(36).slice(2, 10)}`,
        hostKey: extra.hostKey,
      },
      res,
    ),
  );
}

export function next<E extends keyof ServerToClientEvents>(
  s: TestSocket,
  ev: E,
  timeoutMs = 2000,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${String(ev)}`)), timeoutMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any).once(ev, (payload: any) => {
      clearTimeout(t);
      res(payload);
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Typed Socket.IO client + helpers shared by the host screen and the phone page.
 * Connects to the same origin the page was served from (Vite proxies /socket.io in dev).
 */
import { io, type Socket } from 'socket.io-client';
import {
  EV,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type JoinAck,
  type ServerToClientEvents,
} from '../../../shared/protocol';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function connect(): GameSocket {
  return io({
    transports: ['websocket', 'polling'], // try WebSocket first; fall back if a proxy blocks it
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
  });
}

/** Stable per-device id. Survives refreshes so the server can give the slot back. */
export function getClientId(storageKey = 'snowday.clientId'): string {
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(storageKey, id);
    return id;
  } catch {
    // Private mode / storage blocked: identity lasts for this page load only.
    return crypto.randomUUID();
  }
}

export function join(
  socket: GameSocket,
  args: { room: string; role: 'host' | 'player'; name: string; clientId: string; hostKey?: string },
): Promise<JoinAck> {
  return new Promise((resolve) => {
    socket
      .timeout(5000)
      .emit(EV.JOIN, { v: PROTOCOL_VERSION, ...args }, (err: Error | null, res: JoinAck) => {
        if (err)
          resolve({
            ok: false,
            error: { code: 'NOT_IN_ROOM', message: 'server did not answer (timeout)' },
          });
        else resolve(res);
      });
  });
}

/**
 * Re-run `onConnect` on every (re)connection. Socket.IO reconnects automatically,
 * but room membership lives on the server per socket, so we must re-join each time.
 */
export function onEveryConnect(socket: GameSocket, onConnect: () => void): void {
  socket.on('connect', onConnect);
  if (socket.connected) onConnect();
}

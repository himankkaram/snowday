/**
 * The ONE place that defines every message between host screen, phones, server and hardware.
 * Server and both clients import this file, so a renamed field breaks the typecheck
 * instead of silently breaking the game.
 *
 * Rule of thumb: phones send INTENT ("I threw, aiming here"), never OUTCOMES ("I hit").
 * The host screen runs the simulation and decides outcomes.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ---------- Limits (shared so client and server agree) ----------
export const LIMITS = {
  nameMaxLength: 16,
  roomCodeLength: 4,
  maxPlayersPerRoom: 32,
  /** Max player:action messages per second per socket. */
  actionsPerSecond: 8,
  /** Max host:state messages per second (host broadcasts ~10/s). */
  hostStatesPerSecond: 30,
  /** How long a disconnected player keeps their slot (ms). */
  reconnectGraceMs: 30_000,
} as const;

// ---------- Event names ----------
export const EV = {
  // client -> server
  JOIN: 'room:join',
  LEAVE: 'room:leave',
  ACTION: 'player:action',
  HOST_STATE: 'host:state',
  HOST_EVENT: 'host:event',
  // server -> client
  ROSTER: 'room:roster',
  ACTION_RELAY: 'host:action', // server -> host: a player's action, stamped with playerId
  STATE: 'game:state',
  GAME_EVENT: 'game:event',
  ERROR: 'app:error',
} as const;

// ---------- Primitive schemas ----------
const roomCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/, 'room code must be 4 letters/digits');

const name = z
  .string()
  .trim()
  .min(1, 'name required')
  .max(LIMITS.nameMaxLength)
  // printable characters only; strips control characters / zero-width tricks
  .regex(/^[\p{L}\p{N} _\-.!?'*~]+$/u, 'name has unsupported characters');

/** Stable per-device id stored in localStorage so a refreshed phone keeps its identity. */
const clientId = z.string().regex(/^[a-zA-Z0-9-]{8,64}$/);

/** A number in [-1, 1]; used for steering and horizontal aim. */
export const unit = z.number().finite().min(-1).max(1);

// ---------- Client -> server ----------
export const JoinSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  room: roomCode,
  role: z.enum(['host', 'player']),
  name,
  clientId,
  hostKey: z.string().max(200).optional(),
});
export type JoinMsg = z.infer<typeof JoinSchema>;

export const ActionSchema = z.object({
  /** Increasing per-client counter; server drops repeats/old ones. */
  seq: z.number().int().nonnegative(),
  /** Only 'throw' today. Add new actions here, never ad hoc. */
  action: z.enum(['throw']),
  /** Horizontal aim: -1 = far left of the screen, 1 = far right. */
  aim: unit,
  /** 0..1, from button (fixed) or gesture strength. */
  power: z.number().finite().min(0).max(1),
  source: z.enum(['button', 'motion']),
});
export type ActionMsg = z.infer<typeof ActionSchema>;

export const PhaseSchema = z.enum(['lobby', 'playing', 'over']);
export type Phase = z.infer<typeof PhaseSchema>;

export const HostStateSchema = z.object({
  phase: PhaseSchema,
  timeLeftMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60_000),
  riderId: z.string().max(64).nullable(),
  score: z.object({ hits: z.number().int().min(0), throws: z.number().int().min(0) }),
});
export type HostState = z.infer<typeof HostStateSchema>;

/** Outcomes decided by the host and pushed back to individual players. */
export const HostEventSchema = z.object({
  type: z.enum(['hit', 'miss']),
  /** Which player's action caused it (player gets "You hit!" feedback). */
  playerId: z.string().max(64),
  actionSeq: z.number().int().nonnegative(),
});
export type HostEvent = z.infer<typeof HostEventSchema>;

// ---------- Server -> client ----------
export interface PlayerInfo {
  id: string;
  name: string;
  connected: boolean;
}
export interface Roster {
  room: string;
  hostConnected: boolean;
  players: PlayerInfo[];
}
export interface ActionRelay extends ActionMsg {
  playerId: string;
  /** Server receive time (ms since epoch), for latency debugging. */
  serverTime: number;
}
export interface AppError {
  code:
    | 'BAD_MESSAGE'
    | 'RATE_LIMITED'
    | 'NOT_IN_ROOM'
    | 'ROOM_FULL'
    | 'HOST_TAKEN'
    | 'BAD_HOST_KEY'
    | 'NOT_HOST';
  message: string;
}
export type JoinAck = { ok: true; playerId: string; room: string } | { ok: false; error: AppError };

// Socket.IO typed event maps (server and clients both use these).
export interface ClientToServerEvents {
  [EV.JOIN]: (msg: JoinMsg, ack: (res: JoinAck) => void) => void;
  [EV.LEAVE]: () => void;
  [EV.ACTION]: (msg: ActionMsg) => void;
  [EV.HOST_STATE]: (msg: HostState) => void;
  [EV.HOST_EVENT]: (msg: HostEvent) => void;
}
export interface ServerToClientEvents {
  [EV.ROSTER]: (roster: Roster) => void;
  [EV.ACTION_RELAY]: (msg: ActionRelay) => void;
  [EV.STATE]: (msg: HostState) => void;
  [EV.GAME_EVENT]: (msg: HostEvent) => void;
  [EV.ERROR]: (err: AppError) => void;
}

// ---------- Hardware (USB serial line protocol) ----------
// Board -> host, one line each, newline-terminated, 115200 baud:
//   S,<steer>      steer in [-1,1], e.g. "S,-0.42"  (~50 lines/s)
//   I,<text>       info/log line, ignored by the game, shown in debug overlay
// Host -> board:
//   H              hit feedback (flash + buzz)
//   L,<effect>     LED effect: off | idle | warn | hit
//   C              recalibrate neutral (rider stands still, level)
export const SERIAL_BAUD = 115200;
export type LedEffect = 'off' | 'idle' | 'warn' | 'hit';

/** Parse one line from the board. Returns null for anything that isn't a valid steer line. */
export function parseBoardLine(
  line: string,
): { kind: 'steer'; value: number } | { kind: 'info'; text: string } | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('S,')) {
    const num = trimmed.slice(2);
    if (!/^-?\d+(\.\d+)?$/.test(num)) return null; // rejects '', 'abc', '1e9' (Number('') is 0!)
    const value = Number(num);
    if (!Number.isFinite(value)) return null;
    return { kind: 'steer', value: Math.max(-1, Math.min(1, value)) };
  }
  if (trimmed.startsWith('I,')) return { kind: 'info', text: trimmed.slice(2, 200) };
  return null;
}

export function makeRoomCode(rand: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let code = '';
  for (let i = 0; i < LIMITS.roomCodeLength; i++)
    code += alphabet[Math.floor(rand() * alphabet.length)];
  return code;
}

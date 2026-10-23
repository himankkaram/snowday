/**
 * createGameServer() builds the HTTP + Socket.IO server without starting it on a fixed port,
 * so tests can spin one up on a random port.
 *
 * The server is a RELAY with validation:
 *   phones --player:action--> server --host:action--> host screen (runs the game)
 *   host --host:state--> server --game:state--> everyone in the room
 *   host --host:event--> server --game:event--> the one player it concerns
 * It never decides hits. It does decide who is allowed to say what.
 */
import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { Server, type Socket } from 'socket.io';
import type { ZodSchema } from 'zod';
import {
  ActionSchema,
  EV,
  HostEventSchema,
  HostStateSchema,
  JoinSchema,
  LIMITS,
  type AppError,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '../shared/protocol.js';
import { Room } from './rooms.js';
import { RateLimiter } from './rateLimit.js';
import { log } from './logger.js';

export interface GameServerOptions {
  hostKey: string;
  staticDir?: string; // serve built client from here if it exists
}

interface SocketData {
  room?: string;
}

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export function createGameServer(opts: GameServerOptions) {
  const app = express();
  const httpServer: HttpServer = createServer(app);
  const io: IO = new Server(httpServer, {
    cors: { origin: true },
    pingInterval: 5000, // notice dead phones within ~10 s instead of the default ~45 s
    pingTimeout: 5000,
    maxHttpBufferSize: 16 * 1024, // no message we send is anywhere near 16 kB
  });

  const rooms = new Map<string, Room>();
  const actionLimiter = new RateLimiter(LIMITS.actionsPerSecond, LIMITS.actionsPerSecond);
  const hostLimiter = new RateLimiter(LIMITS.hostStatesPerSecond, LIMITS.hostStatesPerSecond);
  const startedAt = Date.now();
  let messagesRejected = 0;

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      rooms: [...rooms.values()].map((r) => ({ code: r.code, ...summary(r) })),
      sockets: io.engine.clientsCount,
      messagesRejected,
    });
  });

  /** LAN addresses, so a host page opened at localhost can still show a QR code phones can use. */
  app.get('/info', (_req, res) => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i!.address);
    res.json({ lan });
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    log.info(`serving built client from ${opts.staticDir}`);
  }

  function summary(r: Room) {
    const ro = r.roster();
    return { hostConnected: ro.hostConnected, players: ro.players.length };
  }

  function sendError(socket: GameSocket, code: AppError['code'], message: string) {
    messagesRejected++;
    socket.emit(EV.ERROR, { code, message });
  }

  /** Validate a payload; on failure tell the sender and return null. Never throws. */
  function parse<T>(
    socket: GameSocket,
    schema: ZodSchema<T>,
    raw: unknown,
    what: string,
  ): T | null {
    const r = schema.safeParse(raw);
    if (!r.success) {
      const issue = r.error.issues[0];
      log.warn(`bad ${what} from ${socket.id}: ${issue?.path.join('.')} ${issue?.message}`);
      sendError(socket, 'BAD_MESSAGE', `invalid ${what}: ${issue?.message ?? 'malformed'}`);
      return null;
    }
    return r.data;
  }

  function broadcastRoster(room: Room) {
    io.to(room.code).emit(EV.ROSTER, room.roster());
  }

  function currentMember(socket: GameSocket) {
    const room = socket.data.room ? rooms.get(socket.data.room) : undefined;
    const member = room?.bySocket(socket.id);
    return room && member ? { room, member } : null;
  }

  io.on('connection', (socket: GameSocket) => {
    log.debug(`connect ${socket.id}`);

    socket.on(EV.JOIN, (raw, ack) => {
      if (typeof ack !== 'function')
        return sendError(socket, 'BAD_MESSAGE', 'join needs an ack callback');
      const msg = parse(socket, JoinSchema, raw, 'join');
      if (!msg) return ack({ ok: false, error: { code: 'BAD_MESSAGE', message: 'invalid join' } });

      if (msg.role === 'host' && msg.hostKey !== opts.hostKey) {
        log.warn(`rejected host claim for ${msg.room} from ${socket.id}`);
        return ack({ ok: false, error: { code: 'BAD_HOST_KEY', message: 'wrong host key' } });
      }
      // A player can only join a room that a host created.
      let room = rooms.get(msg.room);
      if (!room) {
        if (msg.role !== 'host') {
          return ack({
            ok: false,
            error: { code: 'NOT_IN_ROOM', message: `room ${msg.room} does not exist` },
          });
        }
        room = new Room(msg.room);
        rooms.set(msg.room, room);
      }
      const res = room.join(
        { clientId: msg.clientId, name: msg.name, role: msg.role, socketId: socket.id },
        randomUUID,
      );
      if (!res.ok) return ack(res);

      socket.data.room = room.code;
      void socket.join(room.code);
      log.info(
        `${msg.role} "${msg.name}" joined ${room.code} (${res.member.playerId.slice(0, 8)})`,
      );
      ack({ ok: true, playerId: res.member.playerId, room: room.code });
      broadcastRoster(room);
    });

    socket.on(EV.ACTION, (raw) => {
      const ctx = currentMember(socket);
      if (!ctx || ctx.member.role !== 'player')
        return sendError(socket, 'NOT_IN_ROOM', 'join a room as a player first');
      if (!actionLimiter.take(socket.id)) return sendError(socket, 'RATE_LIMITED', 'slow down');
      const msg = parse(socket, ActionSchema, raw, 'action');
      if (!msg) return;
      if (msg.seq <= ctx.member.lastSeq) {
        log.debug(`stale action seq ${msg.seq} <= ${ctx.member.lastSeq}`);
        return; // duplicate or replayed: drop silently
      }
      ctx.member.lastSeq = msg.seq;
      const host = ctx.room.host;
      if (!host?.socketId) return; // nobody to play against; drop
      io.to(host.socketId).emit(EV.ACTION_RELAY, {
        ...msg,
        playerId: ctx.member.playerId,
        serverTime: Date.now(),
      });
      log.debug(`action ${msg.action} from ${ctx.member.name}`, msg);
    });

    socket.on(EV.HOST_STATE, (raw) => {
      const ctx = currentMember(socket);
      if (!ctx || ctx.member.role !== 'host')
        return sendError(socket, 'NOT_HOST', 'only the host sends state');
      if (!hostLimiter.take(socket.id)) return; // host spam is a bug, not an attack; drop quietly
      const msg = parse(socket, HostStateSchema, raw, 'host state');
      if (!msg) return;
      socket.to(ctx.room.code).emit(EV.STATE, msg);
    });

    socket.on(EV.HOST_EVENT, (raw) => {
      const ctx = currentMember(socket);
      if (!ctx || ctx.member.role !== 'host')
        return sendError(socket, 'NOT_HOST', 'only the host sends events');
      const msg = parse(socket, HostEventSchema, raw, 'host event');
      if (!msg) return;
      const target = ctx.room.byPlayerId(msg.playerId);
      if (target?.socketId) io.to(target.socketId).emit(EV.GAME_EVENT, msg);
    });

    socket.on(EV.LEAVE, () => {
      const ctx = currentMember(socket);
      if (!ctx) return;
      ctx.room.remove(ctx.member.clientId);
      void socket.leave(ctx.room.code);
      socket.data.room = undefined;
      broadcastRoster(ctx.room);
    });

    socket.on('disconnect', (reason) => {
      actionLimiter.forget(socket.id);
      hostLimiter.forget(socket.id);
      const room = socket.data.room ? rooms.get(socket.data.room) : undefined;
      const m = room?.markDisconnected(socket.id, Date.now());
      if (room && m) {
        log.info(`${m.role} "${m.name}" disconnected from ${room.code} (${reason}); holding slot`);
        broadcastRoster(room);
      }
    });
  });

  // Housekeeping: expire disconnected members, delete empty rooms.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.sweep(now)) broadcastRoster(room);
      if (room.isEmpty()) rooms.delete(code);
    }
  }, 5000);

  return {
    app,
    io,
    httpServer,
    rooms,
    listen(port: number) {
      return new Promise<number>((res) => {
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          res(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    async close() {
      clearInterval(sweeper);
      await io.close(); // also closes httpServer
    },
  };
}

export const DEFAULT_STATIC_DIR = resolve(process.cwd(), 'dist/client');

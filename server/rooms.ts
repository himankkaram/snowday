/**
 * Room bookkeeping with no networking inside, so it can be unit tested directly.
 * One host per room; any number of players up to LIMITS.maxPlayersPerRoom.
 * Players are keyed by clientId so a refreshed phone gets its old slot back.
 */
import { LIMITS, type AppError, type PlayerInfo, type Roster } from '../shared/protocol.js';

export interface Member {
  playerId: string;
  clientId: string;
  name: string;
  role: 'host' | 'player';
  socketId: string | null; // null while disconnected (grace period)
  disconnectedAt: number | null;
  lastSeq: number;
}

export class Room {
  readonly members = new Map<string, Member>(); // by clientId

  constructor(readonly code: string) {}

  get host(): Member | undefined {
    for (const m of this.members.values()) if (m.role === 'host') return m;
    return undefined;
  }

  join(
    args: { clientId: string; name: string; role: 'host' | 'player'; socketId: string },
    newId: () => string,
  ): { ok: true; member: Member } | { ok: false; error: AppError } {
    const existing = this.members.get(args.clientId);
    if (existing) {
      // Reconnect: same device, take the slot back.
      if (existing.role !== args.role) {
        return {
          ok: false,
          error: { code: 'BAD_MESSAGE', message: 'role changed; reload the page' },
        };
      }
      existing.socketId = args.socketId;
      existing.disconnectedAt = null;
      existing.name = args.name;
      return { ok: true, member: existing };
    }
    if (args.role === 'host') {
      const h = this.host;
      if (h && h.socketId !== null) {
        return {
          ok: false,
          error: { code: 'HOST_TAKEN', message: 'this room already has a live host screen' },
        };
      }
      if (h) this.members.delete(h.clientId); // replace a disconnected host (e.g. new laptop tab)
    } else if (this.playerCount() >= LIMITS.maxPlayersPerRoom) {
      return { ok: false, error: { code: 'ROOM_FULL', message: 'room is full' } };
    }
    const member: Member = {
      playerId: newId(),
      clientId: args.clientId,
      name: args.name,
      role: args.role,
      socketId: args.socketId,
      disconnectedAt: null,
      lastSeq: -1,
    };
    this.members.set(args.clientId, member);
    return { ok: true, member };
  }

  markDisconnected(socketId: string, now: number): Member | undefined {
    for (const m of this.members.values()) {
      if (m.socketId === socketId) {
        m.socketId = null;
        m.disconnectedAt = now;
        return m;
      }
    }
    return undefined;
  }

  remove(clientId: string): void {
    this.members.delete(clientId);
  }

  /** Drop members whose grace period expired. Returns true if anything changed. */
  sweep(now: number): boolean {
    let changed = false;
    for (const m of [...this.members.values()]) {
      if (m.disconnectedAt !== null && now - m.disconnectedAt > LIMITS.reconnectGraceMs) {
        this.members.delete(m.clientId);
        changed = true;
      }
    }
    return changed;
  }

  bySocket(socketId: string): Member | undefined {
    for (const m of this.members.values()) if (m.socketId === socketId) return m;
    return undefined;
  }

  byPlayerId(playerId: string): Member | undefined {
    for (const m of this.members.values()) if (m.playerId === playerId) return m;
    return undefined;
  }

  playerCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === 'player') n++;
    return n;
  }

  isEmpty(): boolean {
    return this.members.size === 0;
  }

  roster(): Roster {
    const players: PlayerInfo[] = [];
    for (const m of this.members.values()) {
      if (m.role === 'player')
        players.push({ id: m.playerId, name: m.name, connected: m.socketId !== null });
    }
    const h = this.host;
    return { room: this.code, hostConnected: !!h && h.socketId !== null, players };
  }
}

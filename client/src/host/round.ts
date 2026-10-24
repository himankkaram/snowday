/**
 * Game rules, with no DOM, no canvas, no sockets. Pure functions on plain data,
 * so they're unit-testable and the host screen just calls step() every frame.
 *
 * A throw launches a snowball from the top of the screen, straight down at the x the
 * player aimed at. It takes SNOWBALL_FLIGHT_MS to reach the rider's line, so the rider
 * can dodge. Hits and misses are decided when it lands, not when it's thrown.
 */
import type { HostState, Phase } from '../../../shared/protocol';
import { clamp, smooth } from '../input/steering';

export const ROUND_MS = 60_000;
export const RIDER_SPEED = 1.6; // world units per second at full steer (world x is -1..1)
export const RIDER_HALF_WIDTH = 0.08;
export const STEER_SMOOTHING_S = 0.08;
export const BASE_COOLDOWN_MS = 2000;
export const MAX_COOLDOWN_MS = 6000;
export const SNOWBALL_FLIGHT_MS = 1500; // time from top of screen to the rider; higher = slower
export const SNOWBALL_RADIUS = 0.03; // world units, used for the hit check

/** Each thrower's cooldown grows with the square root of the number of throwers, capped. */
export const throwCooldownMs = (players: number) =>
  Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * Math.sqrt(Math.max(1, players)));

export interface RoundState {
  phase: Phase;
  timeLeftMs: number;
  riderId: string | null;
  riderX: number; // -1 (left edge) .. 1 (right edge)
  steer: number; // smoothed input actually applied
  hits: number;
  throws: number;
  players: number; // throwers, locked when the round starts
  lastThrowAt: Record<string, number>; // round time (ms) of each player's last throw
  snowballs: Snowball[]; // in the air right now
  landed: Landing[]; // snowballs that landed during the last step(); main.ts reports these
}

export interface Snowball {
  playerId: string;
  seq: number; // the phone's action number, so the result goes back to the right throw
  x: number; // -1..1, where it was aimed
  progress: number; // 0 = just thrown (top of screen), 1 = reached the rider's line
}

export interface Landing {
  playerId: string;
  seq: number;
  x: number;
  hit: boolean;
}

export function newRound(riderId: string | null = null): RoundState {
  return {
    phase: 'lobby',
    timeLeftMs: ROUND_MS,
    riderId,
    riderX: 0,
    steer: 0,
    hits: 0,
    throws: 0,
    players: 1,
    lastThrowAt: {},
    snowballs: [],
    landed: [],
  };
}

export function start(s: RoundState, players = 1): RoundState {
  if (s.phase === 'playing') return s;
  return { ...newRound(s.riderId), phase: 'playing', players: Math.max(1, players) };
}

export function reset(s: RoundState): RoundState {
  return newRound(s.riderId);
}

/** Advance the simulation by dtMs with the current raw steering input in [-1, 1]. */
export function step(s: RoundState, dtMs: number, rawSteer: number): RoundState {
  if (s.phase !== 'playing') return s.landed.length ? { ...s, landed: [] } : s;
  const dt = Math.min(dtMs, 100) / 1000; // clamp big gaps (tab was hidden) so nothing teleports
  const steer = smooth(s.steer, clamp(rawSteer), dt, STEER_SMOOTHING_S);
  const riderX = clamp(
    s.riderX + steer * RIDER_SPEED * dt,
    -1 + RIDER_HALF_WIDTH,
    1 - RIDER_HALF_WIDTH,
  );
  const timeLeftMs = Math.max(0, s.timeLeftMs - dtMs);

  // Move every snowball down. Any that reach the rider's line are a hit if they overlap.
  const flying: Snowball[] = [];
  const landed: Landing[] = [];
  for (const b of s.snowballs) {
    const progress = b.progress + (dt * 1000) / SNOWBALL_FLIGHT_MS;
    if (progress < 1) {
      flying.push({ ...b, progress });
    } else {
      const hit = Math.abs(b.x - riderX) <= RIDER_HALF_WIDTH + SNOWBALL_RADIUS;
      landed.push({ playerId: b.playerId, seq: b.seq, x: b.x, hit });
    }
  }
  const hits = s.hits + landed.filter((l) => l.hit).length;

  const over = timeLeftMs === 0;
  return {
    ...s,
    steer,
    riderX,
    timeLeftMs,
    hits,
    snowballs: over ? [] : flying, // anything still in the air when time runs out doesn't count
    landed,
    phase: over ? 'over' : 'playing',
  };
}

export type ThrowOutcome = 'thrown' | 'ignored';

/** A player throws: launch a snowball at `aim`, unless the round isn't running or they're on cooldown. */
export function resolveThrow(
  s: RoundState,
  aim: number,
  playerId = 'anon',
  seq = 0,
): { state: RoundState; outcome: ThrowOutcome } {
  if (s.phase !== 'playing') return { state: s, outcome: 'ignored' };
  const now = ROUND_MS - s.timeLeftMs;
  const last = s.lastThrowAt[playerId];
  if (last !== undefined && now - last < throwCooldownMs(s.players)) {
    return { state: s, outcome: 'ignored' }; // still cooling down
  }
  const ball: Snowball = { playerId, seq, x: clamp(aim), progress: 0 };
  return {
    state: {
      ...s,
      throws: s.throws + 1,
      lastThrowAt: { ...s.lastThrowAt, [playerId]: now },
      snowballs: [...s.snowballs, ball],
    },
    outcome: 'thrown',
  };
}

export function toHostState(s: RoundState): HostState {
  return {
    phase: s.phase,
    timeLeftMs: Math.round(s.timeLeftMs),
    riderId: s.riderId,
    score: { hits: s.hits, throws: s.throws },
  };
}

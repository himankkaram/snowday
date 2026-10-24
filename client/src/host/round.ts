/**
 * Game rules, with no DOM, no canvas, no sockets. Pure functions on plain data,
 * so they're unit-testable and the host screen just calls step() every frame.
 *
 * The game: phones throw snowballs at the rider. A throw launches a snowball that takes
 * a moment to fly (stronger flick = faster). It only hits if the rider is still under it
 * when it lands, so leaning on the board dodges. The rider starts on 100 health and each
 * hit takes 10. Survive the full minute = rider wins; reach 0 = rider loses.
 */
import type { HostState, Phase } from '../../../shared/protocol';
import { clamp, smooth } from '../input/steering';

export const ROUND_MS = 60_000;
export const RIDER_SPEED = 1.6; // world units per second at full steer (world x is -1..1)
export const RIDER_HALF_WIDTH = 0.08;
export const STEER_SMOOTHING_S = 0.08;

export const MAX_HEALTH = 100;
export const HIT_DAMAGE = 10;
/** Snowball radius in world units; a ball touching the rider's edge still counts. */
export const SNOWBALL_RADIUS = 0.03;
/** Flight time for a gentle throw (power 0) and the hardest throw (power 1). */
export const FLIGHT_MS_SLOW = 1000;
export const FLIGHT_MS_FAST = 600;
export const MAX_SNOWBALLS = 60;
/** Per-player throw cooldown. Grows with the square root of the number of throwers, capped. */
export const BASE_COOLDOWN_MS = 2000;
export const MAX_COOLDOWN_MS = 6000;
export const throwCooldownMs = (players: number) =>
  Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * Math.sqrt(Math.max(1, players)));

export type RoundResult = 'win' | 'lose' | null;

export interface Snowball {
  id: number;
  playerId: string;
  seq: number;
  aim: number; // where it will land, -1..1
  ageMs: number;
  flightMs: number;
}

/** A snowball that finished its flight during the last step(). */
export interface Landing {
  playerId: string;
  seq: number;
  aim: number;
  hit: boolean;
}

export interface RoundState {
  phase: Phase;
  timeLeftMs: number;
  riderId: string | null;
  riderX: number; // -1 (left edge) .. 1 (right edge)
  steer: number; // smoothed input actually applied
  hits: number;
  throws: number;
  health: number;
  result: RoundResult;
  snowballs: Snowball[];
  nextBallId: number;
  /** Landings produced by the most recent step(); the host turns these into events. */
  landed: Landing[];
  players: number; // throwers, locked when the round starts
  lastThrowAt: Record<string, number>; // round time (ms) of each player's last throw
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
    health: MAX_HEALTH,
    result: null,
    snowballs: [],
    nextBallId: 1,
    landed: [],
    players: 1,
    lastThrowAt: {},
  };
}

export function start(s: RoundState, players = 1): RoundState {
  if (s.phase === 'playing') return s;
  return { ...newRound(s.riderId), phase: 'playing', players: Math.max(1, players) };
}

export function reset(s: RoundState): RoundState {
  return newRound(s.riderId);
}

export function flightMsFor(power: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(power) ? power : 0.5));
  return FLIGHT_MS_SLOW + (FLIGHT_MS_FAST - FLIGHT_MS_SLOW) * p;
}

export type ThrowOutcome = 'thrown' | 'ignored';

/**
 * A phone threw: launch a snowball towards `aim`. Outcome is decided when it lands.
 * cooldownMs: after a throw, the full wait before that player's next one; if the throw was
 * ignored because they're still recharging, how long is left (0 if ignored for another reason).
 */
export function throwSnowball(
  s: RoundState,
  t: { aim: number; power: number; playerId: string; seq: number },
): { state: RoundState; outcome: ThrowOutcome; cooldownMs: number } {
  if (s.phase !== 'playing') return { state: s, outcome: 'ignored', cooldownMs: 0 };
  const now = ROUND_MS - s.timeLeftMs;
  const last = s.lastThrowAt[t.playerId];
  const cooldown = throwCooldownMs(s.players);
  if (last !== undefined && now - last < cooldown) {
    return { state: s, outcome: 'ignored', cooldownMs: cooldown - (now - last) };
  }
  if (s.snowballs.length >= MAX_SNOWBALLS) return { state: s, outcome: 'ignored', cooldownMs: 0 };
  const ball: Snowball = {
    id: s.nextBallId,
    playerId: t.playerId,
    seq: t.seq,
    aim: clamp(t.aim),
    ageMs: 0,
    flightMs: flightMsFor(t.power),
  };
  return {
    state: {
      ...s,
      throws: s.throws + 1,
      snowballs: [...s.snowballs, ball],
      nextBallId: s.nextBallId + 1,
      lastThrowAt: { ...s.lastThrowAt, [t.playerId]: now },
    },
    outcome: 'thrown',
    cooldownMs: cooldown,
  };
}

export function isHit(aim: number, riderX: number): boolean {
  return Math.abs(aim - riderX) <= RIDER_HALF_WIDTH + SNOWBALL_RADIUS;
}

/** Advance the simulation by dtMs with the current raw steering input in [-1, 1]. */
export function step(s: RoundState, dtMs: number, rawSteer: number): RoundState {
  if (s.phase !== 'playing') return s.landed.length ? { ...s, landed: [] } : s;
  const dtClamped = Math.min(dtMs, 100); // clamp big gaps (tab was hidden) so nothing teleports
  const dt = dtClamped / 1000;
  const steer = smooth(s.steer, clamp(rawSteer), dt, STEER_SMOOTHING_S);
  const riderX = clamp(
    s.riderX + steer * RIDER_SPEED * dt,
    -1 + RIDER_HALF_WIDTH,
    1 - RIDER_HALF_WIDTH,
  );

  // fly snowballs; resolve the ones that land this step against the rider's NEW position
  const landed: Landing[] = [];
  const flying: Snowball[] = [];
  let { hits, health } = s;
  for (const b of s.snowballs) {
    const ageMs = b.ageMs + dtClamped;
    if (ageMs < b.flightMs) {
      flying.push({ ...b, ageMs });
      continue;
    }
    const hit = health > 0 && isHit(b.aim, riderX);
    if (hit) {
      hits += 1;
      health = Math.max(0, health - HIT_DAMAGE);
    }
    landed.push({ playerId: b.playerId, seq: b.seq, aim: b.aim, hit });
  }

  const timeLeftMs = Math.max(0, s.timeLeftMs - dtMs);
  let phase: Phase = 'playing';
  let result: RoundResult = null;
  if (health <= 0) {
    phase = 'over';
    result = 'lose';
  } else if (timeLeftMs === 0) {
    phase = 'over';
    result = 'win';
  }
  return {
    ...s,
    steer,
    riderX,
    timeLeftMs,
    phase,
    result,
    hits,
    health,
    snowballs: phase === 'over' ? [] : flying,
    landed,
  };
}

export function toHostState(s: RoundState): HostState {
  return {
    phase: s.phase,
    timeLeftMs: Math.round(s.timeLeftMs),
    riderId: s.riderId,
    score: { hits: s.hits, throws: s.throws },
    health: s.health,
    result: s.result,
  };
}

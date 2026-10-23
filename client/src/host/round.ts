/**
 * Game rules, with no DOM, no canvas, no sockets. Pure functions on plain data,
 * so they're unit-testable and the host screen just calls step() every frame.
 *
 * What's here is the GENERIC round skeleton: phases, timer, a steerable rider, counting
 * actions. The placeholder hit rule (instant aim check) exists only to prove the
 * phone -> server -> host -> phone loop end to end. Replace `resolveThrow` with real
 * projectiles at the event.
 */
import type { HostState, Phase } from '../../../shared/protocol';
import { clamp, smooth } from '../input/steering';

export const ROUND_MS = 60_000;
export const RIDER_SPEED = 1.6; // world units per second at full steer (world x is -1..1)
export const RIDER_HALF_WIDTH = 0.08;
export const STEER_SMOOTHING_S = 0.08;

export interface RoundState {
  phase: Phase;
  timeLeftMs: number;
  riderId: string | null;
  riderX: number; // -1 (left edge) .. 1 (right edge)
  steer: number; // smoothed input actually applied
  hits: number;
  throws: number;
}

export function newRound(riderId: string | null = null): RoundState {
  return { phase: 'lobby', timeLeftMs: ROUND_MS, riderId, riderX: 0, steer: 0, hits: 0, throws: 0 };
}

export function start(s: RoundState): RoundState {
  if (s.phase === 'playing') return s;
  return { ...newRound(s.riderId), phase: 'playing' };
}

export function reset(s: RoundState): RoundState {
  return newRound(s.riderId);
}

/** Advance the simulation by dtMs with the current raw steering input in [-1, 1]. */
export function step(s: RoundState, dtMs: number, rawSteer: number): RoundState {
  if (s.phase !== 'playing') return s;
  const dt = Math.min(dtMs, 100) / 1000; // clamp big gaps (tab was hidden) so nothing teleports
  const steer = smooth(s.steer, clamp(rawSteer), dt, STEER_SMOOTHING_S);
  const riderX = clamp(
    s.riderX + steer * RIDER_SPEED * dt,
    -1 + RIDER_HALF_WIDTH,
    1 - RIDER_HALF_WIDTH,
  );
  const timeLeftMs = Math.max(0, s.timeLeftMs - dtMs);
  return { ...s, steer, riderX, timeLeftMs, phase: timeLeftMs === 0 ? 'over' : 'playing' };
}

export type ThrowOutcome = 'hit' | 'miss' | 'ignored';

/** PLACEHOLDER hit rule: a throw hits if its aim lands within the rider's width. */
export function resolveThrow(
  s: RoundState,
  aim: number,
): { state: RoundState; outcome: ThrowOutcome } {
  if (s.phase !== 'playing') return { state: s, outcome: 'ignored' };
  const hit = Math.abs(clamp(aim) - s.riderX) <= RIDER_HALF_WIDTH;
  return {
    state: { ...s, throws: s.throws + 1, hits: s.hits + (hit ? 1 : 0) },
    outcome: hit ? 'hit' : 'miss',
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

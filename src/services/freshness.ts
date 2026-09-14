/**
 * How old is too old (D§6.1).
 *
 * Pure on purpose: no clock, no database, no client. The whole refresh policy turns on
 * this one function, so it is worth being able to read it in one screen and test it
 * without wiring anything up.
 */
import { addDays } from '../domain/forecast/localDate.js';
import type { Snapshot } from '../adapters/db/snapshotRepository.js';
import { RANKED_DAYS } from '../domain/forecast/features.js';

export type Freshness =
  /** Serve it. */
  | 'fresh'
  /** Serve it, say so, and refresh behind the request. */
  | 'stale'
  /** Too old, or does not cover the days we are about to score. Fetch before serving. */
  | 'expired'
  /** A remembered "there is nothing here", which is an answer rather than a gap. */
  | 'unavailable';

export interface FreshnessPolicy {
  readonly ttlMs: number;
  readonly maxStaleMs: number;
  /**
   * Marine only: how long a "no coverage here" answer stands before re-checking.
   * Weather is never stored that way, so it does not set this.
   */
  readonly unavailableTtlMs?: number;
}

const HOUR_MS = 3_600_000;

/** D§9 defaults, in the units the policy uses. */
export const hours = (count: number): number => count * HOUR_MS;

export const WEATHER_POLICY: FreshnessPolicy = {
  ttlMs: hours(3),
  maxStaleMs: hours(24),
};

export const MARINE_POLICY: FreshnessPolicy = {
  ttlMs: hours(6),
  maxStaleMs: hours(24),
  unavailableTtlMs: hours(168),
};

/**
 * Does this snapshot still describe the days we are about to score? A forecast fetched
 * yesterday is not wrong, but one fetched last week no longer reaches the end of the
 * window, and scoring it would produce seven days of "insufficient data" that look like
 * an answer.
 */
export function covers(snapshot: Snapshot, todayLocal: string): boolean {
  const { firstDate, lastDate } = snapshot;
  if (firstDate === undefined || lastDate === undefined) return false;
  return firstDate <= todayLocal && lastDate >= addDays(todayLocal, RANKED_DAYS - 1);
}

/**
 * The state table of D§6.1. Age and coverage are separate questions: a snapshot can be
 * minutes old and still not reach the end of the window, and it is only usable when both
 * hold.
 */
export function classify(
  snapshot: Snapshot | undefined,
  now: Date,
  todayLocal: string,
  policy: FreshnessPolicy,
): Freshness {
  if (snapshot === undefined) return 'expired';

  const age = now.getTime() - new Date(snapshot.fetchedAt).getTime();

  if (snapshot.status === 'unavailable') {
    // A source with no unavailable policy should never hold such a row; if one turns
    // up, re-check it rather than trusting it forever.
    return age < (policy.unavailableTtlMs ?? 0) ? 'unavailable' : 'expired';
  }

  if (!covers(snapshot, todayLocal)) return 'expired';
  if (age < policy.ttlMs) return 'fresh';
  if (age < policy.maxStaleMs) return 'stale';
  return 'expired';
}

/**
 * Whether a snapshot is worth serving when upstream has just failed us. D§8.3 says the
 * error is for "unreachable and no servable snapshot"; this is what servable means
 * (D-019).
 */
export function isServable(snapshot: Snapshot, todayLocal: string): boolean {
  return snapshot.status === 'ok' && covers(snapshot, todayLocal);
}

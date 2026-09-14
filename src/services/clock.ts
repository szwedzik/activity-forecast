/**
 * The one place the service reads the real time.
 *
 * Everything that cares about "now" takes a Clock, so freshness, retention and refresh
 * can be tested at an instant of the test's choosing rather than whenever it happens to
 * run. The domain does not take one at all: it is handed a local date (D§7.1).
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FixedClock extends Clock {
  /** Jump to an instant. */
  set(iso: string): void;
  /** Move forward, for "and then three hours later" (D§6.1). */
  advance(milliseconds: number): void;
}

export function fixedClock(iso: string): FixedClock {
  let current = new Date(iso).getTime();
  if (Number.isNaN(current)) throw new RangeError(`not an instant: ${iso}`);

  return {
    now: () => new Date(current),
    set: (next) => {
      const parsed = new Date(next).getTime();
      if (Number.isNaN(parsed)) throw new RangeError(`not an instant: ${next}`);
      current = parsed;
    },
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

/**
 * Every instant we store is an ISO-8601 string in UTC. That is load-bearing, not
 * cosmetic: the freshness and retention queries compare these as strings, which only
 * works because the format sorts in time order.
 */
export function toIsoUtc(date: Date): string {
  return date.toISOString();
}

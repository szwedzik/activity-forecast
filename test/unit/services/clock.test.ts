import { describe, expect, it } from 'vitest';

import { fixedClock, systemClock, toIsoUtc } from '../../../src/services/clock.js';

const HOUR = 3_600_000;

describe('the system clock', () => {
  it('reports something close to now', () => {
    const drift = Math.abs(systemClock.now().getTime() - Date.now());

    expect(drift).toBeLessThan(1000);
  });
});

describe('a fixed clock', () => {
  it('stays where it was put', () => {
    const clock = fixedClock('2026-09-14T09:00:00.000Z');

    expect(toIsoUtc(clock.now())).toBe('2026-09-14T09:00:00.000Z');
    expect(toIsoUtc(clock.now())).toBe('2026-09-14T09:00:00.000Z');
  });

  it('moves when told to, which is how a TTL gets tested', () => {
    const clock = fixedClock('2026-09-14T09:00:00.000Z');

    clock.advance(3 * HOUR);
    expect(toIsoUtc(clock.now())).toBe('2026-09-14T12:00:00.000Z');

    clock.set('2026-09-15T00:00:00.000Z');
    expect(toIsoUtc(clock.now())).toBe('2026-09-15T00:00:00.000Z');
  });

  it('hands out a copy, so a caller cannot move it by accident', () => {
    const clock = fixedClock('2026-09-14T09:00:00.000Z');

    clock.now().setFullYear(1999);

    expect(toIsoUtc(clock.now())).toBe('2026-09-14T09:00:00.000Z');
  });

  it('refuses an instant it cannot read', () => {
    expect(() => fixedClock('not a date')).toThrow(RangeError);
    expect(() => fixedClock('2026-09-14T09:00:00.000Z').set('nonsense')).toThrow(RangeError);
  });
});

describe('toIsoUtc', () => {
  it('always renders in UTC, whatever zone the process is in', () => {
    expect(toIsoUtc(new Date(Date.UTC(2026, 8, 14, 9, 0, 0)))).toBe('2026-09-14T09:00:00.000Z');
  });

  it('produces strings that sort in time order, which is what the SQL relies on', () => {
    // Freshness and retention compare these as text, so this property is load-bearing.
    const earlier = toIsoUtc(new Date('2026-09-14T09:00:00.000Z'));
    const later = toIsoUtc(new Date('2026-09-14T12:00:00.000Z'));
    const nextYear = toIsoUtc(new Date('2027-01-01T00:00:00.000Z'));

    expect(earlier < later).toBe(true);
    expect(later < nextYear).toBe(true);
  });
});

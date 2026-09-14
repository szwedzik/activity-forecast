import { describe, expect, it } from 'vitest';

import {
  addDays,
  compareDates,
  dateOf,
  dateRange,
  daysBetween,
  hourOf,
  isLocalDate,
} from '../../../../src/domain/forecast/localDate.js';

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('goes backwards', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('is unaffected by daylight saving, because dates have no clock', () => {
    // Europe/Lisbon springs forward on 2026-03-29; a naive +24h would land on the 29th twice.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('rejects anything that is not a plain date', () => {
    expect(() => addDays('2026-09-14T00:00', 1)).toThrow(RangeError);
    expect(() => addDays('14/09/2026', 1)).toThrow(RangeError);
  });
});

describe('dateRange', () => {
  it('returns consecutive dates starting at the first', () => {
    expect(dateRange('2026-09-14', 7)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
  });

  it('returns nothing for a count of zero', () => {
    expect(dateRange('2026-09-14', 0)).toEqual([]);
  });
});

describe('compareDates and daysBetween', () => {
  it('orders dates', () => {
    expect(compareDates('2026-09-14', '2026-09-15')).toBeLessThan(0);
    expect(compareDates('2026-09-15', '2026-09-14')).toBeGreaterThan(0);
    expect(compareDates('2026-09-14', '2026-09-14')).toBe(0);
  });

  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-09-14', '2026-09-21')).toBe(7);
    expect(daysBetween('2026-09-21', '2026-09-14')).toBe(-7);
    expect(daysBetween('2026-09-14', '2026-09-14')).toBe(0);
  });
});

describe('parsing Open-Meteo timestamps', () => {
  it('splits a local timestamp into date and hour', () => {
    expect(dateOf('2026-09-14T13:00')).toBe('2026-09-14');
    expect(hourOf('2026-09-14T13:00')).toBe(13);
    expect(hourOf('2026-09-14T00:00')).toBe(0);
    expect(hourOf('2026-09-14T09:00')).toBe(9);
  });

  it('recognises a plain date', () => {
    expect(isLocalDate('2026-09-14')).toBe(true);
    expect(isLocalDate('2026-09-14T00:00')).toBe(false);
    expect(isLocalDate('')).toBe(false);
  });
});

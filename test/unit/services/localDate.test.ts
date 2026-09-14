import { describe, expect, it } from 'vitest';

import { todayIn } from '../../../src/services/localDate.js';

describe('todayIn', () => {
  it('gives the date at the location, not at the server', () => {
    // 23:30 UTC is already tomorrow morning in Sydney. This is the whole reason the
    // function exists (D§1).
    const instant = new Date('2026-09-14T23:30:00.000Z');

    expect(todayIn(instant, 'Australia/Sydney')).toBe('2026-09-15');
    expect(todayIn(instant, 'UTC')).toBe('2026-09-14');
    expect(todayIn(instant, 'America/Denver')).toBe('2026-09-14');
  });

  it('gives yesterday where the day has not started yet', () => {
    // 00:30 UTC is still the previous evening in Denver.
    const instant = new Date('2026-09-15T00:30:00.000Z');

    expect(todayIn(instant, 'America/Denver')).toBe('2026-09-14');
    expect(todayIn(instant, 'Europe/Lisbon')).toBe('2026-09-15');
  });

  it('formats as YYYY-MM-DD, the format everything else already uses', () => {
    expect(todayIn(new Date('2026-01-05T12:00:00.000Z'), 'UTC')).toBe('2026-01-05');
  });

  it('follows a daylight-saving change', () => {
    // Europe/Lisbon is UTC+1 in summer and UTC+0 in winter; it falls back on 2026-10-25.
    const beforeMidnightSummer = new Date('2026-09-14T23:30:00.000Z');
    const beforeMidnightWinter = new Date('2026-11-14T23:30:00.000Z');

    expect(todayIn(beforeMidnightSummer, 'Europe/Lisbon')).toBe('2026-09-15');
    expect(todayIn(beforeMidnightWinter, 'Europe/Lisbon')).toBe('2026-11-14');
  });

  it('handles a zone that is not a whole number of hours from UTC', () => {
    // Kathmandu is UTC+5:45.
    expect(todayIn(new Date('2026-09-14T18:20:00.000Z'), 'Asia/Kathmandu')).toBe('2026-09-15');
    expect(todayIn(new Date('2026-09-14T18:10:00.000Z'), 'Asia/Kathmandu')).toBe('2026-09-14');
  });

  it('refuses a zone it cannot resolve rather than quietly using the server one', () => {
    expect(() => todayIn(new Date(), 'Mars/Olympus_Mons')).toThrow(RangeError);
  });

  it('refuses an instant it cannot read', () => {
    expect(() => todayIn(new Date('nonsense'), 'UTC')).toThrow(RangeError);
  });

  it('keeps zones apart even though it caches a formatter per zone', () => {
    // The cache is keyed by zone; one shared formatter would answer for the wrong place.
    const instant = new Date('2026-09-14T23:30:00.000Z');

    expect(todayIn(instant, 'Australia/Sydney')).toBe('2026-09-15');
    expect(todayIn(instant, 'America/Denver')).toBe('2026-09-14');
    expect(todayIn(instant, 'Australia/Sydney')).toBe('2026-09-15');
  });
});

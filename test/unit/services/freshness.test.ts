/**
 * The D§6.1 state table, one test per row. This is the whole refresh policy, so it is
 * pinned here before anything is wired to it.
 */
import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../../../src/adapters/db/snapshotRepository.js';
import {
  classify,
  covers,
  hours,
  isServable,
  MARINE_POLICY,
  WEATHER_POLICY,
} from '../../../src/services/freshness.js';

const TODAY = '2026-09-14';
const NOW = new Date('2026-09-14T12:00:00.000Z');

/** A snapshot fetched `age` before NOW, covering today through today + 6. */
function snapshot(age: number, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 1,
    locationId: 1,
    source: 'weather',
    status: 'ok',
    fetchedAt: new Date(NOW.getTime() - age).toISOString(),
    firstDate: '2026-09-14',
    lastDate: '2026-09-21',
    payload: '{}',
    ...overrides,
  };
}

describe('the freshness state table', () => {
  it('row 1: nothing stored is expired', () => {
    expect(classify(undefined, NOW, TODAY, WEATHER_POLICY)).toBe('expired');
  });

  it('row 2: inside the TTL and covering the window is fresh', () => {
    expect(classify(snapshot(hours(1)), NOW, TODAY, WEATHER_POLICY)).toBe('fresh');
  });

  it('row 3: inside the TTL but not covering the window is expired', () => {
    // Recent and useless are not mutually exclusive.
    const short = snapshot(hours(1), { firstDate: '2026-09-14', lastDate: '2026-09-17' });

    expect(classify(short, NOW, TODAY, WEATHER_POLICY)).toBe('expired');
  });

  it('row 4: past the TTL but inside the stale window, still covering, is stale', () => {
    expect(classify(snapshot(hours(5)), NOW, TODAY, WEATHER_POLICY)).toBe('stale');
  });

  it('row 5: past the TTL and not covering is expired, not stale', () => {
    const short = snapshot(hours(5), { firstDate: '2026-09-14', lastDate: '2026-09-17' });

    expect(classify(short, NOW, TODAY, WEATHER_POLICY)).toBe('expired');
  });

  it('row 6: past the stale window is expired however well it covers', () => {
    expect(classify(snapshot(hours(25)), NOW, TODAY, WEATHER_POLICY)).toBe('expired');
  });

  it('row 7: a remembered "no coverage here" stands for a week', () => {
    const inland = snapshot(hours(100), {
      source: 'marine',
      status: 'unavailable',
      firstDate: undefined,
      lastDate: undefined,
      payload: undefined,
    });

    expect(classify(inland, NOW, TODAY, MARINE_POLICY)).toBe('unavailable');
  });

  it('row 8: after a week the coastline is checked again', () => {
    const inland = snapshot(hours(169), {
      source: 'marine',
      status: 'unavailable',
      firstDate: undefined,
      lastDate: undefined,
      payload: undefined,
    });

    expect(classify(inland, NOW, TODAY, MARINE_POLICY)).toBe('expired');
  });
});

describe('the boundaries between states', () => {
  it('is fresh right up to the TTL and stale on it', () => {
    expect(classify(snapshot(hours(3) - 1), NOW, TODAY, WEATHER_POLICY)).toBe('fresh');
    expect(classify(snapshot(hours(3)), NOW, TODAY, WEATHER_POLICY)).toBe('stale');
  });

  it('is stale right up to the maximum and expired on it', () => {
    expect(classify(snapshot(hours(24) - 1), NOW, TODAY, WEATHER_POLICY)).toBe('stale');
    expect(classify(snapshot(hours(24)), NOW, TODAY, WEATHER_POLICY)).toBe('expired');
  });

  it('gives marine a longer TTL than weather, because wave models move more slowly', () => {
    const fourHoursOld = snapshot(hours(4), { source: 'marine' });

    expect(classify(fourHoursOld, NOW, TODAY, WEATHER_POLICY)).toBe('stale');
    expect(classify(fourHoursOld, NOW, TODAY, MARINE_POLICY)).toBe('fresh');
  });

  it('treats a snapshot from the future as fresh rather than doing something surprising', () => {
    expect(classify(snapshot(-hours(1)), NOW, TODAY, WEATHER_POLICY)).toBe('fresh');
  });
});

describe('covering the window', () => {
  it('needs today and the six days after it', () => {
    expect(covers(snapshot(0, { firstDate: '2026-09-14', lastDate: '2026-09-20' }), TODAY)).toBe(true);
    expect(covers(snapshot(0, { firstDate: '2026-09-14', lastDate: '2026-09-19' }), TODAY)).toBe(false);
  });

  it('accepts a snapshot that starts before today and runs past the window', () => {
    expect(covers(snapshot(0, { firstDate: '2026-09-13', lastDate: '2026-09-21' }), TODAY)).toBe(true);
  });

  it('rejects one that starts after today', () => {
    expect(covers(snapshot(0, { firstDate: '2026-09-15', lastDate: '2026-09-22' }), TODAY)).toBe(false);
  });

  it('rejects one with no dates at all, which is what an unavailable row looks like', () => {
    expect(covers(snapshot(0, { firstDate: undefined, lastDate: undefined }), TODAY)).toBe(false);
  });

  it('still covers the window when fetched late yesterday, which is the usual case', () => {
    // Eight days are fetched, so a snapshot taken at any hour of day D reaches D+7.
    const yesterday = snapshot(hours(13), { firstDate: '2026-09-13', lastDate: '2026-09-20' });

    expect(covers(yesterday, TODAY)).toBe(true);
    expect(classify(yesterday, NOW, TODAY, WEATHER_POLICY)).toBe('stale');
  });
});

describe('what is worth serving when upstream has just failed', () => {
  it('serves a stored snapshot that still covers the window, however old it is', () => {
    expect(isServable(snapshot(hours(200)), TODAY)).toBe(true);
  });

  it('refuses one that no longer covers the window', () => {
    // Seven days of "insufficient data" is not an answer; an error is honest.
    expect(isServable(snapshot(0, { firstDate: '2026-09-01', lastDate: '2026-09-08' }), TODAY)).toBe(
      false,
    );
  });

  it('refuses an unavailable row, which holds no forecast to serve', () => {
    expect(isServable(snapshot(0, { status: 'unavailable' }), TODAY)).toBe(false);
  });
});

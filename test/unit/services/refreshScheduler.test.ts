/**
 * The background cycle (D§6.3, D§5.3).
 *
 * The work and the timer are tested apart: what calls a cycle makes has nothing to do
 * with clocks, and testing it through fake timers would only make it harder to read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Location } from '../../../src/domain/location.js';
import type { FixedClock } from '../../../src/services/clock.js';
import { fixedClock, toIsoUtc } from '../../../src/services/clock.js';
import { createForecastService } from '../../../src/services/forecastService.js';
import type { RefreshScheduler } from '../../../src/services/refreshScheduler.js';
import { createRefreshScheduler } from '../../../src/services/refreshScheduler.js';
import { loadMarine } from '../../helpers/fixtures.js';
import type { FakeForecast, FakeMarine, RecordingLogger, Store } from '../../helpers/services.js';
import {
  deferred,
  DENVER,
  fakeForecast,
  fakeMarine,
  HOUR,
  LISBON,
  openStore,
  recordingLogger,
  T0,
} from '../../helpers/services.js';

describe('the background cycle', () => {
  let store: Store;
  let forecast: FakeForecast;
  let marine: FakeMarine;
  let clock: FixedClock;
  let logger: RecordingLogger;
  let scheduler: RefreshScheduler;
  let lisbon: Location;

  const build = (overrides: Partial<Parameters<typeof createRefreshScheduler>[0]> = {}) => {
    const forecasts = createForecastService({
      snapshots: store.snapshots,
      forecast,
      marine,
      clock,
      logger,
    });
    return createRefreshScheduler({
      locations: store.locations,
      snapshots: store.snapshots,
      forecasts,
      clock,
      logger,
      enabled: true,
      intervalMs: 10 * 60_000,
      activeWindowMs: 24 * HOUR,
      retentionMs: 48 * HOUR,
      // No real waiting in a test, and no timer unless the test asked for one.
      sleep: async () => undefined,
      ...overrides,
    });
  };

  beforeEach(() => {
    store = openStore();
    forecast = fakeForecast();
    marine = fakeMarine();
    clock = fixedClock(T0);
    logger = recordingLogger();
    lisbon = store.locations.upsertLocation(LISBON, T0);
    scheduler = build();
  });

  describe('which locations it touches', () => {
    it('does nothing when nobody has asked about anywhere', async () => {
      const result = await scheduler.runCycle();

      expect(result).toMatchObject({ locations: 0, refreshed: 0 });
      expect(forecast.calls).toEqual([]);
    });

    it('refreshes a town somebody asked about', async () => {
      store.locations.touch(lisbon.rowId, T0);

      const result = await scheduler.runCycle();

      expect(result.locations).toBe(1);
      expect(result.refreshed).toBe(2); // weather and marine
      expect(forecast.calls).toHaveLength(1);
      expect(marine.calls).toHaveLength(1);
    });

    it('leaves alone a town nobody has asked about in a day', async () => {
      store.locations.touch(lisbon.rowId, toIsoUtc(new Date(clock.now().getTime() - 25 * HOUR)));

      const result = await scheduler.runCycle();

      expect(result.locations).toBe(0);
      expect(forecast.calls).toEqual([]);
    });
  });

  describe('which sources it spends a call on', () => {
    it('skips whatever is still fresh', async () => {
      store.locations.touch(lisbon.rowId, T0);
      await scheduler.runCycle();
      const after = forecast.calls.length;

      // Nothing has aged; a second cycle should find nothing worth doing.
      const result = await scheduler.runCycle();

      expect(result.refreshed).toBe(0);
      expect(result.skipped).toBe(2);
      expect(forecast.calls).toHaveLength(after);
    });

    it('refreshes only the source that has aged out', async () => {
      store.locations.touch(lisbon.rowId, T0);
      await scheduler.runCycle();

      // Four hours: past the weather TTL of three, inside the marine TTL of six.
      clock.advance(4 * HOUR);
      store.locations.touch(lisbon.rowId, toIsoUtc(clock.now()));
      const result = await scheduler.runCycle();

      expect(result.refreshed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(forecast.calls).toHaveLength(2);
      expect(marine.calls).toHaveLength(1);
    });

    it('does not keep asking whether a landlocked town has a coastline', async () => {
      // The whole reason `unavailable` is a stored answer rather than a gap (D§6.1).
      const denver = store.locations.upsertLocation(DENVER, T0);
      marine.payload = loadMarine('denver');
      store.locations.touch(denver.rowId, T0);
      await scheduler.runCycle();
      expect(marine.calls).toHaveLength(1);

      clock.advance(7 * HOUR);
      store.locations.touch(denver.rowId, toIsoUtc(clock.now()));
      const result = await scheduler.runCycle();

      // Past the six-hour marine TTL, but the answer stands for a week.
      expect(marine.calls).toHaveLength(1);
      // Weather aged past its three hours and was refreshed; marine was the one skipped.
      expect(result.refreshed).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('when something goes wrong', () => {
    it('keeps going after a failed refresh', async () => {
      const denver = store.locations.upsertLocation(DENVER, T0);
      store.locations.touch(lisbon.rowId, T0);
      store.locations.touch(denver.rowId, T0);
      forecast.failure = new Error('upstream down');

      const result = await scheduler.runCycle();

      // Both towns were attempted even though every weather call failed.
      expect(result.locations).toBe(2);
      expect(result.failed).toBe(2);
      expect(result.refreshed).toBe(2); // the marine halves still worked
      expect(logger.warnings.some((one) => one.message.includes('refresh failed'))).toBe(true);
    });

    it('keeps going after a town it cannot even work out the date for', async () => {
      const broken = store.locations.upsertLocation(
        { ...DENVER, geonamesId: 999, name: 'Nowhere', timezone: 'Mars/Olympus_Mons' },
        T0,
      );
      store.locations.touch(broken.rowId, T0);
      store.locations.touch(lisbon.rowId, T0);

      const result = await scheduler.runCycle();

      expect(result.failed).toBe(1);
      expect(result.refreshed).toBe(2); // Lisbon was still done
      expect(logger.warnings.some((one) => one.message.includes('skipped a location'))).toBe(true);
    });
  });

  describe('retention', () => {
    it('deletes what is old and keeps the newest of each pair', async () => {
      store.snapshots.insert({
        locationId: lisbon.rowId,
        source: 'weather',
        status: 'ok',
        fetchedAt: toIsoUtc(new Date(clock.now().getTime() - 72 * HOUR)),
        payload: 'ancient',
      });
      store.locations.touch(lisbon.rowId, T0);

      const result = await scheduler.runCycle();

      // The ancient row went; the one this cycle fetched stayed.
      expect(result.pruned).toBe(1);
      expect(store.snapshots.getLatest(lisbon.rowId, 'weather')?.payload).not.toBe('ancient');
    });

    it('keeps a snapshot that is old but still inside the retention window', async () => {
      // The 48-hour cutoff is the only number D§5.3 owns, and pruning everything but the
      // newest row would pass every other test in this file.
      store.snapshots.insert({
        locationId: lisbon.rowId,
        source: 'weather',
        status: 'ok',
        fetchedAt: toIsoUtc(new Date(clock.now().getTime() - 30 * HOUR)),
        payload: 'yesterday',
      });
      store.locations.touch(lisbon.rowId, T0);

      const result = await scheduler.runCycle();

      expect(result.pruned).toBe(0);
    });

    it('never prunes away the only snapshot a location has', async () => {
      store.snapshots.insert({
        locationId: lisbon.rowId,
        source: 'weather',
        status: 'ok',
        fetchedAt: toIsoUtc(new Date(clock.now().getTime() - 72 * HOUR)),
        payload: 'old but all there is',
      });

      // Nobody asked about Lisbon, so nothing is refreshed and only pruning runs.
      const result = await scheduler.runCycle();

      expect(result.pruned).toBe(0);
      expect(store.snapshots.getLatest(lisbon.rowId, 'weather')).toBeDefined();
    });
  });

  describe('politeness to a free tier', () => {
    it('pauses between upstream calls', async () => {
      const sleep = vi.fn(async () => undefined);
      const polite = build({ sleep, pauseMs: 250 });
      store.locations.touch(lisbon.rowId, T0);

      await polite.runCycle();

      // One after each of the two refreshes.
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(250);
    });

    it('does not pause for a source it decided to skip', async () => {
      const sleep = vi.fn(async () => undefined);
      const polite = build({ sleep });
      store.locations.touch(lisbon.rowId, T0);
      await polite.runCycle();
      sleep.mockClear();

      await polite.runCycle(); // everything fresh now

      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('what it reports', () => {
    it('logs one line per cycle with the counts', async () => {
      store.locations.touch(lisbon.rowId, T0);

      await scheduler.runCycle();

      const cycles = logger.records.filter((one) => one.message === 'refresh cycle');
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.fields).toMatchObject({
        locations: 1,
        refreshed: 2,
        skipped: 0,
        failed: 0,
        pruned: 0,
      });
    });
  });
});

describe('the timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const build = (enabled: boolean) => {
    const store = openStore();
    const clock = fixedClock(T0);
    const forecast = fakeForecast();
    const forecasts = createForecastService({
      snapshots: store.snapshots,
      forecast,
      marine: fakeMarine(),
      clock,
    });
    const scheduler = createRefreshScheduler({
      locations: store.locations,
      snapshots: store.snapshots,
      forecasts,
      clock,
      enabled,
      intervalMs: 10 * 60_000,
      activeWindowMs: 24 * HOUR,
      retentionMs: 48 * HOUR,
      startupDelayMs: 5_000,
      sleep: async () => undefined,
    });
    return { store, forecast, scheduler };
  };

  it('runs a first cycle shortly after starting, then on the interval', async () => {
    vi.useFakeTimers();
    const { store, scheduler } = build(true);
    const cycles = vi.spyOn(store.locations, 'recentlyRequested');

    scheduler.start();
    expect(cycles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycles).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cycles).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it('does nothing at all when it is switched off', async () => {
    vi.useFakeTimers();
    const { store, scheduler } = build(false);
    const cycles = vi.spyOn(store.locations, 'recentlyRequested');

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(cycles).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('stops, and stopping twice is not a problem', async () => {
    vi.useFakeTimers();
    const { store, scheduler } = build(true);
    const cycles = vi.spyOn(store.locations, 'recentlyRequested');

    scheduler.start();
    await scheduler.stop();
    await scheduler.stop();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cycles).not.toHaveBeenCalled();
  });

  it('does not start a second cycle while one is still running', async () => {
    // A slow cycle should delay the next tick, not race it: two cycles at once would
    // have both halves of a single-flight refresh fighting over the same rows.
    vi.useFakeTimers();
    const { store, forecast, scheduler } = build(true);
    const gate = deferred();
    forecast.gate = gate.promise;
    store.locations.touch(store.locations.upsertLocation(LISBON, T0).rowId, T0);
    const cycles = vi.spyOn(store.locations, 'recentlyRequested');

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycles).toHaveBeenCalledTimes(1);

    // Three more ticks while the first cycle is still stuck on its fetch.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(cycles).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cycles.mock.calls.length).toBeGreaterThan(1);

    await scheduler.stop();
  });

  it('waits for a cycle in flight before it returns', async () => {
    // Shutdown closes the database next, and a cycle is part-way through writing
    // snapshots when this matters.
    const { store, forecast, scheduler } = build(true);
    const gate = deferred();
    forecast.gate = gate.promise;
    store.locations.touch(store.locations.upsertLocation(LISBON, T0).rowId, T0);

    const cycle = scheduler.runCycle();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    await cycle;
  });

  it('does not reject when the cycle it was waiting for failed', async () => {
    // A rejection here used to skip the rest of shutdown entirely (D-026).
    const { store, forecast, scheduler } = build(true);
    store.locations.touch(store.locations.upsertLocation(LISBON, T0).rowId, T0);
    vi.spyOn(store.locations, 'recentlyRequested').mockImplementation(() => {
      throw new Error('database is locked');
    });

    const cycle = scheduler.runCycle().catch(() => undefined);
    await expect(scheduler.stop()).resolves.toBeUndefined();
    await cycle;
  });

  it('does not hold the process open between cycles', async () => {
    // Real timers, because the question is about the handle rather than the schedule: a
    // referenced ten-minute interval keeps Node alive long after the work is done.
    const { scheduler } = build(true);
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');

    try {
      scheduler.start();

      const handles = [...timeout.mock.results, ...interval.mock.results]
        .filter((one) => one.type === 'return')
        .map((one) => one.value as NodeJS.Timeout);

      expect(handles).toHaveLength(2);
      expect(handles.map((one) => one.hasRef())).toEqual([false, false]);
    } finally {
      timeout.mockRestore();
      interval.mockRestore();
      await scheduler.stop();
    }
  });

  it('ignores a second start', async () => {
    vi.useFakeTimers();
    const { store, scheduler } = build(true);
    const cycles = vi.spyOn(store.locations, 'recentlyRequested');

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(cycles).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});

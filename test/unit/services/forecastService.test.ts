/**
 * The refresh policy in practice: every row of the D§6.1 table acted on, and every
 * failure in D§6.4. Real in-memory SQLite, fake clients, a clock the test moves.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Location } from '../../../src/domain/location.js';
import type { FixedClock } from '../../../src/services/clock.js';
import { fixedClock } from '../../../src/services/clock.js';
import type { ForecastService } from '../../../src/services/forecastService.js';
import { createForecastService } from '../../../src/services/forecastService.js';
import { loadMarine, loadWeather } from '../../helpers/fixtures.js';
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

const TODAY = '2026-09-14';

describe('the forecast service', () => {
  let store: Store;
  let forecast: FakeForecast;
  let marine: FakeMarine;
  let clock: FixedClock;
  let logger: RecordingLogger;
  let service: ForecastService;
  let lisbon: Location;

  beforeEach(() => {
    store = openStore();
    forecast = fakeForecast();
    marine = fakeMarine();
    clock = fixedClock(T0);
    logger = recordingLogger();
    service = createForecastService({
      snapshots: store.snapshots,
      forecast,
      marine,
      clock,
      logger,
    });
    lisbon = store.locations.upsertLocation(LISBON, T0);
  });

  describe('acting on each state', () => {
    it('fetches inline when nothing is stored, and serves what came back', async () => {
      const bundle = await service.getBundle(lisbon, TODAY);

      expect(forecast.calls).toHaveLength(1);
      expect(bundle.weather.stale).toBe(false);
      expect(bundle.weather.payload.timezone).toBe('Europe/Lisbon');
    });

    it('does not call upstream at all while the stored forecast is fresh', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(2 * HOUR);

      const again = await service.getBundle(lisbon, TODAY);

      expect(forecast.calls).toHaveLength(1);
      expect(again.weather.stale).toBe(false);
    });

    it('serves the stored forecast once it is stale, and refreshes behind the request', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(4 * HOUR);

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.weather.stale).toBe(true);
      // The request was answered from the store; the second call happened behind it.
      expect(forecast.calls).toHaveLength(2);
    });

    it('does not refresh again once the background refresh has landed', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(4 * HOUR);

      await service.getBundle(lisbon, TODAY);
      // Let the detached refresh finish and store its snapshot.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const third = await service.getBundle(lisbon, TODAY);

      // Two calls in total: the cold fetch, and the one the stale read kicked off. The
      // third read found the new snapshot waiting for it.
      expect(forecast.calls).toHaveLength(2);
      expect(third.weather.stale).toBe(false);
    });

    it('fetches inline once the stored forecast is past the stale window', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(25 * HOUR);

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(forecast.calls).toHaveLength(2);
      expect(bundle.weather.stale).toBe(false);
    });

    it('fetches inline when the stored forecast no longer reaches the end of the window', async () => {
      await service.getBundle(lisbon, TODAY);

      // Same snapshot, but now we are asking about a week later.
      const bundle = await service.getBundle(lisbon, '2026-09-20');

      expect(forecast.calls).toHaveLength(2);
      expect(bundle.weather.stale).toBe(false);
    });
  });

  describe('when the weather fetch fails', () => {
    it('serves the stored forecast and says it is stale', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(25 * HOUR);
      forecast.failure = new Error('upstream down');

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.weather.stale).toBe(true);
      expect(bundle.weather.payload.timezone).toBe('Europe/Lisbon');
      expect(logger.warnings.some((one) => one.message.includes('serving the stored forecast'))).toBe(
        true,
      );
    });

    it('fails when there is nothing stored at all', async () => {
      forecast.failure = new Error('upstream down');

      await expect(service.getBundle(lisbon, TODAY)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    });

    it('fails when what is stored no longer covers the days being asked about', async () => {
      // An old forecast scored for a week we have moved past would be seven days of
      // "insufficient data" dressed up as an answer (D-019).
      await service.getBundle(lisbon, TODAY);
      forecast.failure = new Error('upstream down');

      await expect(service.getBundle(lisbon, '2026-10-01')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    });

    it('serves a stored forecast even when the failure is not retryable', async () => {
      // A schema change and a 500 mean the same thing here: no new data.
      await service.getBundle(lisbon, TODAY);
      clock.advance(25 * HOUR);
      forecast.failure = Object.assign(new Error('schema moved'), { retryable: false });

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.weather.stale).toBe(true);
    });
  });

  describe('marine coverage', () => {
    it('reports the distance out to the cell the model answered from', async () => {
      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.marine.kind).toBe('ok');
      if (bundle.marine.kind !== 'ok') return;
      expect(bundle.marine.cellDistanceKm).toBeGreaterThan(1);
      expect(bundle.marine.cellDistanceKm).toBeLessThan(15);
    });

    it('remembers that an inland town has no waves, and stops asking', async () => {
      const denver = store.locations.upsertLocation(DENVER, T0);
      marine.payload = loadMarine('denver');

      const first = await service.getBundle(denver, TODAY);
      expect(first.marine).toEqual({ kind: 'unavailable', reason: 'no-coverage' });
      expect(store.snapshots.getLatest(denver.rowId, 'marine')?.status).toBe('unavailable');

      clock.advance(7 * HOUR);
      const second = await service.getBundle(denver, TODAY);

      expect(second.marine).toEqual({ kind: 'unavailable', reason: 'no-coverage' });
      // Past the six-hour TTL, but the answer stands for a week.
      expect(marine.calls).toHaveLength(1);
    });

    it('checks the coastline again after a week', async () => {
      const denver = store.locations.upsertLocation(DENVER, T0);
      marine.payload = loadMarine('denver');
      await service.getBundle(denver, TODAY);

      clock.advance(169 * HOUR);
      await service.getBundle(denver, TODAY);

      expect(marine.calls).toHaveLength(2);
    });

    it('degrades surfing alone when the marine fetch fails, leaving the weather intact', async () => {
      marine.failure = new Error('marine down');

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.marine).toEqual({ kind: 'unavailable', reason: 'outage' });
      expect(bundle.weather.payload.timezone).toBe('Europe/Lisbon');
      expect(bundle.weather.stale).toBe(false);
    });

    it('serves stored wave data when the marine fetch fails', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(25 * HOUR);
      marine.failure = new Error('marine down');

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.marine.kind).toBe('ok');
      if (bundle.marine.kind !== 'ok') return;
      expect(bundle.marine.stale).toBe(true);
    });

    it('keeps saying "no coverage" rather than "outage" when the recheck fails', async () => {
      const denver = store.locations.upsertLocation(DENVER, T0);
      marine.payload = loadMarine('denver');
      await service.getBundle(denver, TODAY);

      clock.advance(169 * HOUR);
      marine.failure = new Error('marine down');
      const bundle = await service.getBundle(denver, TODAY);

      // We still know there is no sea near Denver; the outage does not unlearn that.
      expect(bundle.marine).toEqual({ kind: 'unavailable', reason: 'no-coverage' });
    });

    it('serves stale wave data with stale marked on the bundle', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(7 * HOUR);

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.marine.kind).toBe('ok');
      if (bundle.marine.kind !== 'ok') return;
      expect(bundle.marine.stale).toBe(true);
    });
  });

  describe('concurrency', () => {
    it('collapses ten simultaneous cold requests into one call per source', async () => {
      const gate = deferred();
      forecast.gate = gate.promise;
      marine.gate = gate.promise;

      const requests = Array.from({ length: 10 }, () => service.getBundle(lisbon, TODAY));
      gate.resolve();
      const bundles = await Promise.all(requests);

      expect(forecast.calls).toHaveLength(1);
      expect(marine.calls).toHaveLength(1);
      expect(bundles).toHaveLength(10);
      expect(bundles.every((one) => one.weather.payload.timezone === 'Europe/Lisbon')).toBe(true);
    });

    it('lets the next request through once a refresh has failed', async () => {
      // A failed refresh that left its promise behind would poison this location.
      forecast.failure = new Error('first attempt fails');
      await service.getBundle(lisbon, TODAY).catch(() => undefined);

      forecast.failure = undefined;
      const bundle = await service.getBundle(lisbon, TODAY);

      expect(forecast.calls).toHaveLength(2);
      expect(bundle.weather.stale).toBe(false);
    });

    it('keeps two locations independent', async () => {
      const denver = store.locations.upsertLocation(DENVER, T0);

      await Promise.all([service.getBundle(lisbon, TODAY), service.getBundle(denver, TODAY)]);

      expect(forecast.calls).toHaveLength(2);
    });

    it('never lets a background refresh become an unhandled rejection', async () => {
      await service.getBundle(lisbon, TODAY);
      clock.advance(4 * HOUR);
      forecast.failure = new Error('background boom');

      const bundle = await service.getBundle(lisbon, TODAY);
      // Let the detached refresh settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(bundle.weather.stale).toBe(true);
      expect(logger.warnings.some((one) => one.message.includes('background refresh failed'))).toBe(
        true,
      );
    });
  });

  describe('a stored payload that cannot be read back', () => {
    /** Corrupt the stored row for one source, as a schema change between write and read would. */
    const corrupt = (source: 'weather' | 'marine'): void => {
      const stored = store.snapshots.getLatest(lisbon.rowId, source);
      store.db
        .prepare('UPDATE forecast_snapshots SET payload = ? WHERE id = ?')
        .run('{"nonsense":true}', stored?.id ?? 0);
    };

    it('re-fetches a marine row it cannot parse, rather than failing on it', async () => {
      await service.getBundle(lisbon, TODAY);
      corrupt('marine');

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(marine.calls).toHaveLength(2);
      expect(bundle.marine.kind).toBe('ok');
      expect(logger.warnings.some((one) => one.message.includes('could not be read back'))).toBe(true);
    });

    it('does not take the whole response down when it can neither parse nor re-fetch', async () => {
      // The single worst failure mode available here: one unreadable row costing all
      // four activities. D§6.4 forbids exactly this.
      await service.getBundle(lisbon, TODAY);
      corrupt('marine');
      marine.failure = new Error('marine down too');

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(bundle.weather.payload.timezone).toBe('Europe/Lisbon');
      expect(bundle.marine).toEqual({ kind: 'unavailable', reason: 'outage' });
    });

    it('fetches again rather than serving a forecast it cannot parse', async () => {
      await service.getBundle(lisbon, TODAY);
      corrupt('weather');

      const bundle = await service.getBundle(lisbon, TODAY);

      expect(forecast.calls).toHaveLength(2);
      expect(bundle.weather.payload.timezone).toBe('Europe/Lisbon');
    });

    it('fails with a coded error when it cannot parse and cannot fetch either', async () => {
      await service.getBundle(lisbon, TODAY);
      corrupt('weather');
      forecast.failure = new Error('upstream down');

      // Not a bare UpstreamError: phase 5 needs the code to answer properly (D§8.3).
      await expect(service.getBundle(lisbon, TODAY)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    });
  });

  describe('what gets stored', () => {
    it('keeps the payload as it arrived, and the dates it covers', async () => {
      await service.getBundle(lisbon, TODAY);

      const stored = store.snapshots.getLatest(lisbon.rowId, 'weather');
      expect(stored).toMatchObject({
        status: 'ok',
        firstDate: '2026-09-14',
        lastDate: '2026-09-21',
        fetchedAt: T0,
      });
      expect(JSON.parse(stored?.payload ?? '{}')).toEqual(loadWeather('lisbon'));
    });

    it('records the grid cell the model actually used, not the town', async () => {
      await service.getBundle(lisbon, TODAY);

      const stored = store.snapshots.getLatest(lisbon.rowId, 'weather');
      expect(stored?.gridLatitude).toBe(38.75);
      expect(stored?.gridLatitude).not.toBe(lisbon.latitude);
    });

    it('stores an unavailable marine answer with no payload and no dates', async () => {
      const denver = store.locations.upsertLocation(DENVER, T0);
      marine.payload = loadMarine('denver');
      await service.getBundle(denver, TODAY);

      const stored = store.snapshots.getLatest(denver.rowId, 'marine');
      expect(stored).toMatchObject({ status: 'unavailable' });
      expect(stored?.payload).toBeUndefined();
      expect(stored?.firstDate).toBeUndefined();
    });
  });

  describe('freshnessOf', () => {
    it('tells the refresher what it needs without fetching anything', async () => {
      expect(service.freshnessOf(lisbon, 'weather', TODAY)).toBe('expired');

      await service.getBundle(lisbon, TODAY);
      expect(service.freshnessOf(lisbon, 'weather', TODAY)).toBe('fresh');

      clock.advance(4 * HOUR);
      expect(service.freshnessOf(lisbon, 'weather', TODAY)).toBe('stale');
      expect(service.freshnessOf(lisbon, 'marine', TODAY)).toBe('fresh');
    });
  });
});

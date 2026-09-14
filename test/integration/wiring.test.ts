/**
 * The seam between the app and its background work (D§6.3).
 *
 * Small, but the two halves of it are the kind of mistake that no other test in the suite
 * would notice: a refresher started inside `createApp` gives every test a timer it never
 * asked for, and one the app never stops keeps firing at a closed database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { App } from '../../src/app.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { fixedClock } from '../../src/services/clock.js';
import type { RecordingLogger, Store } from '../helpers/services.js';
import {
  fakeForecast,
  fakeGeocoding,
  fakeMarine,
  geocodingResultFor,
  LISBON,
  openStore,
  recordingLogger,
  T0,
} from '../helpers/services.js';

describe('the refresher inside the app', () => {
  let store: Store;
  let logger: RecordingLogger;
  let app: App;

  /** The one line a cycle leaves behind. */
  const cycles = (): number => logger.records.filter((one) => one.message === 'refresh cycle').length;

  beforeEach(() => {
    // Installed before the app is built, so a timer created during `createApp` would
    // still be caught by the advances below.
    vi.useFakeTimers();
    store = openStore();
    logger = recordingLogger();
    app = createApp({
      config: loadConfig({ REFRESH_ENABLED: 'true', REFRESH_INTERVAL_MINUTES: '10' }),
      clock: fixedClock(T0),
      db: store.db,
      logger,
      clients: {
        geocoding: fakeGeocoding([geocodingResultFor(LISBON)]),
        forecast: fakeForecast(),
        marine: fakeMarine(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is built but not started', async () => {
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(cycles()).toBe(0);

    await app.close();
  });

  it('runs once the bootstrap starts it', async () => {
    app.refresher.start();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(cycles()).toBe(1);

    await app.close();
  });

  it('stops when the app closes', async () => {
    app.refresher.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycles()).toBe(1);

    // Shutdown calls this, and the database is closed immediately afterwards.
    await app.close();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(cycles()).toBe(1);
  });
});

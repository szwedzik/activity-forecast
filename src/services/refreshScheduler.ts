/**
 * Keeping warm towns warm (D§6.3).
 *
 * The request path already refreshes on a policy rather than per request, so this is not
 * what makes the service correct. What it buys is that somebody asking about Lisbon at
 * nine in the morning gets an answer from the store rather than waiting on Open-Meteo,
 * because the cycle refreshed it while nobody was looking.
 *
 * Deliberately unhurried: one location at a time with a pause between calls, and only
 * for towns someone actually asked about in the last day.
 */
import type { LocationRepository } from '../adapters/db/locationRepository.js';
import type { SnapshotRepository, SnapshotSource } from '../adapters/db/snapshotRepository.js';
import type { Location } from '../domain/location.js';
import type { Clock } from './clock.js';
import { toIsoUtc } from './clock.js';
import type { ForecastService } from './forecastService.js';
import { todayIn } from './localDate.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

const SOURCES: readonly SnapshotSource[] = ['weather', 'marine'];

export interface CycleResult {
  /** Towns considered this cycle. */
  readonly locations: number;
  readonly refreshed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly pruned: number;
}

export interface RefreshScheduler {
  /** Begins the timer. A no-op when disabled, or when already started. */
  start(): void;
  /** Stops the timer and waits for a cycle already in flight. Safe to call twice. */
  stop(): Promise<void>;
  /**
   * One cycle, now. Public so the work can be tested without timers: what matters is
   * which calls it makes, and that question has nothing to do with clocks.
   *
   * Tracked but not guarded, unlike the timer's own path: two of these running at once
   * would overwrite each other and `stop()` would wait only on the second. Nothing in
   * the service calls it, so this is a caveat for a test rather than a bug.
   */
  runCycle(): Promise<CycleResult>;
}

export interface RefreshSchedulerOptions {
  readonly locations: LocationRepository;
  readonly snapshots: SnapshotRepository;
  readonly forecasts: ForecastService;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly enabled: boolean;
  readonly intervalMs: number;
  /** How recently a town must have been asked about to be worth keeping warm. */
  readonly activeWindowMs: number;
  readonly retentionMs: number;
  /**
   * Most locations one cycle will touch. Anyone can fill the table by asking about a
   * thousand towns once, and every one of them would otherwise be refetched every ten
   * minutes for a day (D-028).
   */
  readonly maxLocations?: number;
  /** Delay before the first cycle, so start-up is not competing with itself. */
  readonly startupDelayMs?: number;
  /** Between upstream calls. Politeness to a free, non-commercial tier. */
  readonly pauseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_STARTUP_DELAY_MS = 5_000;
const DEFAULT_PAUSE_MS = 250;
const DEFAULT_MAX_LOCATIONS = 200;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
  const { locations, snapshots, forecasts, clock } = options;
  const logger = options.logger ?? silentLogger;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const sleep = options.sleep ?? wait;
  const startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;

  let startupTimer: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  let running: Promise<CycleResult> | undefined;

  async function refreshLocation(
    location: Location,
    now: Date,
    counts: { refreshed: number; skipped: number; failed: number },
  ): Promise<void> {
    // A town whose zone the runtime cannot resolve would otherwise abort the whole cycle
    // and take every town after it down with it.
    const todayLocal = todayIn(now, location.timezone);

    for (const source of SOURCES) {
      const state = forecasts.freshnessOf(location, source, todayLocal);

      // `unavailable` is an answer, not a gap: re-asking Open-Meteo whether Denver has
      // a coastline every ten minutes would be the opposite of the point (D§6.1).
      if (state === 'fresh' || state === 'unavailable') {
        counts.skipped += 1;
        continue;
      }

      try {
        await forecasts.refresh(location, source);
        counts.refreshed += 1;
      } catch (error) {
        counts.failed += 1;
        logger.warn(
          { location: location.name, source, error: String(error) },
          'refresh failed during the background cycle',
        );
      }

      await sleep(pauseMs);
    }
  }

  async function cycle(): Promise<CycleResult> {
    const now = clock.now();
    const since = toIsoUtc(new Date(now.getTime() - options.activeWindowMs));
    const active = locations.recentlyRequested(since, options.maxLocations ?? DEFAULT_MAX_LOCATIONS);
    const counts = { refreshed: 0, skipped: 0, failed: 0 };

    for (const location of active) {
      try {
        await refreshLocation(location, now, counts);
      } catch (error) {
        counts.failed += 1;
        logger.warn(
          { location: location.name, error: String(error) },
          'skipped a location during the background cycle',
        );
      }
    }

    // After the refreshes, so the rows just written are the ones kept.
    const pruned = snapshots.prune(toIsoUtc(new Date(now.getTime() - options.retentionMs)));

    const result: CycleResult = { locations: active.length, ...counts, pruned };
    logger.info({ ...result }, 'refresh cycle');
    return result;
  }

  /** Tracked so `stop()` knows to wait for it, whoever started it. */
  function track(started: Promise<CycleResult>): Promise<CycleResult> {
    running = started;
    void started.catch(() => undefined).finally(() => {
      if (running === started) running = undefined;
    });
    return started;
  }

  /** Never overlaps itself: a slow cycle should delay the next one, not race it. */
  async function runGuarded(): Promise<void> {
    if (running) return;
    try {
      await track(cycle());
    } catch (error) {
      logger.error({ error: String(error) }, 'refresh cycle failed');
    }
  }

  return {
    start() {
      if (!options.enabled || interval) return;

      startupTimer = setTimeout(() => void runGuarded(), startupDelayMs);
      interval = setInterval(() => void runGuarded(), options.intervalMs);
      // Neither timer should hold the process open; shutdown decides when we stop.
      startupTimer.unref?.();
      interval.unref?.();
    },

    async stop() {
      if (startupTimer) clearTimeout(startupTimer);
      if (interval) clearInterval(interval);
      startupTimer = undefined;
      interval = undefined;
      // A cycle in flight is mid-way through writing snapshots; let it finish before
      // anything closes the database underneath it. Its failure is runGuarded's to log,
      // not something that should stop a shutdown: a rejection here would leave the
      // server and the database open and the process unable to exit (D-026).
      await running?.catch(() => undefined);
    },

    runCycle: () => track(cycle()),
  };
}

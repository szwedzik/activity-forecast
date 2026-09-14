/**
 * When to call Open-Meteo, and what to serve when we cannot (D§6).
 *
 * The brief asks for the weather to be persisted rather than fetched on every request;
 * this is the file that decides what that means. Reads go to the store first, refreshes
 * happen behind the request wherever possible, and an upstream outage degrades the answer
 * rather than removing it.
 */
import type { SnapshotRepository, Snapshot, SnapshotSource } from '../adapters/db/snapshotRepository.js';
import type { ForecastClient } from '../adapters/openMeteo/forecastClient.js';
import type { MarineClient } from '../adapters/openMeteo/marineClient.js';
import { hasNoWaveData } from '../adapters/openMeteo/marineClient.js';
import {
  marineResponseSchema,
  parseUpstream,
  weatherResponseSchema,
} from '../adapters/openMeteo/schemas.js';
import type { MarinePayload, WeatherPayload } from '../domain/forecast/types.js';
import { haversineKm } from '../domain/geo.js';
import type { Location } from '../domain/location.js';
import type { Clock } from './clock.js';
import { toIsoUtc } from './clock.js';
import { upstreamUnavailable } from './errors.js';
import type { FreshnessPolicy } from './freshness.js';
import type { Freshness } from './freshness.js';
import { classify, isServable, MARINE_POLICY, WEATHER_POLICY } from './freshness.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

export interface WeatherPart {
  readonly snapshot: Snapshot;
  readonly payload: WeatherPayload;
  /** True when what we served is past its TTL: a refresh is running, or upstream is down. */
  readonly stale: boolean;
}

export type MarinePart =
  | {
      readonly kind: 'ok';
      readonly snapshot: Snapshot;
      readonly payload: MarinePayload;
      readonly stale: boolean;
      /** How far out to sea the model answered from (D§2.3). */
      readonly cellDistanceKm: number;
    }
  | {
      readonly kind: 'unavailable';
      /** `no-coverage` is permanent and inland; `outage` is upstream being down right now. */
      readonly reason: 'no-coverage' | 'outage';
    };

export interface ForecastBundle {
  readonly location: Location;
  readonly todayLocal: string;
  readonly weather: WeatherPart;
  readonly marine: MarinePart;
}

export interface ForecastService {
  getBundle(location: Location, todayLocal: string): Promise<ForecastBundle>;
  /** Fetch and store one source now, collapsing concurrent callers onto one request. */
  refresh(location: Location, source: SnapshotSource): Promise<Snapshot>;
  /** What the refresher needs to know before deciding to spend a call (D§6.3). */
  freshnessOf(location: Location, source: SnapshotSource, todayLocal: string): Freshness;
}

export interface ForecastServiceOptions {
  readonly snapshots: SnapshotRepository;
  readonly forecast: ForecastClient;
  readonly marine: MarineClient;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly weatherPolicy?: FreshnessPolicy;
  readonly marinePolicy?: FreshnessPolicy;
}

/**
 * A stored payload has to survive being read back: the schema can move under us between
 * the write and the read. A row we cannot parse is unusable rather than fatal, so this
 * returns nothing instead of throwing and the caller treats it like a missing snapshot
 * (D-020). Letting it throw here would take the whole response down over one bad row,
 * which is exactly what D§6.4 forbids for marine.
 */
function parsePayload<Payload>(
  snapshot: Snapshot,
  schema: Parameters<typeof parseUpstream<Payload>>[0],
  what: string,
  onUnreadable: (error: unknown) => void,
): Payload | undefined {
  if (snapshot.payload === undefined) return undefined;
  try {
    return parseUpstream(schema, JSON.parse(snapshot.payload), what);
  } catch (error) {
    onUnreadable(error);
    return undefined;
  }
}

const cellDistance = (location: Location, payload: MarinePayload): number =>
  haversineKm(location, { latitude: payload.latitude, longitude: payload.longitude });

export function createForecastService(options: ForecastServiceOptions): ForecastService {
  const { snapshots, forecast, marine, clock } = options;
  const logger = options.logger ?? silentLogger;
  const policies: Record<SnapshotSource, FreshnessPolicy> = {
    weather: options.weatherPolicy ?? WEATHER_POLICY,
    marine: options.marinePolicy ?? MARINE_POLICY,
  };

  /**
   * One promise per location and source. Ten simultaneous first requests for the same
   * town make one call, not ten (D§6.2).
   */
  const inflight = new Map<string, Promise<Snapshot>>();

  async function fetchAndStore(location: Location, source: SnapshotSource): Promise<Snapshot> {
    const fetchedAt = toIsoUtc(clock.now());
    // One line per call that actually leaves the process, so "served from the store" is
    // something anyone can verify from the log rather than take on trust.
    logger.info({ location: location.name, source }, 'calling Open-Meteo');

    if (source === 'marine') {
      const payload = await marine.fetchMarine(location.latitude, location.longitude, location.timezone);

      // Inland there is no error to catch: the request succeeds and every value is null.
      // Storing that fact is what stops us asking again every six hours (D§2.3).
      if (hasNoWaveData(payload)) {
        return snapshots.insert({
          locationId: location.rowId,
          source,
          status: 'unavailable',
          fetchedAt,
        });
      }

      return snapshots.insert({
        locationId: location.rowId,
        source,
        status: 'ok',
        fetchedAt,
        firstDate: payload.daily.time[0],
        lastDate: payload.daily.time.at(-1),
        gridLatitude: payload.latitude,
        gridLongitude: payload.longitude,
        payload: JSON.stringify(payload),
      });
    }

    const payload = await forecast.fetchForecast(
      location.latitude,
      location.longitude,
      location.timezone,
    );

    return snapshots.insert({
      locationId: location.rowId,
      source,
      status: 'ok',
      fetchedAt,
      firstDate: payload.daily.time[0],
      lastDate: payload.daily.time.at(-1),
      gridLatitude: payload.latitude,
      gridLongitude: payload.longitude,
      gridElevationM: payload.elevation ?? undefined,
      payload: JSON.stringify(payload),
    });
  }

  function refresh(location: Location, source: SnapshotSource): Promise<Snapshot> {
    const key = `${location.rowId}:${source}`;
    const running = inflight.get(key);
    if (running) return running;

    // Cleared on settle rather than on success: a failed refresh that left its promise
    // behind would poison this location until the process restarted.
    const started = fetchAndStore(location, source).finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  }

  /** Not awaited on purpose, so it needs its own catch or it becomes an unhandled rejection. */
  function refreshInBackground(location: Location, source: SnapshotSource): void {
    refresh(location, source).catch((error: unknown) => {
      logger.warn(
        { location: location.name, source, error: String(error) },
        'background refresh failed; the stored forecast still stands',
      );
    });
  }

  async function weatherPart(location: Location, todayLocal: string): Promise<WeatherPart> {
    const stored = snapshots.getLatest(location.rowId, 'weather');
    const state = classify(stored, clock.now(), todayLocal, policies.weather);

    const unreadable = (error: unknown): void => {
      logger.warn(
        { location: location.name, source: 'weather', error: String(error) },
        'stored forecast could not be read back; treating it as missing',
      );
    };
    const readable = (snapshot: Snapshot | undefined): WeatherPayload | undefined =>
      snapshot === undefined
        ? undefined
        : parsePayload<WeatherPayload>(snapshot, weatherResponseSchema, 'stored forecast', unreadable);

    if (stored !== undefined && (state === 'fresh' || state === 'stale')) {
      const payload = readable(stored);
      // A row we cannot parse is not a usable snapshot, so it falls through to a fetch
      // rather than taking the response down with it (D-020).
      if (payload) {
        if (state === 'stale') refreshInBackground(location, 'weather');
        return { snapshot: stored, payload, stale: state === 'stale' };
      }
    }

    try {
      const fetched = await refresh(location, 'weather');
      const payload = readable(fetched);
      if (!payload) throw upstreamUnavailable(`the forecast at ${location.name}`);

      if (!isServable(fetched, todayLocal)) {
        // Upstream answered, but not about the days being asked for. Serving it is what
        // D§6.1 says to do; saying so is how anyone notices the refetch loop (D-020).
        logger.warn(
          { location: location.name, todayLocal, first: fetched.firstDate, last: fetched.lastDate },
          'fetched forecast does not cover the whole window',
        );
      }
      return { snapshot: fetched, payload, stale: false };
    } catch (error) {
      // Any failure, not only a retryable one: a schema change and a 500 both mean we
      // cannot get new data, and the last good forecast beats an error either way.
      const fallback = stored !== undefined && isServable(stored, todayLocal) ? readable(stored) : undefined;
      if (stored !== undefined && fallback) {
        logger.warn(
          { location: location.name, error: String(error) },
          'weather refresh failed; serving the stored forecast',
        );
        return { snapshot: stored, payload: fallback, stale: true };
      }
      throw upstreamUnavailable(`the forecast at ${location.name}`, error);
    }
  }

  async function marinePart(location: Location, todayLocal: string): Promise<MarinePart> {
    const stored = snapshots.getLatest(location.rowId, 'marine');
    const state = classify(stored, clock.now(), todayLocal, policies.marine);

    // A remembered "no waves here". Not a gap, so nothing is fetched.
    if (state === 'unavailable') return { kind: 'unavailable', reason: 'no-coverage' };

    const unreadable = (error: unknown): void => {
      logger.warn(
        { location: location.name, source: 'marine', error: String(error) },
        'stored wave data could not be read back; treating it as missing',
      );
    };

    /** Nothing here throws: surfing degrades on its own, it never fails the request. */
    const serve = (snapshot: Snapshot, stale: boolean): MarinePart | undefined => {
      const payload = parsePayload<MarinePayload>(
        snapshot,
        marineResponseSchema,
        'stored marine',
        unreadable,
      );
      if (!payload) return undefined;
      return {
        kind: 'ok',
        snapshot,
        payload,
        stale,
        cellDistanceKm: cellDistance(location, payload),
      };
    };

    if (stored !== undefined && (state === 'fresh' || state === 'stale')) {
      const served = serve(stored, state === 'stale');
      if (served) {
        if (state === 'stale') refreshInBackground(location, 'marine');
        return served;
      }
    }

    try {
      const fetched = await refresh(location, 'marine');
      if (fetched.status === 'unavailable') return { kind: 'unavailable', reason: 'no-coverage' };
      return serve(fetched, false) ?? { kind: 'unavailable', reason: 'outage' };
    } catch (error) {
      // Surfing degrades alone. A marine outage must never take the other three
      // activities down with it (D§6.4).
      logger.warn(
        { location: location.name, error: String(error) },
        'marine refresh failed; surfing will be reported as unavailable',
      );
      if (stored !== undefined && isServable(stored, todayLocal)) {
        const served = serve(stored, true);
        if (served) return served;
      }
      // An outage does not unlearn geography: if we already knew there is no sea here,
      // that is still the truer answer than "temporarily unavailable" (D-020).
      if (stored?.status === 'unavailable') return { kind: 'unavailable', reason: 'no-coverage' };
      return { kind: 'unavailable', reason: 'outage' };
    }
  }

  return {
    async getBundle(location, todayLocal) {
      // Both at once: marinePart resolves whatever happens, so it cannot leave an
      // orphaned rejection behind if the weather half throws. Serialising them would
      // double the wait on a cold location for no benefit.
      const [weather, marine] = await Promise.all([
        weatherPart(location, todayLocal),
        marinePart(location, todayLocal),
      ]);

      return { location, todayLocal, weather, marine };
    },

    refresh,

    freshnessOf(location, source, todayLocal) {
      return classify(
        snapshots.getLatest(location.rowId, source),
        clock.now(),
        todayLocal,
        policies[source],
      );
    },
  };
}

/**
 * Turning a name someone typed into a place we know about (D§2.1, D§6.4).
 *
 * Every answer is remembered, including "there is no such place", so a nonsense query is
 * geocoded once rather than on every request. A hit is good for a month — towns do not
 * move — and a miss for a day, in case the geocoder gains a place it did not have.
 */
import type { LocationRepository } from '../adapters/db/locationRepository.js';
import { queryKey } from '../adapters/db/locationRepository.js';
import type { GeocodingClient, GeocodingResult } from '../adapters/openMeteo/geocodingClient.js';
import type { Location, NewLocation } from '../domain/location.js';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import { toIsoUtc } from './clock.js';
import { upstreamUnavailable } from './errors.js';

/** No place matched, which is a real answer and worth remembering. */
export const NOT_FOUND = 'not-found';
export type NotFound = typeof NOT_FOUND;

export interface GeocodePolicy {
  readonly hitTtlMs: number;
  readonly missTtlMs: number;
}

const HOUR_MS = 3_600_000;

/** D§9 defaults: hits for 30 days, misses for 24 hours. */
export const GEOCODE_POLICY: GeocodePolicy = {
  hitTtlMs: 30 * 24 * HOUR_MS,
  missTtlMs: 24 * HOUR_MS,
};

export interface LocationService {
  /** The geocoder's top match, by prominence: Paris, France before Paris, Texas (Q3). */
  resolve(city: string, countryCode?: string): Promise<Location | NotFound>;
  /** Candidates for disambiguation. Not cached, and does not count as a visit. */
  search(query: string, countryCode?: string, limit?: number): Promise<GeocodingResult[]>;
}

export interface LocationServiceOptions {
  readonly repository: LocationRepository;
  readonly geocoding: GeocodingClient;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly policy?: GeocodePolicy;
}

/** The geocoder's field names are not ours, and this is the only place they meet. */
function toNewLocation(result: GeocodingResult): NewLocation {
  return {
    geonamesId: result.id,
    name: result.name,
    countryCode: result.country_code,
    country: result.country,
    admin1: result.admin1,
    latitude: result.latitude,
    longitude: result.longitude,
    // The geocoder says null for "no elevation"; we say absent.
    elevationM: result.elevation ?? undefined,
    timezone: result.timezone,
    population: result.population,
  };
}

export function createLocationService(options: LocationServiceOptions): LocationService {
  const { repository, geocoding, clock } = options;
  const logger = options.logger ?? silentLogger;
  const policy = options.policy ?? GEOCODE_POLICY;

  const stillGood = (resolvedAt: string, isHit: boolean, now: Date): boolean => {
    const age = now.getTime() - new Date(resolvedAt).getTime();
    return age < (isHit ? policy.hitTtlMs : policy.missTtlMs);
  };

  const geocode = async (
    name: string,
    countryCode: string | undefined,
    count: number,
  ): Promise<GeocodingResult[]> => {
    logger.info({ name, countryCode }, 'calling Open-Meteo geocoding');
    try {
      return await geocoding.search(name, { countryCode, count });
    } catch (error) {
      throw upstreamUnavailable('the geocoder', error);
    }
  };

  return {
    async resolve(city, countryCode) {
      const key = queryKey(city, countryCode);
      const now = clock.now();
      const nowIso = toIsoUtc(now);

      const cached = repository.findByQueryKey(key);
      if (cached && stillGood(cached.resolvedAt, cached.location !== undefined, now)) {
        if (!cached.location) return NOT_FOUND;
        // Every resolve counts as a visit, which is what keeps this town in the
        // refresher's working set (D§6.3).
        repository.touch(cached.location.rowId, nowIso);
        return { ...cached.location, lastRequestedAt: nowIso };
      }

      // Only the top match is needed; prominence ordering means it is the right one.
      let top: GeocodingResult | undefined;
      try {
        [top] = await geocode(city, countryCode, 1);
      } catch (error) {
        // A town does not move, so an expired geocode is still the right answer when the
        // geocoder is down. Refusing here would have claimed nothing was stored while the
        // forecast for that same town was sitting in the database, servable (D-032).
        if (cached?.location) {
          logger.warn(
            { city, error: String(error) },
            'geocoder unavailable; serving the coordinates we already had',
          );
          repository.touch(cached.location.rowId, nowIso);
          return { ...cached.location, lastRequestedAt: nowIso };
        }
        throw error;
      }

      if (!top) {
        repository.cacheQuery(key, null, nowIso);
        return NOT_FOUND;
      }

      const location = repository.upsertLocation(toNewLocation(top), nowIso);
      repository.cacheQuery(key, location.rowId, nowIso);
      repository.touch(location.rowId, nowIso);
      return { ...location, lastRequestedAt: nowIso };
    },

    async search(query, countryCode, limit) {
      // Deliberately uncached and untouched: browsing candidates is not the same as
      // asking for a forecast, and should not keep a town warm (D§6.4, D-012).
      return geocode(query, countryCode, limit ?? 5);
    },
  };
}

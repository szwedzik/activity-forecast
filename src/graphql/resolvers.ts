/**
 * The edge (D§8). Two jobs and no third: check the input, and shape the answer the
 * services already produced. Anything that looks like a decision belongs a layer down.
 */
import type { GeocodingResult } from '../adapters/openMeteo/geocodingClient.js';
import type { Activity } from '../domain/forecast/types.js';
import { ACTIVITIES } from '../domain/forecast/types.js';
import type { Location } from '../domain/location.js';
import type { LocationService } from '../services/locationService.js';
import type { RankingService } from '../services/rankingService.js';
import { badUserInput, toGraphQLError } from './errors.js';
import { DateScalar, DateTimeScalar } from './scalars.js';

export interface ResolverContext {
  readonly ranking: RankingService;
  readonly locations: LocationService;
}

const MAX_NAME_LENGTH = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

/** D§8.3: empty or overlong place names are the caller's mistake, not a lookup miss. */
function placeName(value: string, field: string): string {
  const trimmed = value.trim();
  // A place name has to contain something nameable. `trim` leaves control characters
  // and zero-width joiners behind, and those would reach the geocoder and be remembered
  // as a miss.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) throw badUserInput(`${field} must not be empty.`);
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw badUserInput(`${field} must be at most ${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

function countryCode(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z]{2}$/.test(trimmed)) {
    throw badUserInput('countryCode must be two letters, such as "US".');
  }
  return trimmed.toUpperCase();
}

function limitOf(value: number | null | undefined): number {
  if (value === null || value === undefined) return 5;
  if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
    throw badUserInput(`limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}.`);
  }
  return value;
}

/**
 * An absent list means all four; an empty one is a caller who asked for nothing and
 * would be confused by an empty answer. Duplicates collapse, order is kept (D-012).
 */
function activitiesOf(value: readonly Activity[] | null | undefined): readonly Activity[] {
  if (value === null || value === undefined) return ACTIVITIES;
  if (value.length === 0) throw badUserInput('activities must not be empty when provided.');
  return [...new Set(value)];
}

/**
 * The identifier the API publishes is the geocoder's, not our row id: it is stable
 * across databases and it is what a caller can use elsewhere (D§8.1, D-017).
 */
const locationOf = (location: Location) => ({
  id: location.geonamesId,
  name: location.name,
  country: location.country ?? null,
  countryCode: location.countryCode ?? null,
  admin1: location.admin1 ?? null,
  latitude: location.latitude,
  longitude: location.longitude,
  elevationM: location.elevationM ?? null,
  timezone: location.timezone,
});

/** A search candidate has never been stored, so it still wears the geocoder's names. */
const candidateOf = (result: GeocodingResult) => ({
  id: result.id,
  name: result.name,
  country: result.country ?? null,
  countryCode: result.country_code ?? null,
  admin1: result.admin1 ?? null,
  latitude: result.latitude,
  longitude: result.longitude,
  elevationM: result.elevation ?? null,
  timezone: result.timezone,
});

export const resolvers = {
  Date: DateScalar,
  DateTime: DateTimeScalar,

  Query: {
    async activityRankings(
      _parent: unknown,
      args: { city: string; countryCode?: string | null; activities?: Activity[] | null },
      context: ResolverContext,
    ) {
      const city = placeName(args.city, 'city');
      const code = countryCode(args.countryCode);
      const activities = activitiesOf(args.activities);

      try {
        const result = await context.ranking.rank(city, code, activities);
        return {
          location: locationOf(result.location),
          forecast: result.forecast,
          days: result.days,
          rankings: result.rankings,
        };
      } catch (error) {
        // Services speak in codes already; this only translates them (D-021).
        throw toGraphQLError(error);
      }
    },

    async searchLocations(
      _parent: unknown,
      args: { query: string; countryCode?: string | null; limit?: number | null },
      context: ResolverContext,
    ) {
      const query = placeName(args.query, 'query');
      const code = countryCode(args.countryCode);
      const limit = limitOf(args.limit);

      try {
        const results = await context.locations.search(query, code, limit);
        return results.slice(0, limit).map(candidateOf);
      } catch (error) {
        throw toGraphQLError(error);
      }
    },
  },
};

/**
 * Locations, and the cache of "what did this query turn out to mean" (D§5.1).
 *
 * All SQL for these two tables lives here. Timestamps arrive as ISO-8601 UTC strings
 * from the caller: a repository that read the clock could not be tested at an instant.
 */
import type { Location, NewLocation } from '../../domain/location.js';
import type { Database } from './database.js';
import { orUndefined, query } from './database.js';

/**
 * The key a user's request is remembered under. Unicode is normalised first, so a name
 * typed with a combining accent and one typed with a precomposed character are the same
 * query rather than two (D§5.1, D-012).
 */
export function queryKey(name: string, countryCode?: string): string {
  const normalised = name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${normalised}|${(countryCode ?? '').toUpperCase()}`;
}

/**
 * What a remembered query resolved to. `location` absent means the geocoder found
 * nothing and we remembered that, which is different from never having asked.
 */
export interface CachedQuery {
  readonly resolvedAt: string;
  readonly location?: Location | undefined;
}

export interface LocationRepository {
  upsertLocation(location: NewLocation, createdAt: string): Location;
  findByQueryKey(key: string): CachedQuery | undefined;
  cacheQuery(key: string, locationId: number | null, resolvedAt: string): void;
  touch(locationId: number, at: string): void;
  recentlyRequested(since: string): Location[];
}

interface LocationRow {
  readonly id: number;
  readonly geonames_id: number;
  readonly name: string;
  readonly country_code: string | null;
  readonly country: string | null;
  readonly admin1: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly elevation_m: number | null;
  readonly timezone: string;
  readonly population: number | null;
  readonly created_at: string;
  readonly last_requested_at: string | null;
}

/**
 * The outer join returns a row of nulls where the location would be, so every column of
 * it is nullable until we have checked.
 */
type JoinedLocationRow = { readonly [K in keyof LocationRow]: LocationRow[K] | null };

interface CachedQueryRow extends JoinedLocationRow {
  readonly resolved_at: string;
}

function joinedLocation(row: CachedQueryRow): LocationRow | undefined {
  return row.id === null ? undefined : (row as LocationRow);
}

function toLocation(row: LocationRow): Location {
  return {
    rowId: row.id,
    geonamesId: row.geonames_id,
    name: row.name,
    countryCode: orUndefined(row.country_code),
    country: orUndefined(row.country),
    admin1: orUndefined(row.admin1),
    latitude: row.latitude,
    longitude: row.longitude,
    elevationM: orUndefined(row.elevation_m),
    timezone: row.timezone,
    population: orUndefined(row.population),
    createdAt: row.created_at,
    lastRequestedAt: orUndefined(row.last_requested_at),
  };
}

const UPSERT = `
INSERT INTO locations (
  geonames_id, name, country_code, country, admin1,
  latitude, longitude, elevation_m, timezone, population, created_at
) VALUES (
  :geonamesId, :name, :countryCode, :country, :admin1,
  :latitude, :longitude, :elevationM, :timezone, :population, :createdAt
)
ON CONFLICT (geonames_id) DO UPDATE SET
  name         = excluded.name,
  country_code = excluded.country_code,
  country      = excluded.country,
  admin1       = excluded.admin1,
  latitude     = excluded.latitude,
  longitude    = excluded.longitude,
  elevation_m  = excluded.elevation_m,
  timezone     = excluded.timezone,
  population   = excluded.population
RETURNING *`;

const FIND_BY_QUERY_KEY = `
SELECT q.resolved_at AS resolved_at, l.*
FROM location_queries q
LEFT JOIN locations l ON l.id = q.location_id
WHERE q.query_key = ?`;

export function createLocationRepository(db: Database): LocationRepository {
  const upsert = query<LocationRow>(db, UPSERT);
  const findQuery = query<CachedQueryRow>(db, FIND_BY_QUERY_KEY);
  const cache = query(
    db,
    `
    INSERT INTO location_queries (query_key, location_id, resolved_at)
    VALUES (?, ?, ?)
    ON CONFLICT (query_key) DO UPDATE SET
      location_id = excluded.location_id,
      resolved_at = excluded.resolved_at`,
  );
  const touchOne = query(db, 'UPDATE locations SET last_requested_at = ? WHERE id = ?');
  const recent = query<LocationRow>(
    db,
    'SELECT * FROM locations WHERE last_requested_at >= ? ORDER BY last_requested_at DESC',
  );

  return {
    /** The geocoder's id is the identity, so re-resolving a place refreshes its details
     *  in place: same row, same created_at, same foreign keys pointing at it. */
    upsertLocation(location, createdAt) {
      const row = upsert.get({
        geonamesId: location.geonamesId,
        name: location.name,
        countryCode: location.countryCode,
        country: location.country,
        admin1: location.admin1,
        latitude: location.latitude,
        longitude: location.longitude,
        elevationM: location.elevationM,
        timezone: location.timezone,
        population: location.population,
        createdAt,
      });

      if (!row) throw new Error(`upsert returned no row for geonames id ${location.geonamesId}`);
      return toLocation(row);
    },

    findByQueryKey(key) {
      const row = findQuery.get(key);
      if (!row) return undefined;

      // A remembered miss comes back with the query's timestamp and no location, which
      // is a different answer from never having asked.
      const location = joinedLocation(row);
      return location === undefined
        ? { resolvedAt: row.resolved_at }
        : { resolvedAt: row.resolved_at, location: toLocation(location) };
    },

    cacheQuery(key, locationId, resolvedAt) {
      cache.run(key, locationId, resolvedAt);
    },

    touch(locationId, at) {
      touchOne.run(at, locationId);
    },

    recentlyRequested(since) {
      return recent.all(since).map(toLocation);
    },
  };
}

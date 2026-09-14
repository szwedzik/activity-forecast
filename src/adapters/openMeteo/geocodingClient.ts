/**
 * Open-Meteo geocoding (D§2.1). Free-text place name in, candidate places out, ordered
 * by prominence, so the first result is Paris, France rather than Paris, Texas.
 */
import type { ClientOptions } from './http.js';
import { getJson } from './http.js';
import type { GeocodingResult } from './schemas.js';
import { geocodingResponseSchema, parseUpstream } from './schemas.js';

export type { GeocodingResult } from './schemas.js';

export const DEFAULT_RESULT_COUNT = 10;

export interface GeocodingSearchOptions {
  /** ISO 3166-1 alpha-2. Filtered server-side, so Springfield can be narrowed to one country. */
  readonly countryCode?: string | undefined;
  readonly count?: number | undefined;
}

export interface GeocodingClient {
  search(name: string, options?: GeocodingSearchOptions): Promise<GeocodingResult[]>;
}

export function buildGeocodingUrl(
  base: string,
  name: string,
  options: GeocodingSearchOptions = {},
): string {
  const query = new URLSearchParams({
    // Admin regions are not searchable, so the user's text goes through trimmed and
    // otherwise untouched; being clever here returns nothing at all (D§2.1).
    name: name.trim(),
    count: String(options.count ?? DEFAULT_RESULT_COUNT),
    language: 'en',
    format: 'json',
  });
  if (options.countryCode) query.set('countryCode', options.countryCode.toUpperCase());
  return `${base}?${query.toString()}`;
}

export function createGeocodingClient(options: ClientOptions): GeocodingClient {
  return {
    async search(name, search = {}) {
      const body = await getJson(buildGeocodingUrl(options.url, name, search), options);
      const parsed = parseUpstream(geocodingResponseSchema, body, 'geocoding');
      // No match means the key is absent rather than an empty array, which is the one
      // thing about this endpoint that catches everybody out (D§2.1).
      return parsed.results ?? [];
    },
  };
}

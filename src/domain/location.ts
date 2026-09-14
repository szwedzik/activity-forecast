/**
 * A place the service knows about.
 *
 * It lives in the domain rather than beside the SQL because everything uses it: the
 * repository stores one, the services resolve one, the API returns one. The geocoder's
 * own id is the natural key, so the same town keeps the same row across databases
 * (D§5.1, D-012).
 */

export interface Location {
  /**
   * Our primary key, meaningful only inside this database. Deliberately not called `id`:
   * the API's `Location.id` is the GeoNames id (D§8.1, D-012), so a resolver reaching for
   * the obvious `location.id` would quietly publish the wrong identifier. With no such
   * field, that mistake will not compile (D-017).
   */
  readonly rowId: number;
  /**
   * The GeoNames id Open-Meteo returns: stable across databases and reruns, and what the
   * API exposes as the location's identity.
   */
  readonly geonamesId: number;
  readonly name: string;
  readonly countryCode?: string | undefined;
  readonly country?: string | undefined;
  readonly admin1?: string | undefined;
  readonly latitude: number;
  readonly longitude: number;
  readonly elevationM?: number | undefined;
  /** IANA zone. Defines what "today" means here, and when the daylight windows fall. */
  readonly timezone: string;
  readonly population?: number | undefined;
  readonly createdAt: string;
  /** Last time someone asked about this place; drives the background refresher (D§6.3). */
  readonly lastRequestedAt?: string | undefined;
}

/** What the geocoder gives us, before the store assigns an id. */
export type NewLocation = Omit<Location, 'rowId' | 'createdAt' | 'lastRequestedAt'>;

/**
 * Open-Meteo marine forecast (D§2.3).
 *
 * Inland there is no error to catch: the request succeeds and every value is null. The
 * client returns that payload as it is, and deciding it means "surfing is not applicable
 * here" belongs to the caller, not to the transport.
 */
import type { MarinePayload } from '../../domain/forecast/types.js';
import type { ClientOptions } from './http.js';
import { getJson } from './http.js';
import { marineResponseSchema, parseUpstream } from './schemas.js';

export const MARINE_FORECAST_DAYS = 8;

export const MARINE_HOURLY_VARIABLES = [
  'wave_height',
  'wave_direction',
  'wave_period',
  'wind_wave_height',
  'wind_wave_period',
  'swell_wave_height',
  'swell_wave_period',
  'swell_wave_direction',
  'sea_surface_temperature',
] as const;

export const MARINE_DAILY_VARIABLES = [
  'wave_height_max',
  'wave_period_max',
  'swell_wave_height_max',
  'swell_wave_period_max',
] as const;

export interface MarineClient {
  fetchMarine(latitude: number, longitude: number, timezone: string): Promise<MarinePayload>;
}

export function buildMarineUrl(
  base: string,
  latitude: number,
  longitude: number,
  timezone: string,
): string {
  const query = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone,
    forecast_days: String(MARINE_FORECAST_DAYS),
    hourly: MARINE_HOURLY_VARIABLES.join(','),
    daily: MARINE_DAILY_VARIABLES.join(','),
  });
  return `${base}?${query.toString()}`;
}

/** True when the model has nothing to say here, which is how an inland town looks (D§2.3). */
export function hasNoWaveData(payload: MarinePayload): boolean {
  return payload.hourly.wave_height.every((value) => value === null);
}

export function createMarineClient(options: ClientOptions): MarineClient {
  return {
    async fetchMarine(latitude, longitude, timezone) {
      const body = await getJson(
        buildMarineUrl(options.url, latitude, longitude, timezone),
        options,
      );
      return parseUpstream(marineResponseSchema, body, 'marine');
    },
  };
}

/**
 * Open-Meteo weather forecast (D§2.2).
 *
 * The variable lists live here and nowhere else: the fixture-capture script imports
 * them, so what the tests were recorded against and what the running service asks for
 * cannot drift apart.
 */
import type { WeatherPayload } from '../../domain/forecast/types.js';
import type { ClientOptions } from './http.js';
import { getJson } from './http.js';
import { parseUpstream, weatherResponseSchema } from './schemas.js';

/** Eight days, so "today plus six" survives a snapshot taken late in the day (D§6.1). */
export const FORECAST_DAYS = 8;

export const FORECAST_HOURLY_VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'precipitation_probability',
  'snowfall',
  'snow_depth',
  'weather_code',
  'cloud_cover',
  'visibility',
  'wind_speed_10m',
  'wind_gusts_10m',
  'is_day',
] as const;

export const FORECAST_DAILY_VARIABLES = [
  'sunrise',
  'sunset',
  'sunshine_duration',
  'daylight_duration',
  'uv_index_max',
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'precipitation_sum',
  'rain_sum',
  'snowfall_sum',
  'precipitation_hours',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'cloud_cover_mean',
] as const;

export interface ForecastClient {
  fetchForecast(latitude: number, longitude: number, timezone: string): Promise<WeatherPayload>;
}

export function buildForecastUrl(
  base: string,
  latitude: number,
  longitude: number,
  timezone: string,
): string {
  const query = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    // The town's own zone, not `auto`: then the local dates in the payload and the local
    // date we call "today" are the same thing by construction (D-012).
    timezone,
    forecast_days: String(FORECAST_DAYS),
    hourly: FORECAST_HOURLY_VARIABLES.join(','),
    daily: FORECAST_DAILY_VARIABLES.join(','),
  });
  return `${base}?${query.toString()}`;
}

export function createForecastClient(options: ClientOptions): ForecastClient {
  return {
    async fetchForecast(latitude, longitude, timezone) {
      const body = await getJson(
        buildForecastUrl(options.url, latitude, longitude, timezone),
        options,
      );
      return parseUpstream(weatherResponseSchema, body, 'forecast');
    },
  };
}

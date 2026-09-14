/**
 * Builders for small synthetic Open-Meteo payloads, for the cases a captured fixture
 * cannot show: polar night, all-null series, and weather and marine snapshots that
 * start on different days.
 */
import { dateRange } from '../../src/domain/forecast/localDate.js';
import type {
  MarineHourly,
  MarinePayload,
  Series,
  WeatherDaily,
  WeatherHourly,
  WeatherPayload,
} from '../../src/domain/forecast/types.js';

/** Local wall-clock timestamps for whole days, exactly as Open-Meteo formats them. */
export function hourlyTimes(startDate: string, days: number): string[] {
  const times: string[] = [];
  for (const date of dateRange(startDate, days)) {
    for (let hour = 0; hour < 24; hour += 1) {
      times.push(`${date}T${String(hour).padStart(2, '0')}:00`);
    }
  }
  return times;
}

type HourlyValue = (time: string, index: number) => number | null;

function fill(times: readonly string[], value: number | null | HourlyValue): Series {
  return times.map((time, index) => (typeof value === 'function' ? value(time, index) : value));
}

export interface WeatherOptions {
  readonly startDate: string;
  readonly days: number;
  readonly timezone?: string;
  /** Per-series overrides; anything omitted is a constant, benign value. */
  readonly hourly?: Partial<Record<keyof Omit<WeatherHourly, 'time'>, number | null | HourlyValue>>;
  readonly daily?: Partial<Record<keyof Omit<WeatherDaily, 'time' | 'sunrise' | 'sunset'>, number | null>>;
}

export function makeWeather(options: WeatherOptions): WeatherPayload {
  const times = hourlyTimes(options.startDate, options.days);
  const dates = dateRange(options.startDate, options.days);
  const hourly = options.hourly ?? {};
  const daily = options.daily ?? {};

  // `=== undefined` and not `??`: a test overriding a series with null means "the model
  // reported nothing here", which is exactly the case worth exercising.
  const series = (
    key: keyof Omit<WeatherHourly, 'time'>,
    fallback: number | null | HourlyValue,
  ): Series => {
    const override = hourly[key];
    return fill(times, override === undefined ? fallback : override);
  };

  const dailySeries = (
    key: keyof Omit<WeatherDaily, 'time' | 'sunrise' | 'sunset'>,
    fallback: number | null,
  ): Series => {
    const override = daily[key];
    return dates.map(() => (override === undefined ? fallback : override));
  };

  return {
    latitude: 0,
    longitude: 0,
    elevation: 0,
    timezone: options.timezone ?? 'UTC',
    hourly: {
      time: times,
      temperature_2m: series('temperature_2m', 10),
      apparent_temperature: series('apparent_temperature', 10),
      precipitation: series('precipitation', 0),
      precipitation_probability: series('precipitation_probability', 0),
      snowfall: series('snowfall', 0),
      snow_depth: series('snow_depth', 0),
      weather_code: series('weather_code', 0),
      cloud_cover: series('cloud_cover', 0),
      visibility: series('visibility', 20000),
      wind_speed_10m: series('wind_speed_10m', 5),
      wind_gusts_10m: series('wind_gusts_10m', 10),
      // Daylight 06:00–18:00 unless a test says otherwise.
      is_day: series('is_day', (time) => (Number(time.slice(11, 13)) >= 6 && Number(time.slice(11, 13)) < 18 ? 1 : 0)),
    },
    daily: {
      time: dates,
      sunrise: dates.map((date) => `${date}T06:00`),
      sunset: dates.map((date) => `${date}T18:00`),
      sunshine_duration: dailySeries('sunshine_duration', 30000),
      daylight_duration: dailySeries('daylight_duration', 43200),
      uv_index_max: dailySeries('uv_index_max', 5),
      weather_code: dailySeries('weather_code', 0),
      temperature_2m_max: dailySeries('temperature_2m_max', 15),
      temperature_2m_min: dailySeries('temperature_2m_min', 5),
      apparent_temperature_max: dailySeries('apparent_temperature_max', 15),
      apparent_temperature_min: dailySeries('apparent_temperature_min', 5),
      precipitation_sum: dailySeries('precipitation_sum', 0),
      rain_sum: dailySeries('rain_sum', 0),
      snowfall_sum: dailySeries('snowfall_sum', 0),
      precipitation_hours: dailySeries('precipitation_hours', 0),
      precipitation_probability_max: dailySeries('precipitation_probability_max', 0),
      wind_speed_10m_max: dailySeries('wind_speed_10m_max', 10),
      wind_gusts_10m_max: dailySeries('wind_gusts_10m_max', 15),
      cloud_cover_mean: dailySeries('cloud_cover_mean', 0),
    },
  };
}

export interface MarineOptions {
  readonly startDate: string;
  readonly days: number;
  readonly hourly?: Partial<Record<keyof Omit<MarineHourly, 'time'>, number | null | HourlyValue>>;
}

export function makeMarine(options: MarineOptions): MarinePayload {
  const times = hourlyTimes(options.startDate, options.days);
  const dates = dateRange(options.startDate, options.days);
  const hourly = options.hourly ?? {};

  const series = (
    key: keyof Omit<MarineHourly, 'time'>,
    fallback: number | null | HourlyValue,
  ): Series => {
    const override = hourly[key];
    return fill(times, override === undefined ? fallback : override);
  };

  return {
    latitude: 0,
    longitude: 0,
    timezone: 'UTC',
    hourly: {
      time: times,
      wave_height: series('wave_height', 1),
      wave_direction: series('wave_direction', 270),
      wave_period: series('wave_period', 9),
      wind_wave_height: series('wind_wave_height', 0.3),
      wind_wave_period: series('wind_wave_period', 5),
      swell_wave_height: series('swell_wave_height', 0.9),
      swell_wave_period: series('swell_wave_period', 11),
      swell_wave_direction: series('swell_wave_direction', 280),
      sea_surface_temperature: series('sea_surface_temperature', 18),
    },
    daily: {
      time: dates,
      wave_height_max: dates.map(() => 1.4),
      wave_period_max: dates.map(() => 11),
      swell_wave_height_max: dates.map(() => 1.1),
      swell_wave_period_max: dates.map(() => 12),
    },
  };
}

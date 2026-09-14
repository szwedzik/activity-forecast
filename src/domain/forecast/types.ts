/**
 * Shapes the domain works with. The payload types mirror what Open-Meteo returns
 * (D§2.2, D§2.3); phase 2's zod schemas must produce values assignable to these.
 *
 * Every series element is `number | null`: any model can leave a gap, and pretending
 * otherwise would push the check into every call site (D§2.2).
 */

export type Activity = 'SKIING' | 'SURFING' | 'OUTDOOR_SIGHTSEEING' | 'INDOOR_SIGHTSEEING';

export const ACTIVITIES: readonly Activity[] = [
  'SKIING',
  'SURFING',
  'OUTDOOR_SIGHTSEEING',
  'INDOOR_SIGHTSEEING',
];

/** One Open-Meteo series. `null` means the model had no value for that hour or day. */
export type Series = readonly (number | null)[];

export interface WeatherHourly {
  readonly time: readonly string[];
  readonly temperature_2m: Series;
  readonly apparent_temperature: Series;
  readonly precipitation: Series;
  readonly precipitation_probability: Series;
  readonly snowfall: Series;
  readonly snow_depth: Series;
  readonly weather_code: Series;
  readonly cloud_cover: Series;
  readonly visibility: Series;
  readonly wind_speed_10m: Series;
  readonly wind_gusts_10m: Series;
  readonly is_day: Series;
}

export interface WeatherDaily {
  readonly time: readonly string[];
  readonly sunrise: readonly string[];
  readonly sunset: readonly string[];
  readonly sunshine_duration: Series;
  readonly daylight_duration: Series;
  readonly uv_index_max: Series;
  readonly weather_code: Series;
  readonly temperature_2m_max: Series;
  readonly temperature_2m_min: Series;
  readonly apparent_temperature_max: Series;
  readonly apparent_temperature_min: Series;
  readonly precipitation_sum: Series;
  readonly rain_sum: Series;
  readonly snowfall_sum: Series;
  readonly precipitation_hours: Series;
  readonly precipitation_probability_max: Series;
  readonly wind_speed_10m_max: Series;
  readonly wind_gusts_10m_max: Series;
  readonly cloud_cover_mean: Series;
}

export interface WeatherPayload {
  /** The grid cell the model actually used, not what we asked for (D§2.2). */
  readonly latitude: number;
  readonly longitude: number;
  readonly elevation?: number | null;
  readonly timezone: string;
  readonly hourly: WeatherHourly;
  readonly daily: WeatherDaily;
}

export interface MarineHourly {
  readonly time: readonly string[];
  readonly wave_height: Series;
  readonly wave_direction: Series;
  readonly wave_period: Series;
  readonly wind_wave_height: Series;
  readonly wind_wave_period: Series;
  readonly swell_wave_height: Series;
  readonly swell_wave_period: Series;
  readonly swell_wave_direction: Series;
  readonly sea_surface_temperature: Series;
}

export interface MarineDaily {
  readonly time: readonly string[];
  readonly wave_height_max: Series;
  readonly wave_period_max: Series;
  readonly swell_wave_height_max: Series;
  readonly swell_wave_period_max: Series;
}

export interface MarinePayload {
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  readonly hourly: MarineHourly;
  readonly daily: MarineDaily;
}

/**
 * What the domain is handed. `marine` is absent inland, where Open-Meteo returns a
 *200 with every value null and there is nothing to score surfing on (D§2.3).
 */
export interface ForecastData {
  readonly weather: WeatherPayload;
  readonly marine?: MarinePayload | undefined;
}

/**
 * Hours of the day an activity is judged on (D§7.1). `hours` is half-open, so
 * 09:00–16:00 is the seven rows 09 through 15, each covering the hour it starts.
 */
export type Window =
  | { readonly kind: 'hours'; readonly fromHour: number; readonly toHour: number }
  | { readonly kind: 'daylight'; readonly fallbackFromHour: number; readonly fallbackToHour: number };

/**
 * One local day, aggregated over an activity's window. A field is `undefined` only
 * when every input for it was null; aggregation otherwise skips the gaps (D§7.1).
 */
export interface DayFeatures {
  /** Local calendar date, YYYY-MM-DD. */
  readonly date: string;
  /** Hourly rows the aggregates were taken from; 0 means the day is unusable. */
  readonly hoursInWindow: number;

  readonly tempMeanC?: number;
  readonly apparentMeanC?: number;
  readonly apparentMaxC?: number;

  readonly precipMm?: number;
  /** Hours in the window with at least 0.1 mm. */
  readonly precipHours?: number;
  /** Liquid only: hourly `rain` excludes showers, so it is derived (D§2.2). */
  readonly rainMm?: number;
  readonly snowfallCm?: number;
  /** Whole-day `snowfall_sum`, not just the window. */
  readonly snowfallDayCm?: number;
  readonly precipProbMean?: number;
  readonly precipProbMax?: number;

  readonly cloudMeanPct?: number;
  /** Whole-day sunshine_duration / daylight_duration, 0–1. */
  readonly sunshineFraction?: number;

  readonly windMeanKmh?: number;
  readonly windMaxKmh?: number;
  readonly gustMaxKmh?: number;
  readonly visibilityMinM?: number;
  readonly snowDepthMaxM?: number;

  /** Distinct WMO codes seen in the window, ascending. */
  readonly weatherCodes: readonly number[];
  readonly worstWeatherCode?: number;

  readonly waveHeightMeanM?: number;
  readonly waveHeightMaxM?: number;
  readonly swellPeriodMeanS?: number;
  readonly wavePeriodMeanS?: number;
  readonly windWaveHeightMeanM?: number;
  readonly seaSurfaceTempC?: number;
}

/**
 * Plain weather for a day, independent of any activity: the `days` field of the API.
 * Numbers stay optional because any of them can be null upstream; the resolver decides
 * what to do with a gap.
 */
export interface DaySummary {
  readonly date: string;
  readonly weatherCode?: number;
  readonly summary: string;
  readonly tempMaxC?: number;
  readonly tempMinC?: number;
  readonly precipitationMm?: number;
  readonly precipitationProbabilityMax?: number;
  readonly snowfallCm?: number;
  readonly windMaxKmh?: number;
  readonly sunshineHours?: number;
  readonly waveHeightMaxM?: number;
}

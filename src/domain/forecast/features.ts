/**
 * Turns Open-Meteo payloads into one `DayFeatures` per day, aggregated over the window
 * the activity is judged on (D§7.1), plus a plain `DaySummary` per day for the API.
 *
 * Pure: the caller says which local date is "today". Marine rows are matched to weather
 * rows by their `time` string and never by index, because the two snapshots are fetched
 * on different schedules and can start on different days (D§2.3).
 */
import { dateOf, dateRange, hourOf } from './localDate.js';
import type {
  DayFeatures,
  DaySummary,
  ForecastData,
  MarinePayload,
  Series,
  WeatherPayload,
  Window,
} from './types.js';
import { describeWeatherCode, worstWeatherCode } from './weatherCodes.js';

/** Today plus the following six (Q1). */
export const RANKED_DAYS = 7;

/**
 * Centimetres of snow per millimetre of water (D§2.2 as corrected, D-029).
 *
 * The units are the whole point: Open-Meteo reports snowfall in cm and precipitation in
 * mm, so 7:1 in matching units is 0.7 here. Measured against the live API at -20 °C,
 * where nothing can be falling as rain, 0.1 mm of precipitation comes back as 0.07 cm.
 */
const SNOW_CM_PER_WATER_MM = 0.7;
/** Below this an hour is not meaningfully wet. */
const WET_HOUR_MM = 0.1;

function value(series: Series, index: number): number | undefined {
  const raw = series[index];
  return raw === null || raw === undefined ? undefined : raw;
}

function collect(series: Series, indices: readonly number[]): number[] {
  const values: number[] = [];
  for (const index of indices) {
    const one = value(series, index);
    if (one !== undefined) values.push(one);
  }
  return values;
}

/** Three decimals is far below anything a score can notice, and keeps float noise out of tests. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return round(values.reduce((total, one) => total + one, 0) / values.length);
}

function sum(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return round(values.reduce((total, one) => total + one, 0));
}

function maximum(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : round(Math.max(...values));
}

function minimum(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : round(Math.min(...values));
}

function indexByFirstOccurrence(times: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < times.length; i += 1) {
    const time = times[i];
    if (time !== undefined && !index.has(time)) index.set(time, i);
  }
  return index;
}

function inHours(hour: number, from: number, to: number): boolean {
  return hour >= from && hour < to;
}

/**
 * Rows of the weather series that belong to `date` and fall inside the window.
 * Daylight windows read `is_day`; if the model reports no daylight at all — polar
 * winter, or a missing series — they fall back to fixed hours (D§7.1).
 */
function selectHours(weather: WeatherPayload, date: string, window: Window): number[] {
  const { time, is_day: isDay } = weather.hourly;
  const onDate: number[] = [];
  for (let i = 0; i < time.length; i += 1) {
    const stamp = time[i];
    if (stamp !== undefined && dateOf(stamp) === date) onDate.push(i);
  }

  if (window.kind === 'hours') {
    return onDate.filter((i) => {
      const stamp = time[i];
      return stamp !== undefined && inHours(hourOf(stamp), window.fromHour, window.toHour);
    });
  }

  const daylight = onDate.filter((i) => value(isDay, i) === 1);
  if (daylight.length > 0) return daylight;
  return onDate.filter((i) => {
    const stamp = time[i];
    return (
      stamp !== undefined && inHours(hourOf(stamp), window.fallbackFromHour, window.fallbackToHour)
    );
  });
}

/** Liquid water only: the hourly `rain` series excludes showers, so it is derived (D§2.2). */
function liquidRain(weather: WeatherPayload, indices: readonly number[]): number | undefined {
  const { precipitation, snowfall } = weather.hourly;
  const hourly: number[] = [];
  for (const index of indices) {
    const total = value(precipitation, index);
    if (total === undefined) continue;
    const snow = value(snowfall, index) ?? 0;
    hourly.push(Math.max(0, total - snow / SNOW_CM_PER_WATER_MM));
  }
  return sum(hourly);
}

function wetHours(weather: WeatherPayload, indices: readonly number[]): number | undefined {
  const measured = collect(weather.hourly.precipitation, indices);
  if (measured.length === 0) return undefined;
  return measured.filter((mm) => mm >= WET_HOUR_MM).length;
}

function marineFeatures(
  marine: MarinePayload | undefined,
  times: readonly string[],
): Pick<
  DayFeatures,
  | 'waveHeightMeanM'
  | 'waveHeightMaxM'
  | 'swellPeriodMeanS'
  | 'wavePeriodMeanS'
  | 'windWaveHeightMeanM'
  | 'seaSurfaceTempC'
> {
  if (!marine) return {};
  const byTime = indexByFirstOccurrence(marine.hourly.time);
  const indices: number[] = [];
  for (const time of times) {
    const index = byTime.get(time);
    if (index !== undefined) indices.push(index);
  }
  if (indices.length === 0) return {};

  const heights = collect(marine.hourly.wave_height, indices);
  return {
    waveHeightMeanM: mean(heights),
    waveHeightMaxM: maximum(heights),
    swellPeriodMeanS: mean(collect(marine.hourly.swell_wave_period, indices)),
    wavePeriodMeanS: mean(collect(marine.hourly.wave_period, indices)),
    windWaveHeightMeanM: mean(collect(marine.hourly.wind_wave_height, indices)),
    seaSurfaceTempC: mean(collect(marine.hourly.sea_surface_temperature, indices)),
  };
}

function sunshineFraction(daily: WeatherPayload['daily'], index: number): number | undefined {
  const sunshine = value(daily.sunshine_duration, index);
  const daylight = value(daily.daylight_duration, index);
  if (sunshine === undefined || daylight === undefined || daylight <= 0) return undefined;
  return round(sunshine / daylight);
}

function featuresForDate(data: ForecastData, date: string, window: Window): DayFeatures {
  const { weather } = data;
  const indices = selectHours(weather, date, window);
  const times = indices
    .map((index) => weather.hourly.time[index])
    .filter((time): time is string => time !== undefined);

  const dailyIndex = weather.daily.time.indexOf(date);
  const codes = [...new Set(collect(weather.hourly.weather_code, indices))].sort((a, b) => a - b);

  return {
    date,
    hoursInWindow: indices.length,

    tempMeanC: mean(collect(weather.hourly.temperature_2m, indices)),
    apparentMeanC: mean(collect(weather.hourly.apparent_temperature, indices)),
    apparentMaxC: maximum(collect(weather.hourly.apparent_temperature, indices)),

    precipMm: sum(collect(weather.hourly.precipitation, indices)),
    precipHours: wetHours(weather, indices),
    rainMm: liquidRain(weather, indices),
    snowfallCm: sum(collect(weather.hourly.snowfall, indices)),
    snowfallDayCm: dailyIndex < 0 ? undefined : value(weather.daily.snowfall_sum, dailyIndex),
    precipProbMean: mean(collect(weather.hourly.precipitation_probability, indices)),
    precipProbMax: maximum(collect(weather.hourly.precipitation_probability, indices)),

    cloudMeanPct: mean(collect(weather.hourly.cloud_cover, indices)),
    sunshineFraction: dailyIndex < 0 ? undefined : sunshineFraction(weather.daily, dailyIndex),

    windMeanKmh: mean(collect(weather.hourly.wind_speed_10m, indices)),
    windMaxKmh: maximum(collect(weather.hourly.wind_speed_10m, indices)),
    gustMaxKmh: maximum(collect(weather.hourly.wind_gusts_10m, indices)),
    visibilityMinM: minimum(collect(weather.hourly.visibility, indices)),
    snowDepthMaxM: maximum(collect(weather.hourly.snow_depth, indices)),

    weatherCodes: codes,
    worstWeatherCode: worstWeatherCode(codes),

    ...marineFeatures(data.marine, times),
  };
}

/** Seven days starting at `todayLocal`, aggregated over `window`. */
export function extractDayFeatures(
  data: ForecastData,
  todayLocal: string,
  window: Window,
  days: number = RANKED_DAYS,
): DayFeatures[] {
  return dateRange(todayLocal, days).map((date) => featuresForDate(data, date, window));
}

/** Seven days of plain weather, chronological, for the `days` field of the API. */
export function summariseDays(
  data: ForecastData,
  todayLocal: string,
  days: number = RANKED_DAYS,
): DaySummary[] {
  const { daily } = data.weather;
  const marineDaily = data.marine?.daily;

  return dateRange(todayLocal, days).map((date) => {
    const index = daily.time.indexOf(date);
    const marineIndex = marineDaily ? marineDaily.time.indexOf(date) : -1;
    if (index < 0) return { date, summary: describeWeatherCode(undefined) };

    const sunshineSeconds = value(daily.sunshine_duration, index);
    const code = value(daily.weather_code, index);

    return {
      date,
      weatherCode: code,
      summary: describeWeatherCode(code),
      tempMaxC: value(daily.temperature_2m_max, index),
      tempMinC: value(daily.temperature_2m_min, index),
      precipitationMm: value(daily.precipitation_sum, index),
      precipitationProbabilityMax: value(daily.precipitation_probability_max, index),
      snowfallCm: value(daily.snowfall_sum, index),
      windMaxKmh: value(daily.wind_speed_10m_max, index),
      sunshineHours: sunshineSeconds === undefined ? undefined : round(sunshineSeconds / 3600),
      waveHeightMaxM:
        marineDaily && marineIndex >= 0 ? value(marineDaily.wave_height_max, marineIndex) : undefined,
    };
  });
}

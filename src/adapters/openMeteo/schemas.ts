/**
 * zod schemas for the three Open-Meteo responses (D§2).
 *
 * Every series is `(number | null)[]`, because any model can leave a gap and a schema
 * that refused nulls would turn a missing hour into a failed request. Objects are loose,
 * so a variable Open-Meteo adds later survives parsing instead of being dropped on the
 * way to storage.
 */
import { z } from 'zod';

import type { MarinePayload, WeatherPayload } from '../../domain/forecast/types.js';
import { UpstreamError } from './http.js';

const series = z.array(z.number().nullable());
const timestamps = z.array(z.string());

/**
 * A payload can lose rows rather than keys: empty series, or a `time` array that no
 * longer lines up with the values beside it. Nothing downstream would notice — it would
 * score as a run of days with no weather — so it is caught here, while it is still
 * recognisably an upstream problem.
 */
function wellFormed<Shape extends Record<string, unknown>>(
  block: z.ZodType<Shape>,
  label: string,
): z.ZodType<Shape> {
  return block.refine(
    (value) => {
      const time = (value as Record<string, unknown>)['time'];
      if (!Array.isArray(time) || time.length === 0) return false;
      return Object.entries(value as Record<string, unknown>).every(
        ([key, entry]) => key === 'time' || !Array.isArray(entry) || entry.length === time.length,
      );
    },
    { message: `${label} is empty, or its series do not line up with time` },
  );
}

export const geocodingResultSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
  elevation: z.number().nullable().optional(),
  feature_code: z.string().optional(),
  country_code: z.string().optional(),
  country: z.string().optional(),
  admin1: z.string().optional(),
  population: z.number().optional(),
});

/** `results` is absent, not empty, when nothing matches (D§2.1). */
export const geocodingResponseSchema = z.looseObject({
  results: z.array(geocodingResultSchema).optional(),
});

const weatherHourly = wellFormed(
  z.looseObject({
    time: timestamps,
    temperature_2m: series,
    apparent_temperature: series,
    precipitation: series,
    precipitation_probability: series,
    snowfall: series,
    snow_depth: series,
    weather_code: series,
    cloud_cover: series,
    visibility: series,
    wind_speed_10m: series,
    wind_gusts_10m: series,
    is_day: series,
  }),
  'hourly',
);

const weatherDaily = wellFormed(
  z.looseObject({
    time: timestamps,
    sunrise: timestamps,
    sunset: timestamps,
    sunshine_duration: series,
    daylight_duration: series,
    uv_index_max: series,
    weather_code: series,
    temperature_2m_max: series,
    temperature_2m_min: series,
    apparent_temperature_max: series,
    apparent_temperature_min: series,
    precipitation_sum: series,
    rain_sum: series,
    snowfall_sum: series,
    precipitation_hours: series,
    precipitation_probability_max: series,
    wind_speed_10m_max: series,
    wind_gusts_10m_max: series,
    cloud_cover_mean: series,
  }),
  'daily',
);

export const weatherResponseSchema = z.looseObject({
  latitude: z.number(),
  longitude: z.number(),
  elevation: z.number().nullable().optional(),
  timezone: z.string(),
  hourly: weatherHourly,
  daily: weatherDaily,
});

const marineHourly = wellFormed(
  z.looseObject({
    time: timestamps,
    wave_height: series,
    wave_direction: series,
    wave_period: series,
    wind_wave_height: series,
    wind_wave_period: series,
    swell_wave_height: series,
    swell_wave_period: series,
    swell_wave_direction: series,
    sea_surface_temperature: series,
  }),
  'marine hourly',
);

const marineDaily = wellFormed(
  z.looseObject({
    time: timestamps,
    wave_height_max: series,
    wave_period_max: series,
    swell_wave_height_max: series,
    swell_wave_period_max: series,
  }),
  'marine daily',
);

export const marineResponseSchema = z.looseObject({
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
  hourly: marineHourly,
  daily: marineDaily,
});

export type GeocodingResult = z.infer<typeof geocodingResultSchema>;

// The domain, not zod, owns the shape the rest of the service works with. These lines
// fail the build if a schema ever stops producing something the domain can use.
const _weatherMatchesDomain: WeatherPayload = {} as z.infer<typeof weatherResponseSchema>;
const _marineMatchesDomain: MarinePayload = {} as z.infer<typeof marineResponseSchema>;
void _weatherMatchesDomain;
void _marineMatchesDomain;

/**
 * Parse an upstream body, or fail the way every other upstream problem fails. A schema
 * mismatch means Open-Meteo changed under us, which retrying cannot fix; the first issue
 * goes in the message so whoever logs the error can see what moved.
 */
export function parseUpstream<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
  const detail = issue ? `${where}: ${issue.message}` : 'no issues reported';
  throw new UpstreamError(`unexpected ${what} response from Open-Meteo — ${detail}`, {
    retryable: false,
    cause: result.error,
  });
}

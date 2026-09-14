/**
 * Every knob the service has, read from the environment once and validated (D§9).
 *
 * There is no dotenv: `npm start` hands the file to Node itself through
 * `--env-file-if-exists`, so there is one fewer dependency and one fewer way for the
 * process to disagree with its own configuration (D-012).
 */
import { z } from 'zod';

/** A count of hours, as a positive number. The unit is in the name of the variable. */
const hours = (fallback: number) => z.coerce.number().positive().default(fallback);
const minutes = (fallback: number) => z.coerce.number().positive().default(fallback);

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DB_PATH: z.string().min(1).default('./data/app.db'),

  OPEN_METEO_GEOCODING_URL: z.url().default('https://geocoding-api.open-meteo.com/v1/search'),
  OPEN_METEO_FORECAST_URL: z.url().default('https://api.open-meteo.com/v1/forecast'),
  OPEN_METEO_MARINE_URL: z.url().default('https://marine-api.open-meteo.com/v1/marine'),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  WEATHER_TTL_HOURS: hours(3),
  MARINE_TTL_HOURS: hours(6),
  MARINE_UNAVAILABLE_TTL_HOURS: hours(168),
  MAX_STALE_HOURS: hours(24),

  GEOCODE_TTL_DAYS: z.coerce.number().positive().default(30),
  GEOCODE_MISS_TTL_HOURS: hours(24),

  // Off in tests, so a suite never schedules work it did not ask for (D§6.3).
  REFRESH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  REFRESH_INTERVAL_MINUTES: minutes(10),
  REFRESH_ACTIVE_WINDOW_HOURS: hours(24),

  SNAPSHOT_RETENTION_HOURS: hours(48),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface Config {
  readonly port: number;
  readonly dbPath: string;
  readonly openMeteo: {
    readonly geocodingUrl: string;
    readonly forecastUrl: string;
    readonly marineUrl: string;
    readonly timeoutMs: number;
  };
  /** Milliseconds throughout, because that is what the policies compare against. */
  readonly weather: { readonly ttlMs: number; readonly maxStaleMs: number };
  readonly marine: {
    readonly ttlMs: number;
    readonly maxStaleMs: number;
    readonly unavailableTtlMs: number;
  };
  readonly geocode: { readonly hitTtlMs: number; readonly missTtlMs: number };
  readonly refresh: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly activeWindowMs: number;
  };
  readonly snapshotRetentionMs: number;
  readonly logLevel: string;
}

/**
 * Read and check the environment. Anything wrong stops the process here with a message
 * naming the variable, rather than surfacing much later as a strange TTL.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — ${detail}`);
  }

  const value = parsed.data;

  return {
    port: value.PORT,
    dbPath: value.DB_PATH,
    openMeteo: {
      geocodingUrl: value.OPEN_METEO_GEOCODING_URL,
      forecastUrl: value.OPEN_METEO_FORECAST_URL,
      marineUrl: value.OPEN_METEO_MARINE_URL,
      timeoutMs: value.HTTP_TIMEOUT_MS,
    },
    weather: {
      ttlMs: value.WEATHER_TTL_HOURS * HOUR_MS,
      maxStaleMs: value.MAX_STALE_HOURS * HOUR_MS,
    },
    marine: {
      ttlMs: value.MARINE_TTL_HOURS * HOUR_MS,
      maxStaleMs: value.MAX_STALE_HOURS * HOUR_MS,
      unavailableTtlMs: value.MARINE_UNAVAILABLE_TTL_HOURS * HOUR_MS,
    },
    geocode: {
      hitTtlMs: value.GEOCODE_TTL_DAYS * DAY_MS,
      missTtlMs: value.GEOCODE_MISS_TTL_HOURS * HOUR_MS,
    },
    refresh: {
      enabled: value.REFRESH_ENABLED,
      intervalMs: value.REFRESH_INTERVAL_MINUTES * 60_000,
      activeWindowMs: value.REFRESH_ACTIVE_WINDOW_HOURS * HOUR_MS,
    },
    snapshotRetentionMs: value.SNAPSHOT_RETENTION_HOURS * HOUR_MS,
    logLevel: value.LOG_LEVEL,
  };
}

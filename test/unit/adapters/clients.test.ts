import { describe, expect, it } from 'vitest';

import {
  buildForecastUrl,
  createForecastClient,
  FORECAST_DAYS,
} from '../../../src/adapters/openMeteo/forecastClient.js';
import {
  buildGeocodingUrl,
  createGeocodingClient,
} from '../../../src/adapters/openMeteo/geocodingClient.js';
import { UpstreamError } from '../../../src/adapters/openMeteo/http.js';
import {
  buildMarineUrl,
  createMarineClient,
  hasNoWaveData,
} from '../../../src/adapters/openMeteo/marineClient.js';
import { extractDayFeatures } from '../../../src/domain/forecast/features.js';
import { fakeFetch, noSleep, ok, status } from '../../helpers/fakeFetch.js';
import { FIXTURE_TODAY, loadGeocoding, loadMarine, loadWeather } from '../../helpers/fixtures.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

const CITIES = ['chamonix', 'lisbon', 'denver'] as const;

/** A mutable copy of a fixture, for the cases that need a payload bent out of shape. */
const mutableCopy = (value: unknown): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>;

const wire = (url: string, replies: Parameters<typeof fakeFetch>[0]) => {
  const http = fakeFetch(replies);
  return { http, options: { url, fetch: http.fetch, timeoutMs: 5000, sleep: noSleep } };
};

describe('the geocoding client', () => {
  it('parses every captured search, ambiguous ones included', async () => {
    for (const name of [...CITIES, 'springfield']) {
      const { options } = wire(GEOCODING_URL, [ok(loadGeocoding(name))]);
      const results = await createGeocodingClient(options).search(name);

      expect(results.length, name).toBeGreaterThan(0);
      expect(results[0]?.timezone, name).toBeTruthy();
    }
  });

  it('returns an empty list when nothing matched, where the key is absent entirely', async () => {
    const { options } = wire(GEOCODING_URL, [ok(loadGeocoding('nomatch'))]);

    await expect(createGeocodingClient(options).search('zzqqxwv')).resolves.toEqual([]);
  });

  it('keeps the geocoder order, so the most prominent place comes first', async () => {
    const { options } = wire(GEOCODING_URL, [ok(loadGeocoding('springfield'))]);
    const results = await createGeocodingClient(options).search('Springfield');

    expect(results[0]?.admin1).toBe('Missouri');
    expect(results.length).toBeGreaterThan(5);
  });

  it('puts the country code in the query, uppercased', () => {
    const url = buildGeocodingUrl(GEOCODING_URL, 'Springfield', { countryCode: 'us', count: 3 });

    expect(url).toContain('countryCode=US');
    expect(url).toContain('count=3');
    expect(url).toContain('language=en');
    expect(url).toContain('format=json');
  });

  it('passes the place name through trimmed and otherwise untouched', () => {
    expect(buildGeocodingUrl(GEOCODING_URL, '  Chamonix-Mont-Blanc  ')).toContain(
      'name=Chamonix-Mont-Blanc',
    );
  });

  it('actually sends the country code', async () => {
    const { http, options } = wire(GEOCODING_URL, [ok({ results: [] })]);
    await createGeocodingClient(options).search('Springfield', { countryCode: 'US' });

    expect(http.calls[0]?.url).toContain('countryCode=US');
  });
});

describe('the forecast client', () => {
  it('parses every captured forecast', async () => {
    for (const city of CITIES) {
      const { options } = wire(FORECAST_URL, [ok(loadWeather(city))]);
      const payload = await createForecastClient(options).fetchForecast(45, 6, 'Europe/Paris');

      expect(payload.hourly.time.length, city).toBe(192);
      expect(payload.daily.time.length, city).toBe(8);
    }
  });

  it('produces something the domain can score directly', async () => {
    const { options } = wire(FORECAST_URL, [ok(loadWeather('lisbon'))]);
    const payload = await createForecastClient(options).fetchForecast(38.7, -9.1, 'Europe/Lisbon');

    const days = extractDayFeatures({ weather: payload }, FIXTURE_TODAY, {
      kind: 'hours',
      fromHour: 9,
      toHour: 18,
    });

    expect(days).toHaveLength(7);
    expect(days[0]?.tempMeanC).toBeGreaterThan(0);
  });

  it('asks for the town timezone rather than auto, and for eight days', () => {
    const url = buildForecastUrl(FORECAST_URL, 38.72509, -9.1498, 'Europe/Lisbon');

    expect(url).toContain('timezone=Europe%2FLisbon');
    expect(url).not.toContain('auto');
    expect(url).toContain(`forecast_days=${FORECAST_DAYS}`);
    expect(url).toContain('latitude=38.72509');
    expect(url).toContain('longitude=-9.1498');
  });

  it('asks for exactly the D2.2 variable lists, no more and no less', () => {
    // Literal lists on purpose: comparing the URL back to the constants that built it
    // would pass however wrong both were.
    const query = new URL(buildForecastUrl(FORECAST_URL, 0, 0, 'UTC')).searchParams;

    expect(query.get('hourly')).toBe(
      'temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,snow_depth,weather_code,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,is_day',
    );
    expect(query.get('daily')).toBe(
      'sunrise,sunset,sunshine_duration,daylight_duration,uv_index_max,weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,cloud_cover_mean',
    );
  });

  it('rejects a payload missing a series it needs, rather than scoring a hole', async () => {
    const broken = mutableCopy(loadWeather('lisbon'));
    delete (broken['hourly'] as Record<string, unknown>)['visibility'];
    const { options } = wire(FORECAST_URL, [ok(broken)]);

    const error = await createForecastClient(options)
      .fetchForecast(0, 0, 'UTC')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).toContain('hourly.visibility');
  });

  it('rejects a payload that kept its keys but lost its rows', async () => {
    // An empty series is not bad weather, it is a broken answer. Left alone it would be
    // stored and scored as seven days of nothing.
    const emptied = mutableCopy(loadWeather('lisbon'));
    const hourly = emptied['hourly'] as Record<string, unknown[]>;
    for (const key of Object.keys(hourly)) hourly[key] = [];
    const { options } = wire(FORECAST_URL, [ok(emptied)]);

    await expect(createForecastClient(options).fetchForecast(0, 0, 'UTC')).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('rejects a payload whose series no longer line up with its timestamps', async () => {
    const truncated = mutableCopy(loadWeather('lisbon'));
    const hourly = truncated['hourly'] as Record<string, unknown[]>;
    hourly['time'] = (hourly['time'] ?? []).slice(0, 3);
    const { options } = wire(FORECAST_URL, [ok(truncated)]);

    await expect(createForecastClient(options).fetchForecast(0, 0, 'UTC')).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('keeps a variable Open-Meteo adds that we did not ask about', async () => {
    const extended = mutableCopy(loadWeather('lisbon'));
    extended['some_new_field'] = 42;
    const { options } = wire(FORECAST_URL, [ok(extended)]);

    const payload: unknown = await createForecastClient(options).fetchForecast(0, 0, 'UTC');

    expect((payload as Record<string, unknown>)['some_new_field']).toBe(42);
  });
});

describe('the marine client', () => {
  it('parses every captured marine payload, the all-null inland ones included', async () => {
    for (const city of CITIES) {
      const { options } = wire(MARINE_URL, [ok(loadMarine(city))]);
      const payload = await createMarineClient(options).fetchMarine(45, 6, 'Europe/Paris');

      expect(payload.hourly.wave_height.length, city).toBe(192);
    }
  });

  it('recognises an inland answer as having no wave data at all', async () => {
    const { options: inland } = wire(MARINE_URL, [ok(loadMarine('denver'))]);
    const { options: coastal } = wire(MARINE_URL, [ok(loadMarine('lisbon'))]);

    expect(hasNoWaveData(await createMarineClient(inland).fetchMarine(39, -104, 'America/Denver'))).toBe(
      true,
    );
    expect(
      hasNoWaveData(await createMarineClient(coastal).fetchMarine(38, -9, 'Europe/Lisbon')),
    ).toBe(false);
  });

  it('asks for exactly the D2.3 variable lists, no more and no less', () => {
    const query = new URL(buildMarineUrl(MARINE_URL, 38.7, -9.1, 'Europe/Lisbon')).searchParams;

    expect(query.get('hourly')).toBe(
      'wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_period,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature',
    );
    expect(query.get('daily')).toBe(
      'wave_height_max,wave_period_max,swell_wave_height_max,swell_wave_period_max',
    );
    expect(query.get('timezone')).toBe('Europe/Lisbon');
  });
});

describe('upstream failures reach the caller intact', () => {
  it('a 500 is retried once and then reported', async () => {
    const { http, options } = wire(FORECAST_URL, [status(500)]);

    await expect(
      createForecastClient(options).fetchForecast(0, 0, 'UTC'),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(http.calls).toHaveLength(2);
  });

  it('a 400 is reported straight away', async () => {
    const { http, options } = wire(GEOCODING_URL, [status(400)]);

    await expect(createGeocodingClient(options).search('x')).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(http.calls).toHaveLength(1);
  });
});

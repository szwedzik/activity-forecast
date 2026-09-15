/**
 * The API end to end, through `yoga.fetch` with an in-memory database and fake clients.
 * No port is opened and nothing can reach Open-Meteo, so this is the real request path
 * minus the two things a test has no business doing.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { App } from '../../src/app.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { fixedClock } from '../../src/services/clock.js';
import { loadMarine } from '../helpers/fixtures.js';
import type { FakeForecast, FakeGeocoding, FakeMarine, Store } from '../helpers/services.js';
import {
  DENVER,
  fakeForecast,
  fakeGeocoding,
  fakeMarine,
  geocodingResultFor,
  LISBON,
  openStore,
  T0,
} from '../helpers/services.js';

interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

describe('the GraphQL API', () => {
  let store: Store;
  let geocoding: FakeGeocoding;
  let forecast: FakeForecast;
  let marine: FakeMarine;
  let app: App;

  /** One request, exactly as a client would make it. */
  const ask = async (query: string, variables?: Record<string, unknown>): Promise<GraphQLResponse> => {
    const response = await app.yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as GraphQLResponse;
  };

  beforeEach(() => {
    store = openStore();
    geocoding = fakeGeocoding([geocodingResultFor(LISBON)]);
    forecast = fakeForecast();
    marine = fakeMarine();
    app = createApp({
      config: loadConfig({}),
      clock: fixedClock(T0),
      db: store.db,
      clients: { geocoding, forecast, marine },
    });
  });

  describe('activityRankings', () => {
    const FULL = /* GraphQL */ `
      query Rank($city: String!) {
        activityRankings(city: $city) {
          location {
            id
            name
            countryCode
            timezone
          }
          forecast {
            source
            weatherFetchedAt
            marineFetchedAt
            stale
            marineAvailable
            marineCellDistanceKm
            timezone
          }
          days {
            date
            summary
            tempMaxC
            waveHeightMaxM
          }
          rankings {
            activity
            applicable
            note
            days {
              date
              rank
              score
              suitability
              confidence
              factors {
                name
                kind
                value
                effect
                weight
              }
            }
          }
        }
      }
    `;

    it('answers the whole shape for a coastal town', async () => {
      const body = await ask(FULL, { city: 'Lisbon' });

      expect(body.errors).toBeUndefined();
      const result = body.data?.['activityRankings'] as Record<string, unknown>;
      const rankings = result['rankings'] as { activity: string; days: unknown[] }[];

      expect(rankings).toHaveLength(4);
      expect(rankings.map((one) => one.activity)).toEqual([
        'SKIING',
        'SURFING',
        'OUTDOOR_SIGHTSEEING',
        'INDOOR_SIGHTSEEING',
      ]);
      expect(result['days']).toHaveLength(7);
      for (const ranking of rankings) expect(ranking.days, ranking.activity).toHaveLength(7);
    });

    it('publishes the GeoNames id, not our row id', async () => {
      // Our primary key is 1; the identifier a client can use elsewhere is not (D-017).
      const body = await ask(FULL, { city: 'Lisbon' });
      const result = body.data?.['activityRankings'] as Record<string, unknown>;
      const location = result['location'] as { id: string; name: string };

      expect(location.id).toBe(String(LISBON.geonamesId));
      expect(location.id).not.toBe('1');
      expect(location.name).toBe('Lisbon');
    });

    it('ranks each activity one to seven, best first', async () => {
      const body = await ask(FULL, { city: 'Lisbon' });
      const result = body.data?.['activityRankings'] as Record<string, unknown>;
      const rankings = result['rankings'] as { activity: string; days: { rank: number; score: number }[] }[];

      for (const ranking of rankings) {
        expect(ranking.days.map((one) => one.rank).sort((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7,
        ]);
        const scores = ranking.days.map((one) => one.score);
        expect([...scores].sort((a, b) => b - a), ranking.activity).toEqual(scores);
      }
    });

    it('lists the weather days in date order', async () => {
      const body = await ask(FULL, { city: 'Lisbon' });
      const result = body.data?.['activityRankings'] as Record<string, unknown>;
      const days = result['days'] as { date: string }[];

      expect(days.map((one) => one.date)).toEqual([...days.map((one) => one.date)].sort());
      expect(days[0]?.date).toBe('2026-09-14');
    });

    it('reports where the data came from', async () => {
      const body = await ask(FULL, { city: 'Lisbon' });
      const result = body.data?.['activityRankings'] as Record<string, unknown>;

      expect(result['forecast']).toMatchObject({
        source: 'open-meteo',
        weatherFetchedAt: T0,
        stale: false,
        marineAvailable: true,
        timezone: 'Europe/Lisbon',
      });
    });

    it('says surfing is not applicable inland, and names the town', async () => {
      geocoding.results = [geocodingResultFor(DENVER)];
      marine.payload = loadMarine('denver');

      const body = await ask(FULL, { city: 'Denver' });
      const result = body.data?.['activityRankings'] as Record<string, unknown>;
      const rankings = result['rankings'] as {
        activity: string;
        applicable: boolean;
        note: string | null;
        days: { suitability: string; score: number }[];
      }[];
      const surfing = rankings.find((one) => one.activity === 'SURFING');

      expect(surfing?.applicable).toBe(false);
      expect(surfing?.note).toContain('near Denver');
      expect(surfing?.days.every((one) => one.suitability === 'NOT_APPLICABLE')).toBe(true);
      expect(surfing?.days.every((one) => one.score === 0)).toBe(true);
      expect((result['forecast'] as { marineAvailable: boolean }).marineAvailable).toBe(false);
    });

    it('returns only the activities asked for', async () => {
      const body = await ask(
        /* GraphQL */ `
          query {
            activityRankings(city: "Lisbon", activities: [SURFING, SKIING]) {
              rankings {
                activity
              }
            }
          }
        `,
      );
      const result = body.data?.['activityRankings'] as Record<string, unknown>;

      expect((result['rankings'] as { activity: string }[]).map((one) => one.activity)).toEqual([
        'SURFING',
        'SKIING',
      ]);
    });

    it('collapses a repeated activity rather than ranking it twice', async () => {
      const body = await ask(
        /* GraphQL */ `
          query {
            activityRankings(city: "Lisbon", activities: [SURFING, SURFING, SKIING]) {
              rankings {
                activity
              }
            }
          }
        `,
      );
      const result = body.data?.['activityRankings'] as Record<string, unknown>;

      expect((result['rankings'] as unknown[]).length).toBe(2);
    });

    it('serves a second identical request without calling upstream again', async () => {
      await ask(FULL, { city: 'Lisbon' });
      await ask(FULL, { city: 'Lisbon' });

      expect(geocoding.calls).toHaveLength(1);
      expect(forecast.calls).toHaveLength(1);
      expect(marine.calls).toHaveLength(1);
    });
  });

  describe('a missing measurement', () => {
    it('costs that value and nothing else', async () => {
      // The whole point of relaxing those six fields (D-022). With them non-null, one
      // null temperature would null every parent up the chain and take the rankings
      // with it, for a value nothing else depends on.
      const payload = structuredClone(forecast.payload) as unknown as {
        daily: { temperature_2m_max: (number | null)[]; weather_code: (number | null)[] };
      };
      payload.daily.temperature_2m_max[2] = null;
      payload.daily.weather_code[2] = null;
      forecast.payload = payload as unknown as typeof forecast.payload;

      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "Lisbon") {
            days {
              date
              tempMaxC
              weatherCode
              tempMinC
            }
            rankings {
              activity
              days {
                score
              }
            }
          }
        }
      `);

      expect(body.errors).toBeUndefined();
      const result = body.data?.['activityRankings'] as Record<string, unknown>;
      const days = result['days'] as { tempMaxC: number | null; weatherCode: number | null; tempMinC: number | null }[];

      expect(days[2]?.tempMaxC).toBeNull();
      expect(days[2]?.weatherCode).toBeNull();
      // Its neighbours, and the rest of that same day, are untouched.
      expect(days[2]?.tempMinC).toBeTypeOf('number');
      expect(days[1]?.tempMaxC).toBeTypeOf('number');
      expect((result['rankings'] as unknown[]).length).toBe(4);
    });
  });

  describe('searchLocations', () => {
    const SEARCH = /* GraphQL */ `
      query Search($query: String!, $countryCode: String, $limit: Int) {
        searchLocations(query: $query, countryCode: $countryCode, limit: $limit) {
          id
          name
          countryCode
          admin1
          timezone
        }
      }
    `;

    it('returns candidates in the geocoder order', async () => {
      geocoding.results = [geocodingResultFor(LISBON), geocodingResultFor(DENVER)];

      const body = await ask(SEARCH, { query: 'Springfield' });
      const found = body.data?.['searchLocations'] as { id: string; name: string }[];

      expect(found.map((one) => one.name)).toEqual(['Lisbon', 'Denver']);
      expect(found[0]?.id).toBe(String(LISBON.geonamesId));
    });

    it('passes the country code through and honours the limit', async () => {
      geocoding.results = [geocodingResultFor(LISBON), geocodingResultFor(DENVER)];

      const body = await ask(SEARCH, { query: 'Springfield', countryCode: 'us', limit: 1 });

      expect((body.data?.['searchLocations'] as unknown[]).length).toBe(1);
      expect(geocoding.calls[0]).toMatchObject({ countryCode: 'US', count: 1 });
    });

    it('does not keep anything warm, unlike asking for a forecast', async () => {
      await ask(SEARCH, { query: 'Lisbon' });

      expect(store.locations.recentlyRequested(T0)).toEqual([]);
    });
  });

  describe('errors carry a code a caller can act on', () => {
    const code = (body: GraphQLResponse): string | undefined => body.errors?.[0]?.extensions?.code;

    it('says LOCATION_NOT_FOUND when nothing matched', async () => {
      geocoding.results = [];

      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "zzqqxwv") {
            location {
              name
            }
          }
        }
      `);

      expect(code(body)).toBe('LOCATION_NOT_FOUND');
    });

    it('says UPSTREAM_UNAVAILABLE when Open-Meteo is down and nothing is stored', async () => {
      forecast.failure = new Error('upstream down');

      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "Lisbon") {
            location {
              name
            }
          }
        }
      `);

      expect(code(body)).toBe('UPSTREAM_UNAVAILABLE');
    });

    it('says BAD_USER_INPUT for an empty city, before asking anyone', async () => {
      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "   ") {
            location {
              name
            }
          }
        }
      `);

      expect(code(body)).toBe('BAD_USER_INPUT');
      expect(geocoding.calls).toEqual([]);
    });

    it('rejects a country code that is not two letters', async () => {
      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "Lisbon", countryCode: "Portugal") {
            location {
              name
            }
          }
        }
      `);

      expect(code(body)).toBe('BAD_USER_INPUT');
    });

    it('rejects an empty activities list rather than answering with nothing', async () => {
      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "Lisbon", activities: []) {
            rankings {
              activity
            }
          }
        }
      `);

      expect(code(body)).toBe('BAD_USER_INPUT');
    });

    it('rejects a limit outside one to ten', async () => {
      const body = await ask(/* GraphQL */ `
        query {
          searchLocations(query: "Lisbon", limit: 50) {
            name
          }
        }
      `);

      expect(code(body)).toBe('BAD_USER_INPUT');
    });

    it('turns a dead geocoder into an upstream code, not a stack trace', async () => {
      // Masking proper is in masking.test.ts; what this one holds is that the service
      // wraps a failed search before anything gets a chance to leak.
      geocoding.failure = Object.assign(new Error('secret internal detail'), { name: 'TypeError' });

      const body = await ask(/* GraphQL */ `
        query {
          searchLocations(query: "Lisbon") {
            name
          }
        }
      `);

      // The service wraps a geocoder failure, so this one is coded rather than masked.
      expect(code(body)).toBe('UPSTREAM_UNAVAILABLE');
      expect(JSON.stringify(body)).not.toContain('secret internal detail');
    });
  });

  describe('the schema itself', () => {
    it('rejects a field that does not exist', async () => {
      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "Lisbon") {
            notAField
          }
        }
      `);

      expect(body.errors?.[0]?.message).toContain('notAField');
    });

    it('serialises a local date and an instant as different things', async () => {
      const body = await ask(/* GraphQL */ `
        query {
          activityRankings(city: "Lisbon") {
            days {
              date
            }
            forecast {
              weatherFetchedAt
            }
          }
        }
      `);
      const result = body.data?.['activityRankings'] as Record<string, unknown>;

      expect((result['days'] as { date: string }[])[0]?.date).toBe('2026-09-14');
      expect((result['forecast'] as { weatherFetchedAt: string }).weatherFetchedAt).toBe(T0);
    });
  });
});

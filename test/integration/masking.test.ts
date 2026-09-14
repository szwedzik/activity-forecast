/**
 * What a caller may see, and what they may not (D§8.3, D-023).
 *
 * Driven through the real app rather than the function alone, because the previous
 * version of this file tested the helper in isolation and the wiring had no test at all:
 * the masking could have been removed entirely and the suite stayed green.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { App } from '../../src/app.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { fixedClock } from '../../src/services/clock.js';
import type { FakeGeocoding, RecordingLogger, Store } from '../helpers/services.js';
import {
  fakeForecast,
  fakeGeocoding,
  fakeMarine,
  geocodingResultFor,
  LISBON,
  openStore,
  recordingLogger,
  T0,
} from '../helpers/services.js';

interface Failure {
  message: string;
  extensions?: { code?: string };
}

describe('what reaches the client', () => {
  let store: Store;
  let geocoding: FakeGeocoding;
  let logger: RecordingLogger;
  let app: App;

  const fail = async (body: unknown): Promise<Failure> => {
    const response = await app.yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as { errors?: Failure[] };
    return parsed.errors?.[0] ?? { message: 'no error' };
  };

  beforeEach(() => {
    store = openStore();
    geocoding = fakeGeocoding([geocodingResultFor(LISBON)]);
    logger = recordingLogger();
    app = createApp({
      config: loadConfig({}),
      clock: fixedClock(T0),
      db: store.db,
      logger,
      clients: { geocoding, forecast: fakeForecast(), marine: fakeMarine() },
    });
  });

  describe('a caller who got the request wrong is told what is wrong', () => {
    it('names a required variable that was not provided', async () => {
      // This is the case the first version of the policy broke: graphql raises these
      // with no code at all, so an allowlist on the code masked them (D-023).
      const error = await fail({
        query: 'query R($city: String!) { activityRankings(city: $city) { location { name } } }',
        variables: {},
      });

      expect(error.message).toContain('$city');
      expect(error.extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
    });

    it('rejects null for a required variable', async () => {
      const error = await fail({
        query: 'query R($city: String!) { activityRankings(city: $city) { location { name } } }',
        variables: { city: null },
      });

      expect(error.message).toContain('$city');
      expect(error.message).not.toBe('Unexpected error.');
    });

    it('rejects a variable of the wrong type', async () => {
      const error = await fail({
        query: 'query S($limit: Int) { searchLocations(query: "x", limit: $limit) { name } }',
        variables: { limit: 'fifty' },
      });

      expect(error.message).toContain('Int');
      expect(error.message).not.toBe('Unexpected error.');
    });

    it('treats a bad limit the same whether it arrives inline or as a variable', async () => {
      // D§8.3 should not depend on how the client chose to send the value.
      const inline = await fail({ query: '{ searchLocations(query: "x", limit: 50) { name } }' });
      const variable = await fail({
        query: 'query S($limit: Int) { searchLocations(query: "x", limit: $limit) { name } }',
        variables: { limit: 50 },
      });

      expect(inline.extensions?.code).toBe('BAD_USER_INPUT');
      expect(variable.extensions?.code).toBe('BAD_USER_INPUT');
    });

    it('keeps reporting our own coded cases', async () => {
      geocoding.results = [];
      const error = await fail({ query: '{ activityRankings(city: "zzqqxwv") { location { name } } }' });

      expect(error.extensions?.code).toBe('LOCATION_NOT_FOUND');
      expect(error.message).toContain('zzqqxwv');
    });
  });

  describe('a bug on our side tells the caller nothing', () => {
    /**
     * A genuinely unhandled path. The geocoder is a poor choice for this: the location
     * service wraps anything it throws into a coded UPSTREAM_UNAVAILABLE, which is
     * correct and means nothing unexpected ever escapes it. A place whose timezone the
     * runtime cannot resolve does escape, as a RangeError nobody catches.
     */
    const breakTheTimezone = (): void => {
      geocoding.results = [{ ...geocodingResultFor(LISBON), timezone: 'Mars/Olympus_Mons' }];
    };

    it('replaces an unexpected failure with a masked message', async () => {
      breakTheTimezone();

      const error = await fail({ query: '{ activityRankings(city: "Lisbon") { location { name } } }' });

      expect(error.message).toBe('Unexpected error.');
      expect(error.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(error)).not.toContain('Olympus');
    });

    it('logs what it hid, so the bug is not invisible to us as well', async () => {
      breakTheTimezone();

      await fail({ query: '{ activityRankings(city: "Lisbon") { location { name } } }' });

      const logged = logger.errors.find((one) => one.message.includes('masked an unexpected error'));
      expect(logged).toBeDefined();
      // The detail the client was not given has to be somewhere, or a bug becomes an
      // HTTP 200 with no trace of itself anywhere.
      expect(JSON.stringify(logged?.fields)).toContain('Olympus');
    });
  });

  describe('errors raised before a resolver runs', () => {
    it('reports a syntax error', async () => {
      const error = await fail({ query: '{ activityRankings(city: "x" ' });

      expect(error.extensions?.code).toBe('GRAPHQL_PARSE_FAILED');
    });

    it('reports an unknown field', async () => {
      const error = await fail({ query: '{ activityRankings(city: "x") { nope } }' });

      expect(error.message).toContain('nope');
      expect(error.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });

    it('reports an enum value that does not exist', async () => {
      const error = await fail({
        query: '{ activityRankings(city: "x", activities: [FLYING]) { rankings { activity } } }',
      });

      expect(error.message).toContain('FLYING');
    });
  });
});

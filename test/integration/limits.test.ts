/**
 * What one request is allowed to cost (D-028).
 *
 * Aliasing is the cheap attack on a service like this: the schema is shallow and acyclic,
 * so depth buys nothing, but five hundred aliases of a root field is five hundred
 * geocoder calls out of a free tier. These go through `yoga.fetch` like the rest.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { App } from '../../src/app.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { MAX_ROOT_FIELDS } from '../../src/graphql/limits.js';
import { fixedClock } from '../../src/services/clock.js';
import type { FakeGeocoding, Store } from '../helpers/services.js';
import {
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

describe('what one request may ask for', () => {
  let store: Store;
  let geocoding: FakeGeocoding;
  let app: App;

  const send = async (query: string, headers: Record<string, string> = {}): Promise<Response> =>
    app.yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
    });

  const ask = async (query: string): Promise<GraphQLResponse> =>
    (await send(query)) .json() as Promise<GraphQLResponse>;

  /** `n` aliases of a root field, which is the shape that costs upstream calls. */
  const aliases = (n: number): string =>
    `{ ${Array.from({ length: n }, (_, i) => `a${i}: searchLocations(query: "Lisbon") { id }`).join(' ')} }`;

  beforeEach(() => {
    store = openStore();
    geocoding = fakeGeocoding([geocodingResultFor(LISBON)]);
    app = createApp({
      config: loadConfig({}),
      clock: fixedClock(T0),
      db: store.db,
      clients: { geocoding, forecast: fakeForecast(), marine: fakeMarine() },
    });
  });

  it('allows as many root fields as the limit says', async () => {
    const body = await ask(aliases(MAX_ROOT_FIELDS));

    expect(body.errors).toBeUndefined();
    expect(geocoding.calls).toHaveLength(MAX_ROOT_FIELDS);
  });

  it('refuses one more than that', async () => {
    const body = await ask(aliases(MAX_ROOT_FIELDS + 1));

    expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(body.errors?.[0]?.message).toContain(`at most ${MAX_ROOT_FIELDS}`);
  });

  it('refuses it before any resolver runs', async () => {
    // The whole point: the upstream calls must not happen, not merely be discarded.
    await ask(aliases(200));

    expect(geocoding.calls).toEqual([]);
  });

  it('counts the fields inside a fragment too', async () => {
    // Otherwise the limit is one spread away from meaningless.
    const spread = `
      query { ...lots }
      fragment lots on Query {
        ${Array.from({ length: MAX_ROOT_FIELDS + 1 }, (_, i) => `f${i}: searchLocations(query: "Lisbon") { id }`).join('\n')}
      }`;

    const body = await ask(spread);

    expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(geocoding.calls).toEqual([]);
  });

  it('does not hand a browser on another origin permission to use it', async () => {
    // Yoga's default reflects whatever Origin it is given, with credentials allowed.
    const response = await send('{ __typename }', { origin: 'https://example.invalid' });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

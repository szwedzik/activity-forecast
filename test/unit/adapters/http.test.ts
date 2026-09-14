import { describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../../../src/adapters/openMeteo/http.js';
import { DEFAULT_USER_AGENT, getJson, UpstreamError } from '../../../src/adapters/openMeteo/http.js';
import {
  abortedBody,
  fakeFetch,
  invalidJson,
  networkError,
  noSleep,
  ok,
  status,
  timeout,
} from '../../helpers/fakeFetch.js';

const options = (fetch: FetchLike) => ({ fetch, timeoutMs: 5000, sleep: noSleep });

// Compile-time only: the real fetch has to satisfy the narrow shape the clients ask for,
// or production would be wired to something the tests never exercise.
const _realFetchFits: FetchLike = globalThis.fetch;
void _realFetchFits;

describe('a successful request', () => {
  it('returns the parsed body', async () => {
    const http = fakeFetch([ok({ hello: 'world' })]);

    await expect(getJson('https://example.test/a', options(http.fetch))).resolves.toEqual({
      hello: 'world',
    });
    expect(http.calls).toHaveLength(1);
  });

  it('identifies itself, so Open-Meteo can see who is calling', async () => {
    const http = fakeFetch([ok({})]);
    await getJson('https://example.test/a', options(http.fetch));

    expect(http.calls[0]?.headers?.['User-Agent']).toBe(DEFAULT_USER_AGENT);
  });
});

describe('retrying', () => {
  it('retries a 500 once and succeeds on the second try', async () => {
    const http = fakeFetch([status(500), ok({ recovered: true })]);

    await expect(getJson('https://example.test/a', options(http.fetch))).resolves.toEqual({
      recovered: true,
    });
    expect(http.calls).toHaveLength(2);
  });

  it('gives up after one retry rather than hammering', async () => {
    const http = fakeFetch([status(500)]);

    await expect(getJson('https://example.test/a', options(http.fetch))).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(http.calls).toHaveLength(2);
  });

  it('retries a dropped connection', async () => {
    const http = fakeFetch([networkError(), ok({ fine: true })]);

    await expect(getJson('https://example.test/a', options(http.fetch))).resolves.toEqual({
      fine: true,
    });
    expect(http.calls).toHaveLength(2);
  });

  it('waits before the retry, and the wait is injectable', async () => {
    const sleep = vi.fn(async () => undefined);
    const http = fakeFetch([status(503), ok({})]);

    await getJson('https://example.test/a', { fetch: http.fetch, timeoutMs: 5000, sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('does not retry a 400: the request is wrong and will stay wrong', async () => {
    const http = fakeFetch([status(400)]);

    await expect(getJson('https://example.test/a', options(http.fetch))).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('does not retry a 429, but says stale data may be served instead', async () => {
    // Coming back 500 ms later cannot help when the limit is per second (D-012).
    const http = fakeFetch([status(429)]);

    await expect(getJson('https://example.test/a', options(http.fetch))).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('does not retry a body that is not JSON', async () => {
    const http = fakeFetch([invalidJson()]);

    await expect(getJson('https://example.test/a', options(http.fetch))).rejects.toMatchObject({
      retryable: false,
    });
    expect(http.calls).toHaveLength(1);
  });
});

describe('timeouts', () => {
  it('are retryable, so a stale snapshot can be served', async () => {
    const http = fakeFetch([timeout()]);

    const error = await getJson('https://example.test/a', options(http.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ retryable: true, status: undefined });
    expect((error as Error).message).toContain('timed out after 5000 ms');
  });

  it('hand fetch a live deadline, not just a promise that never settles', async () => {
    const http = fakeFetch([ok({})]);
    await getJson('https://example.test/a', { fetch: http.fetch, timeoutMs: 1234, sleep: noSleep });

    const signal = http.calls[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('are still retryable when the deadline fires part-way through the body', async () => {
    // Real fetch aborts the body stream, so the failure surfaces from json() rather than
    // from the request. Mistaking that for a broken payload would lose the fallback.
    const http = fakeFetch([abortedBody(), ok({ recovered: true })]);

    await expect(getJson('https://example.test/a', options(http.fetch))).resolves.toEqual({
      recovered: true,
    });
    expect(http.calls).toHaveLength(2);
  });
});

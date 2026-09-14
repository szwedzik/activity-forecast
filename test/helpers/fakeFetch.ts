/**
 * A `fetch` that never leaves the process. Every adapter test drives one of these, so
 * nothing in the suite can reach Open-Meteo even by mistake.
 */
import type { FetchLike, HttpResponse } from '../../src/adapters/openMeteo/http.js';

export interface Call {
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  readonly signal: AbortSignal | undefined;
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: Call[];
}

type Reply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'invalidJson'; readonly status: number }
  | { readonly kind: 'abortedBody'; readonly status: number }
  | { readonly kind: 'networkError'; readonly error: Error };

function respond(reply: Reply): Promise<HttpResponse> {
  if (reply.kind === 'networkError') return Promise.reject(reply.error);

  const status = reply.status;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 500 ? 'Internal Server Error' : '',
    json: () => {
      if (reply.kind === 'invalidJson') return Promise.reject(new SyntaxError('Unexpected token < in JSON'));
      if (reply.kind === 'abortedBody') {
        return Promise.reject(
          Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
        );
      }
      return Promise.resolve(reply.body);
    },
  });
}

/** Replies in order; the last reply repeats once the list runs out. */
export function fakeFetch(replies: readonly Reply[]): FakeFetch {
  const calls: Call[] = [];
  let index = 0;

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, headers: init?.headers, signal: init?.signal });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply === undefined) throw new Error('fakeFetch needs at least one reply');
      return respond(reply);
    },
  };
}

export const ok = (body: unknown): Reply => ({ kind: 'json', status: 200, body });
export const status = (code: number, body: unknown = {}): Reply => ({
  kind: 'json',
  status: code,
  body,
});
export const invalidJson = (): Reply => ({ kind: 'invalidJson', status: 200 });
export const networkError = (message = 'ECONNRESET'): Reply => ({
  kind: 'networkError',
  error: new Error(message),
});
export const timeout = (): Reply => ({
  kind: 'networkError',
  error: Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  }),
});

/** Test clients never wait for the retry delay. */
export const noSleep = (): Promise<void> => Promise.resolve();

/** The deadline fires after the headers but before the body finishes (D§6.4). */
export const abortedBody = (): Reply => ({ kind: 'abortedBody', status: 200 });

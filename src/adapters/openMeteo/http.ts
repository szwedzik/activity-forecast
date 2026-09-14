/**
 * The one place that talks to the network (D§6.4).
 *
 * `fetch` is injected rather than reached for, so every test runs against a fake and
 * nothing in the suite can touch Open-Meteo by accident.
 */

export interface UpstreamErrorOptions {
  /** Absent for a network error or a timeout, where there was no response. */
  readonly status?: number | undefined;
  /**
   * Whether it is worth serving stale data instead. This is not the same as whether to
   * retry now: 429 says come back later, so it is retryable but never retried (D-012).
   */
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class UpstreamError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: UpstreamErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UpstreamError';
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

/** The slice of `fetch` this module uses. Narrow on purpose, so a fake is three lines. */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<HttpResponse>;

export interface HttpOptions {
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly userAgent?: string;
  /** Injectable so tests do not spend half a second waiting. */
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What the three clients need: how to reach an endpoint, and how to give up on it. */
export interface ClientOptions extends HttpOptions {
  readonly url: string;
}

export const DEFAULT_USER_AGENT = 'activity-forecast/1.0';
const DEFAULT_RETRY_DELAY_MS = 500;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A second call right now only helps if the first failed for a reason that might pass. */
function worthRetryingNow(error: UpstreamError): boolean {
  // Anything not worth serving stale data over is not worth calling twice either: a
  // bad request or a body that is not JSON will come back exactly the same.
  if (!error.retryable) return false;
  if (error.status === undefined) return true; // network error or timeout
  if (error.status === 429) return false; // rate limited: waiting 500 ms changes nothing
  return error.status >= 500;
}

function asUpstreamError(error: unknown, url: string, timeoutMs: number): UpstreamError {
  if (error instanceof UpstreamError) return error;

  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new UpstreamError(`timed out after ${timeoutMs} ms: ${url}`, {
      retryable: true,
      cause: error,
    });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new UpstreamError(`request failed: ${reason}`, { retryable: true, cause: error });
}

async function attempt(url: string, options: HttpOptions): Promise<unknown> {
  let response: HttpResponse;
  try {
    response = await options.fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { 'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT },
    });
  } catch (error) {
    throw asUpstreamError(error, url, options.timeoutMs);
  }

  if (!response.ok) {
    throw new UpstreamError(
      `${response.status}${response.statusText ? ` ${response.statusText}` : ''} from ${url}`,
      { status: response.status, retryable: response.status >= 500 || response.status === 429 },
    );
  }

  try {
    return await response.json();
  } catch (error) {
    // The deadline can fire after the headers arrive but before the body finishes, which
    // aborts the stream. That is still a timeout and still worth serving stale data over,
    // so it must not be mistaken for a broken payload (D§6.4).
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw asUpstreamError(error, url, options.timeoutMs);
    }
    // A 200 that is not JSON is a broken upstream, not a blip; retrying would just repeat it.
    throw new UpstreamError(`malformed JSON from ${url}`, { retryable: false, cause: error });
  }
}

/** GET a URL and return the parsed body, retrying once when that could plausibly help. */
export async function getJson(url: string, options: HttpOptions): Promise<unknown> {
  try {
    return await attempt(url, options);
  } catch (error) {
    const upstream = asUpstreamError(error, url, options.timeoutMs);
    if (!worthRetryingNow(upstream)) throw upstream;

    await (options.sleep ?? wait)(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    return attempt(url, options);
  }
}

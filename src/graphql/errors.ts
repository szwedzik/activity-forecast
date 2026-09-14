/**
 * What a caller is allowed to see (D§8.3).
 *
 * A `GraphQLError` is by definition something the client should read: a bad variable, an
 * unknown field, or one of our three coded cases. Anything else is a bug on our side, and
 * a bug should not describe itself to a stranger.
 */
import { GraphQLError } from 'graphql';

import { ServiceError } from '../services/errors.js';
import type { Logger } from '../services/logger.js';

const coded = (code: string, message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code } });

export const badUserInput = (message: string): GraphQLError => coded('BAD_USER_INPUT', message);

export const locationNotFound = (city: string): GraphQLError =>
  coded('LOCATION_NOT_FOUND', `No place matched "${city}".`);

export const upstreamUnavailable = (message: string): GraphQLError =>
  coded('UPSTREAM_UNAVAILABLE', message);

/**
 * Services already speak in codes (D-021), so this translates rather than inventing a
 * second vocabulary. The cause is deliberately not attached: it would make the result
 * look like a wrapped internal failure and get it masked, and it is logged instead.
 */
export function toGraphQLError(error: unknown): unknown {
  if (!(error instanceof ServiceError)) return error;
  return coded(error.code, error.message);
}

/**
 * Whether an error was meant for the client.
 *
 * Checked by name rather than `instanceof`, which is what `@envelop/core` does and the
 * reason this exists: `instanceof` is only reliable while exactly one copy of the
 * `graphql` module is in play, and under a bundler there may not be. When that happened
 * here, every coded error silently became an internal one (D-023).
 *
 * A `GraphQLError` wrapping something that is not a `GraphQLError` is a resolver that
 * threw, so the wrapper is ours but the contents are not fit to publish.
 */
function isClientError(error: unknown): boolean {
  const candidate = error as { name?: unknown; originalError?: { name?: unknown } | null } | null;
  if (candidate?.name !== 'GraphQLError') return false;

  const original = candidate.originalError;
  return original === undefined || original === null || original.name === 'GraphQLError';
}

/**
 * Yoga's masker, with a logger attached: an error nobody may see is an error someone has
 * to be told about, or a bug becomes an HTTP 200 with no trace of itself anywhere.
 */
export function createMaskError(logger: Logger) {
  return function maskError(error: unknown, message: string): Error {
    if (isClientError(error)) return error as Error;

    logger.error(
      { error: error instanceof Error ? (error.stack ?? error.message) : String(error) },
      'masked an unexpected error while answering a request',
    );
    return new GraphQLError(message, { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
  };
}

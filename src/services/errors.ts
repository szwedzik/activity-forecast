/**
 * What a service can fail with. Phase 5 maps these onto `GraphQLError` with the codes in
 * D§8.3; nothing here imports GraphQL, so the services stay usable without it.
 */

export type ServiceErrorCode = 'LOCATION_NOT_FOUND' | 'UPSTREAM_UNAVAILABLE';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ServiceError';
    this.code = code;
  }
}

export const locationNotFound = (city: string): ServiceError =>
  new ServiceError('LOCATION_NOT_FOUND', `No place matched "${city}".`);

export const upstreamUnavailable = (what: string, cause?: unknown): ServiceError =>
  new ServiceError(
    'UPSTREAM_UNAVAILABLE',
    `Open-Meteo is unavailable and nothing usable is stored for ${what}.`,
    { cause },
  );

/**
 * Everything assembled, from parts it is handed rather than parts it goes and finds.
 *
 * That is the whole point of this file: an integration test passes an in-memory database
 * and fake clients and gets a working API with no port open and no network reachable,
 * while `index.ts` passes the real ones. Nothing here reads the environment or the disk.
 */
import type { Plugin } from 'graphql-yoga';
import { createSchema, createYoga } from 'graphql-yoga';

import type { Database } from './adapters/db/database.js';
import { reachable } from './adapters/db/database.js';
import { createLocationRepository } from './adapters/db/locationRepository.js';
import { createSnapshotRepository } from './adapters/db/snapshotRepository.js';
import type { ForecastClient } from './adapters/openMeteo/forecastClient.js';
import type { GeocodingClient } from './adapters/openMeteo/geocodingClient.js';
import type { MarineClient } from './adapters/openMeteo/marineClient.js';
import type { Config } from './config.js';
import type { ResolverContext } from './graphql/resolvers.js';
import { createMaskError } from './graphql/errors.js';
import { rootFieldLimit } from './graphql/limits.js';
import { resolvers } from './graphql/resolvers.js';
import { typeDefs } from './graphql/schema.js';
import type { Clock } from './services/clock.js';
import type { ForecastService } from './services/forecastService.js';
import { createForecastService } from './services/forecastService.js';
import type { LocationService } from './services/locationService.js';
import { createLocationService } from './services/locationService.js';
import type { Logger } from './services/logger.js';
import { silentLogger } from './services/logger.js';
import type { RankingService } from './services/rankingService.js';
import { createRankingService } from './services/rankingService.js';
import type { RefreshScheduler } from './services/refreshScheduler.js';
import { createRefreshScheduler } from './services/refreshScheduler.js';

export interface Clients {
  readonly geocoding: GeocodingClient;
  readonly forecast: ForecastClient;
  readonly marine: MarineClient;
}

export interface AppOptions {
  readonly config: Config;
  readonly clock: Clock;
  readonly db: Database;
  readonly clients: Clients;
  readonly logger?: Logger;
}

/**
 * Whatever Yoga hands back: a fetch handler that also works as a node:http listener.
 * Taken from the function rather than spelled out, so a Yoga upgrade cannot silently
 * disagree with a type we wrote down.
 */
export type Yoga = ReturnType<typeof buildYoga>;

/**
 * Something a human or an orchestrator can read (D-033).
 *
 * Yoga's own health endpoint answers 200 with an empty body, which is a white page in a
 * browser and tells an orchestrator nothing the open socket had not already told it. This
 * one says whether the database will answer, which is the only part that can be false
 * while the process is still up.
 */
function healthEndpoint(db: Database, logger: Logger): Plugin<ResolverContext> {
  return {
    onRequest({ url, endResponse, fetchAPI }) {
      if (url.pathname !== '/health') return;

      const database = reachable(db);
      if (!database) logger.error({}, 'health check could not reach the database');

      endResponse(
        new fetchAPI.Response(JSON.stringify({ status: database ? 'ok' : 'unavailable', database }), {
          status: database ? 200 : 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

/** Breadth, decided before any resolver runs (D-028). */
const limits: Plugin<ResolverContext> = {
  onValidate({ addValidationRule }) {
    addValidationRule(rootFieldLimit());
  },
};

function buildYoga(context: ResolverContext, logger: Logger, db: Database) {
  return createYoga({
    schema: createSchema<ResolverContext>({ typeDefs, resolvers }),
    context: () => context,
    // Masking stays on, but the decision of what may be seen is ours, and an error
    // nobody may see still gets logged (D§8.3, D-023).
    maskedErrors: { maskError: createMaskError(logger) },
    plugins: [limits, healthEndpoint(db, logger)],
    // Yoga installs its own /health unconditionally, answering 200 with an empty body,
    // and its plugins run before ours. Moved aside rather than left to win the race for
    // the path (D-033).
    healthCheckEndpoint: '/__yoga_alive',
    // Off: it keeps the source and the AST of every distinct query for an hour, which
    // turns a stream of large unique queries into memory we never get back (D-028).
    parserAndValidationCache: false,
    // No browser has any business calling this from another origin, and the default
    // reflects whatever Origin it is given, with credentials (D-028).
    cors: false,
    landingPage: false,
    logging: false,
  });
}

export interface App {
  readonly yoga: Yoga;
  readonly services: {
    readonly locations: LocationService;
    readonly forecasts: ForecastService;
    readonly ranking: RankingService;
  };
  /**
   * Built but not started: the bootstrap decides when, so a test that never asks for a
   * timer never gets one (D§6.3).
   */
  readonly refresher: RefreshScheduler;
  /** Stops anything the app started. The database belongs to whoever opened it. */
  close(): Promise<void>;
}

export function createApp(options: AppOptions): App {
  const { config, clock, db, clients } = options;
  const logger = options.logger ?? silentLogger;

  const locations = createLocationService({
    repository: createLocationRepository(db),
    geocoding: clients.geocoding,
    clock,
    logger,
    policy: config.geocode,
  });

  const forecasts = createForecastService({
    snapshots: createSnapshotRepository(db),
    forecast: clients.forecast,
    marine: clients.marine,
    clock,
    logger,
    weatherPolicy: config.weather,
    marinePolicy: config.marine,
  });

  const ranking = createRankingService({ locations, forecasts, clock });

  const refresher = createRefreshScheduler({
    locations: createLocationRepository(db),
    snapshots: createSnapshotRepository(db),
    forecasts,
    clock,
    logger,
    enabled: config.refresh.enabled,
    intervalMs: config.refresh.intervalMs,
    activeWindowMs: config.refresh.activeWindowMs,
    maxLocations: config.refresh.maxLocations,
    retentionMs: config.snapshotRetentionMs,
  });

  return {
    yoga: buildYoga({ ranking, locations }, logger, db),
    services: { locations, forecasts, ranking },
    refresher,
    close: () => refresher.stop(),
  };
}

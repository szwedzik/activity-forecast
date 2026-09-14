/**
 * Everything assembled, from parts it is handed rather than parts it goes and finds.
 *
 * That is the whole point of this file: an integration test passes an in-memory database
 * and fake clients and gets a working API with no port open and no network reachable,
 * while `index.ts` passes the real ones. Nothing here reads the environment or the disk.
 */
import { createSchema, createYoga } from 'graphql-yoga';

import type { Database } from './adapters/db/database.js';
import { createLocationRepository } from './adapters/db/locationRepository.js';
import { createSnapshotRepository } from './adapters/db/snapshotRepository.js';
import type { ForecastClient } from './adapters/openMeteo/forecastClient.js';
import type { GeocodingClient } from './adapters/openMeteo/geocodingClient.js';
import type { MarineClient } from './adapters/openMeteo/marineClient.js';
import type { Config } from './config.js';
import type { ResolverContext } from './graphql/resolvers.js';
import { createMaskError } from './graphql/errors.js';
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

function buildYoga(context: ResolverContext, logger: Logger) {
  return createYoga({
    schema: createSchema<ResolverContext>({ typeDefs, resolvers }),
    context: () => context,
    // Masking stays on, but the decision of what may be seen is ours, and an error
    // nobody may see still gets logged (D§8.3, D-023).
    maskedErrors: { maskError: createMaskError(logger) },
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
    retentionMs: config.snapshotRetentionMs,
  });

  return {
    yoga: buildYoga({ ranking, locations }, logger),
    services: { locations, forecasts, ranking },
    refresher,
    close: () => refresher.stop(),
  };
}

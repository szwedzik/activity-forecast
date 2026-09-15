/**
 * The process: read the environment, open the database, wire the real clients, listen.
 *
 * The only file that touches `process.env`, the filesystem or a socket. Everything below
 * it takes what it needs as an argument, which is why the whole API can be tested
 * without any of the three.
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { openDatabase } from './adapters/db/database.js';
import { createForecastClient } from './adapters/openMeteo/forecastClient.js';
import { createGeocodingClient } from './adapters/openMeteo/geocodingClient.js';
import { createMarineClient } from './adapters/openMeteo/marineClient.js';
import type { FetchLike } from './adapters/openMeteo/http.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { withBodyLimit } from './httpLimits.js';
import { createShutdown } from './shutdown.js';
import { systemClock, toIsoUtc } from './services/clock.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const clock = systemClock;

// SQLite will not create the directory for us, and a first run on a clean checkout has
// no ./data yet.
if (config.dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

// The clock the rest of the service uses, rather than the one openDatabase would reach
// for on its own (D§4.2).
const db = openDatabase(config.dbPath, { appliedAt: toIsoUtc(clock.now()) });

const http = { fetch: globalThis.fetch as FetchLike, timeoutMs: config.openMeteo.timeoutMs };

const app = createApp({
  config,
  clock,
  db,
  logger,
  clients: {
    geocoding: createGeocodingClient({ url: config.openMeteo.geocodingUrl, ...http }),
    forecast: createForecastClient({ url: config.openMeteo.forecastUrl, ...http }),
    marine: createMarineClient({ url: config.openMeteo.marineUrl, ...http }),
  },
});

const server = createServer(withBodyLimit(app.yoga, config.maxBodyBytes, logger));

server.listen(config.port, config.host, () => {
  // Only once we are actually serving: nothing to keep warm before that.
  app.refresher.start();
  logger.info(
    { host: config.host, port: config.port, dbPath: config.dbPath, refreshEnabled: config.refresh.enabled },
    `activity-forecast listening on http://${config.host}:${config.port}/graphql`,
  );
});

// The sequence itself lives in shutdown.ts, where it can be tested: Windows does not
// deliver POSIX signals, so a handler written inline here could never be exercised.
const shutdown = createShutdown({ app, server, db, logger });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

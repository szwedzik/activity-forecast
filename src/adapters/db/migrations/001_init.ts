/**
 * The initial schema (D§5.1), embedded as a string so `tsc` output needs no asset-copy
 * step and `npm start` cannot fail on a missing file (D-009).
 *
 * The connection PRAGMAs are not here: they belong to the connection, not the schema,
 * so `openDatabase` sets them.
 */

export const name = '001_init';

export const sql = `
CREATE TABLE locations (
  id                INTEGER PRIMARY KEY,
  geonames_id       INTEGER NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  country_code      TEXT,
  country           TEXT,
  admin1            TEXT,
  latitude          REAL    NOT NULL,
  longitude         REAL    NOT NULL,
  elevation_m       REAL,
  timezone          TEXT    NOT NULL,
  population        INTEGER,
  created_at        TEXT    NOT NULL,
  last_requested_at TEXT
);

-- What the user asked for, and what it turned out to be. A NULL location_id is a
-- remembered miss, so a nonsense name is geocoded once rather than on every request.
CREATE TABLE location_queries (
  query_key   TEXT PRIMARY KEY,
  location_id INTEGER REFERENCES locations(id),
  resolved_at TEXT NOT NULL
);

-- What Open-Meteo said about a location at an instant. Inserted, never updated: a
-- refresh adds a row and the older ones are pruned, which makes the store auditable
-- and makes concurrent refreshes harmless (D§5.2).
CREATE TABLE forecast_snapshots (
  id               INTEGER PRIMARY KEY,
  location_id      INTEGER NOT NULL REFERENCES locations(id),
  source           TEXT    NOT NULL CHECK (source IN ('weather', 'marine')),
  status           TEXT    NOT NULL CHECK (status IN ('ok', 'unavailable')),
  fetched_at       TEXT    NOT NULL,
  first_date       TEXT,
  last_date        TEXT,
  grid_latitude    REAL,
  grid_longitude   REAL,
  grid_elevation_m REAL,
  payload          TEXT
);

CREATE INDEX ix_snapshots_latest ON forecast_snapshots (location_id, source, fetched_at DESC);

-- Not in D§5.1: added for the refresher, which scans locations by when they were last
-- asked about, every ten minutes, forever (D§6.3, D-016).
CREATE INDEX ix_locations_requested ON locations (last_requested_at);
`;

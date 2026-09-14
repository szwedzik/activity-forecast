/**
 * Forecast snapshots: what Open-Meteo said about a location at an instant (D§5.1).
 *
 * Rows are inserted and never updated. A refresh adds a row, reads take the newest, and
 * retention deletes the rest — which means two refreshes racing each other cannot corrupt
 * anything, and "what did we know at nine o'clock" stays answerable (D§5.2).
 */
import type { Database } from './database.js';
import { orUndefined, query } from './database.js';

export type SnapshotSource = 'weather' | 'marine';

/**
 * `unavailable` is a real answer, not a failure: inland there is no wave model, and
 * remembering that stops us asking again every few hours (D§6.1).
 */
export type SnapshotStatus = 'ok' | 'unavailable';

export interface Snapshot {
  readonly id: number;
  readonly locationId: number;
  readonly source: SnapshotSource;
  readonly status: SnapshotStatus;
  readonly fetchedAt: string;
  /** Local dates the payload covers; absent when there is no payload. */
  readonly firstDate?: string | undefined;
  readonly lastDate?: string | undefined;
  /** The cell the model actually answered from, which is not quite the town (D§2.3). */
  readonly gridLatitude?: number | undefined;
  readonly gridLongitude?: number | undefined;
  readonly gridElevationM?: number | undefined;
  /** The response body as it arrived. Absent when the status is `unavailable`. */
  readonly payload?: string | undefined;
}

export type NewSnapshot = Omit<Snapshot, 'id'>;

export interface SnapshotRepository {
  insert(snapshot: NewSnapshot): Snapshot;
  getLatest(locationId: number, source: SnapshotSource): Snapshot | undefined;
  /** Deletes snapshots older than the cutoff, always keeping the newest of each pair. */
  prune(olderThan: string): number;
}

interface SnapshotRow {
  readonly id: number;
  readonly location_id: number;
  readonly source: string;
  readonly status: string;
  readonly fetched_at: string;
  readonly first_date: string | null;
  readonly last_date: string | null;
  readonly grid_latitude: number | null;
  readonly grid_longitude: number | null;
  readonly grid_elevation_m: number | null;
  readonly payload: string | null;
}

function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    locationId: row.location_id,
    source: row.source as SnapshotSource,
    status: row.status as SnapshotStatus,
    fetchedAt: row.fetched_at,
    firstDate: orUndefined(row.first_date),
    lastDate: orUndefined(row.last_date),
    gridLatitude: orUndefined(row.grid_latitude),
    gridLongitude: orUndefined(row.grid_longitude),
    gridElevationM: orUndefined(row.grid_elevation_m),
    payload: orUndefined(row.payload),
  };
}

const INSERT = `
INSERT INTO forecast_snapshots (
  location_id, source, status, fetched_at,
  first_date, last_date, grid_latitude, grid_longitude, grid_elevation_m, payload
) VALUES (
  :locationId, :source, :status, :fetchedAt,
  :firstDate, :lastDate, :gridLatitude, :gridLongitude, :gridElevationM, :payload
)
RETURNING *`;

/**
 * Keep the newest row for every (location, source) whatever its age: an old snapshot is
 * still better than none when upstream is down, and retention must not be what empties
 * the store (D§5.3, D§6.1).
 */
const PRUNE = `
DELETE FROM forecast_snapshots
WHERE fetched_at < ?
  AND id <> (
    SELECT newest.id
    FROM forecast_snapshots newest
    WHERE newest.location_id = forecast_snapshots.location_id
      AND newest.source = forecast_snapshots.source
    ORDER BY newest.fetched_at DESC, newest.id DESC
    LIMIT 1
  )`;

export function createSnapshotRepository(db: Database): SnapshotRepository {
  const insert = query<SnapshotRow>(db, INSERT);
  const latest = query<SnapshotRow>(
    db,
    `
    SELECT * FROM forecast_snapshots
    WHERE location_id = ? AND source = ?
    ORDER BY fetched_at DESC, id DESC
    LIMIT 1`,
  );
  const prune = query(db, PRUNE);

  return {
    insert(snapshot) {
      const row = insert.get({
        locationId: snapshot.locationId,
        source: snapshot.source,
        status: snapshot.status,
        fetchedAt: snapshot.fetchedAt,
        firstDate: snapshot.firstDate,
        lastDate: snapshot.lastDate,
        gridLatitude: snapshot.gridLatitude,
        gridLongitude: snapshot.gridLongitude,
        gridElevationM: snapshot.gridElevationM,
        payload: snapshot.payload,
      });

      if (!row) throw new Error('insert returned no row');
      return toSnapshot(row);
    },

    getLatest(locationId, source) {
      const row = latest.get(locationId, source);
      return row === undefined ? undefined : toSnapshot(row);
    },

    prune(olderThan) {
      return prune.run(olderThan);
    },
  };
}

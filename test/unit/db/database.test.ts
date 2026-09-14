import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  migrate,
  namedParametersOf,
  openDatabase,
  query,
  toBindable,
} from '../../../src/adapters/db/database.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'activity-forecast-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'test.db');
}

describe('opening a database', () => {
  it('creates the schema and records the migration', () => {
    const db = openDatabase(':memory:', { appliedAt: '2026-09-14T00:00:00.000Z' });

    const tables = query<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);

    expect(tables).toContain('locations');
    expect(tables).toContain('location_queries');
    expect(tables).toContain('forecast_snapshots');
    expect(tables).toContain('schema_migrations');

    expect(
      query<{ name: string; applied_at: string }>(db, 'SELECT * FROM schema_migrations').all(),
    ).toEqual([{ name: '001_init', applied_at: '2026-09-14T00:00:00.000Z' }]);

    db.close();
  });

  it('turns on foreign keys, which SQLite leaves off by default', () => {
    const db = openDatabase(':memory:');

    db.prepare(
      `INSERT INTO locations (geonames_id, name, latitude, longitude, timezone, created_at)
       VALUES (1, 'Lisbon', 38.7, -9.1, 'Europe/Lisbon', '2026-09-14T00:00:00.000Z')`,
    ).run();

    // A snapshot for a location that does not exist must not be storable.
    expect(() =>
      db
        .prepare(
          `INSERT INTO forecast_snapshots (location_id, source, status, fetched_at)
           VALUES (999, 'weather', 'ok', '2026-09-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('uses write-ahead logging on a real file, so a refresh can write while a request reads', () => {
    const db = openDatabase(temporaryDatabasePath());

    const mode = query<{ journal_mode: string }>(db, 'PRAGMA journal_mode').get();
    expect(mode?.journal_mode).toBe('wal');

    db.close();
  });

  it('survives being reopened, keeping what was stored', () => {
    const file = temporaryDatabasePath();

    const first = openDatabase(file);
    first
      .prepare(
        `INSERT INTO locations (geonames_id, name, latitude, longitude, timezone, created_at)
         VALUES (7, 'Chamonix', 45.9, 6.9, 'Europe/Paris', '2026-09-14T00:00:00.000Z')`,
      )
      .run();
    first.close();

    // Reopening runs migrate again; it must find its own work already done.
    const second = openDatabase(file);
    const stored = query<{ name: string }>(second, 'SELECT name FROM locations WHERE geonames_id = 7').get();

    expect(stored?.name).toBe('Chamonix');
    expect(
      query<{ name: string }>(second, 'SELECT name FROM schema_migrations').all(),
    ).toHaveLength(1);
    second.close();
  });

  it('enforces the source and status the design allows', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO locations (geonames_id, name, latitude, longitude, timezone, created_at)
       VALUES (1, 'Lisbon', 38.7, -9.1, 'Europe/Lisbon', '2026-09-14T00:00:00.000Z')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO forecast_snapshots (location_id, source, status, fetched_at)
           VALUES (1, 'tides', 'ok', '2026-09-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO forecast_snapshots (location_id, source, status, fetched_at)
           VALUES (1, 'weather', 'maybe', '2026-09-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });
});

/**
 * The driver's treatment of values it dislikes is uneven: some throw, some are stored as
 * NULL without a word. These pin down what we do about each (D-018).
 */
describe('converting a value for SQLite', () => {
  it('keeps what SQLite can hold', () => {
    expect(toBindable('text', 'x')).toBe('text');
    expect(toBindable(1.5, 'x')).toBe(1.5);
    expect(toBindable(0, 'x')).toBe(0);
    expect(toBindable('', 'x')).toBe('');
    expect(toBindable(10n, 'x')).toBe(10n);
    expect(toBindable(new Uint8Array([1, 2]), 'x')).toEqual(new Uint8Array([1, 2]));
  });

  it('treats nothing as NULL, whichever way it is spelled', () => {
    expect(toBindable(undefined, 'x')).toBeNull();
    expect(toBindable(null, 'x')).toBeNull();
  });

  it('maps a boolean to 0 or 1, which the driver refuses to do', () => {
    expect(toBindable(true, 'x')).toBe(1);
    expect(toBindable(false, 'x')).toBe(0);
  });

  it('turns a Date into our stored format rather than the NULL the driver would write', () => {
    expect(toBindable(new Date('2026-09-14T09:00:00.000Z'), 'x')).toBe('2026-09-14T09:00:00.000Z');
  });

  it('refuses the values that have no SQLite representation, rather than storing NULL', () => {
    expect(() => toBindable(Number.NaN, ':latitude')).toThrow(/latitude/);
    expect(() => toBindable(Number.POSITIVE_INFINITY, 'x')).toThrow(TypeError);
    expect(() => toBindable(new Date('nonsense'), 'x')).toThrow(TypeError);
    expect(() => toBindable({ a: 1 }, 'x')).toThrow(TypeError);
    expect(() => toBindable([1, 2], 'x')).toThrow(TypeError);
    expect(() => toBindable(Symbol('s'), 'x')).toThrow(TypeError);
    expect(() => toBindable(() => 1, 'x')).toThrow(TypeError);
  });

  it('names the parameter in the message, so a failure says which column', () => {
    expect(() => toBindable(Number.NaN, ':gridLatitude')).toThrow(/:gridLatitude/);
  });
});

describe('finding the parameters a statement expects', () => {
  it('reads them off the SQL', () => {
    expect(namedParametersOf('INSERT INTO t (a, b) VALUES (:a, :b)')).toEqual(['a', 'b']);
  });

  it('lists each name once, however often it appears', () => {
    expect(namedParametersOf('SELECT * FROM t WHERE a = :x OR b = :x')).toEqual(['x']);
  });

  it('finds none in a positional statement', () => {
    expect(namedParametersOf('SELECT * FROM t WHERE a = ? AND b = ?')).toEqual([]);
  });

  it('is not fooled by a colon inside a string literal', () => {
    expect(namedParametersOf("SELECT * FROM t WHERE a = 'http://x' AND b = :real")).toEqual([
      'real',
    ]);
  });
});

describe('running a statement', () => {
  it('stores an absent optional value as NULL', () => {
    const db = openDatabase(':memory:');

    query(
      db,
      `INSERT INTO locations (geonames_id, name, country_code, latitude, longitude, timezone, created_at)
       VALUES (:geonamesId, :name, :countryCode, :latitude, :longitude, :timezone, :createdAt)`,
    ).run({
      geonamesId: 1,
      name: 'Nowhere',
      countryCode: undefined,
      latitude: 0,
      longitude: 0,
      timezone: 'UTC',
      createdAt: '2026-09-14T00:00:00.000Z',
    });

    expect(
      query<{ country_code: string | null }>(
        db,
        'SELECT country_code FROM locations WHERE geonames_id = 1',
      ).get()?.country_code,
    ).toBeNull();

    db.close();
  });

  it('refuses a params object that is missing a name the SQL asks for', () => {
    // The driver binds the missing one to NULL silently, so a renamed field would become
    // quiet data loss rather than an error.
    const db = openDatabase(':memory:');
    const insert = query(
      db,
      `INSERT INTO locations (geonames_id, name, latitude, longitude, timezone, created_at)
       VALUES (:geonamesId, :name, :latitude, :longitude, :timezone, :createdAt)`,
    );

    expect(() =>
      insert.run({
        geonamesId: 1,
        nmae: 'typo',
        latitude: 0,
        longitude: 0,
        timezone: 'UTC',
        createdAt: '2026-09-14T00:00:00.000Z',
      }),
    ).toThrow(/missing parameter :name/);

    db.close();
  });

  it('converts positional parameters too, not just named ones', () => {
    const db = openDatabase(':memory:');
    query(
      db,
      `INSERT INTO locations (geonames_id, name, country_code, latitude, longitude, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'Nowhere', undefined, 0, 0, 'UTC', new Date('2026-09-14T00:00:00.000Z'));

    const stored = query<{ country_code: string | null; created_at: string }>(
      db,
      'SELECT country_code, created_at FROM locations WHERE geonames_id = 1',
    ).get();

    expect(stored?.country_code).toBeNull();
    expect(stored?.created_at).toBe('2026-09-14T00:00:00.000Z');

    db.close();
  });

  it('reports how many rows changed', () => {
    const db = openDatabase(':memory:');
    const insert = query(
      db,
      `INSERT INTO locations (geonames_id, name, latitude, longitude, timezone, created_at)
       VALUES (?, ?, 0, 0, 'UTC', '2026-09-14T00:00:00.000Z')`,
    );

    expect(insert.run(1, 'A')).toBe(1);
    insert.run(2, 'B');
    expect(query(db, 'DELETE FROM locations').run()).toBe(2);

    db.close();
  });
});

describe('migrating', () => {
  it('runs each migration once, however many times it is asked', () => {
    const db = openDatabase(':memory:', { appliedAt: '2026-09-14T00:00:00.000Z' });

    // The first run happened inside openDatabase; these must be no-ops rather than
    // "table already exists" failures.
    expect(migrate(db, '2026-09-15T00:00:00.000Z')).toEqual([]);
    expect(migrate(db, '2026-09-16T00:00:00.000Z')).toEqual([]);

    const applied = query<{ applied_at: string }>(db, 'SELECT applied_at FROM schema_migrations').all();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.applied_at).toBe('2026-09-14T00:00:00.000Z');

    db.close();
  });

  it('reports what it applied on a fresh database', () => {
    const db = openDatabase(':memory:');
    db.exec('DROP TABLE forecast_snapshots');
    db.exec('DROP TABLE location_queries');
    db.exec('DROP TABLE locations');
    db.exec('DELETE FROM schema_migrations');

    expect(migrate(db, '2026-09-14T00:00:00.000Z')).toEqual(['001_init']);

    db.close();
  });

  it('rolls a migration back whole when one of its later statements fails', () => {
    const db = openDatabase(':memory:');

    // Creates one table, then collides with an existing one. Without a transaction the
    // first table would survive and the schema would be left in a state no migration
    // describes.
    expect(() =>
      migrate(db, '2026-09-14T00:00:00.000Z', [
        {
          name: '002_half_broken',
          sql: 'CREATE TABLE half_done (x INTEGER); CREATE TABLE locations (y INTEGER);',
        },
      ]),
    ).toThrow();

    const tables = query<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    expect(tables).not.toContain('half_done');

    const applied = query<{ name: string }>(db, 'SELECT name FROM schema_migrations').all().map((row) => row.name);
    expect(applied).not.toContain('002_half_broken');

    db.close();
  });

  it('refuses to re-apply over a schema that is already there', () => {
    const db = openDatabase(':memory:');
    db.exec('DELETE FROM schema_migrations');

    expect(() => migrate(db, '2026-09-14T00:00:00.000Z')).toThrow();

    db.close();
  });
});

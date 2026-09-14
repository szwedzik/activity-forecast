/**
 * Opening the database, keeping its schema current, and the one path every statement
 * binds through (D§5.1).
 *
 * `node:sqlite` is built into Node 22.13 and later, so there is no native build step and
 * nothing to install; the cost is that an older Node cannot run this at all, which the
 * README states (D-002).
 */
import { DatabaseSync } from 'node:sqlite';

import * as initial from './migrations/001_init.js';

export type Database = DatabaseSync;

/** What SQLite can actually hold. Everything else is converted or refused (D-018). */
export type Bindable = null | number | string | bigint | Uint8Array;

/**
 * The driver's handling of a value it does not like is uneven: `undefined`, booleans and
 * symbols throw, but a `Date`, a `NaN` and an `Infinity` are all stored as NULL without a
 * word. A silent NULL in a nullable column is data loss you find out about much later, so
 * everything is normalised here instead (D-018).
 */
export function toBindable(value: unknown, where: string): Bindable {
  if (value === undefined || value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'bigint':
      return value;
    case 'number':
      // NaN and Infinity have no SQLite representation; the driver stores NULL for both.
      if (!Number.isFinite(value)) throw new TypeError(`${where}: ${value} cannot be stored`);
      return value;
    case 'boolean':
      // SQLite has no boolean type; 0 and 1 are the convention, and the driver refuses
      // the raw value.
      return value ? 1 : 0;
    default:
      break;
  }

  // Our instants are ISO-8601 UTC strings, which is exactly what this produces, so a
  // caller who passes the Date itself gets what they meant rather than a NULL.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${where}: invalid Date`);
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return value;

  throw new TypeError(`${where}: cannot store a value of type ${typeof value}`);
}

const NAMED_PARAMETER = /(?<![:\w])[:@$]([A-Za-z_]\w*)/g;

/** The `:names` a statement expects, so a params object missing one is caught. */
export function namedParametersOf(sql: string): string[] {
  const withoutLiterals = sql.replace(/'[^']*'/g, "''").replace(/--[^\n]*/g, '');
  return [...new Set([...withoutLiterals.matchAll(NAMED_PARAMETER)].map(([, name]) => name ?? ''))];
}

function isNamedParameters(params: readonly unknown[]): params is [Record<string, unknown>] {
  const [first] = params;
  return (
    params.length === 1 &&
    typeof first === 'object' &&
    first !== null &&
    !(first instanceof Date) &&
    !(first instanceof Uint8Array) &&
    !Array.isArray(first)
  );
}

/**
 * A prepared statement with every value normalised on the way in.
 *
 * Repositories use this rather than the raw statement, so there is one place that knows
 * what SQLite can hold and one place that casts the rows coming back.
 */
export interface Query<Row> {
  readonly sql: string;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  /** Rows changed. */
  run(...params: unknown[]): number;
}

type Bound =
  | { readonly kind: 'named'; readonly params: Record<string, Bindable> }
  | { readonly kind: 'positional'; readonly params: Bindable[] };

export function query<Row>(db: Database, sql: string): Query<Row> {
  const statement = db.prepare(sql);
  const expected = namedParametersOf(sql);

  const bind = (params: readonly unknown[]): Bound => {
    if (!isNamedParameters(params)) {
      return {
        kind: 'positional',
        params: params.map((value, index) => toBindable(value, `parameter ${index + 1}`)),
      };
    }

    const [given] = params;
    const bound: Record<string, Bindable> = {};
    for (const name of expected) {
      // The driver binds a missing name to NULL without complaining, which turns a
      // renamed field into silent data loss. An absent key is a bug; an explicit
      // undefined is a value.
      if (!(name in given)) throw new TypeError(`missing parameter :${name}`);
      bound[name] = toBindable(given[name], `:${name}`);
    }
    return { kind: 'named', params: bound };
  };

  const call = <Result>(
    named: (params: Record<string, Bindable>) => Result,
    positional: (...params: Bindable[]) => Result,
    params: readonly unknown[],
  ): Result => {
    const bound = bind(params);
    return bound.kind === 'named' ? named(bound.params) : positional(...bound.params);
  };

  return {
    sql,
    get: (...params) =>
      call(
        (named) => statement.get(named),
        (...positional) => statement.get(...positional),
        params,
      ) as Row | undefined,
    all: (...params) =>
      call(
        (named) => statement.all(named),
        (...positional) => statement.all(...positional),
        params,
      ) as Row[],
    run: (...params) =>
      Number(
        call(
          (named) => statement.run(named),
          (...positional) => statement.run(...positional),
          params,
        ).changes,
      ),
  };
}

/** SQLite has no undefined; a column that holds nothing holds null. */
export const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [initial];

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

export interface OpenOptions {
  /** Recorded against each migration this run applies. */
  readonly appliedAt?: string;
}

/**
 * Apply whatever has not been applied yet. Each migration runs inside its own
 * transaction, so a failure leaves the schema where it was rather than half-changed,
 * and running this twice is a no-op.
 */
export function migrate(
  db: Database,
  appliedAt: string,
  migrations: readonly Migration[] = MIGRATIONS,
): string[] {
  db.exec(MIGRATIONS_TABLE);

  const applied = new Set(
    query<{ name: string }>(db, 'SELECT name FROM schema_migrations')
      .all()
      .map((row) => row.name),
  );
  const ran: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      query(db, 'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        appliedAt,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    ran.push(migration.name);
  }

  return ran;
}

export function openDatabase(path: string, options: OpenOptions = {}): Database {
  const db = new DatabaseSync(path);

  // Referential integrity is off by default in SQLite, which would quietly allow a
  // snapshot pointing at a location that does not exist.
  db.exec('PRAGMA foreign_keys = ON');
  // WAL lets the background refresher write while a request reads. SQLite ignores it for
  // an in-memory database, which has no file to write the log beside, so there is nothing
  // to branch on.
  db.exec('PRAGMA journal_mode = WAL');

  migrate(db, options.appliedAt ?? new Date().toISOString());
  return db;
}

import { resolve } from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

/**
 * int8 (bigint, OID 20) comes back from node-postgres as a string by default,
 * because it can exceed 2^53. Everything this app stores in a bigint is a Unix
 * timestamp in seconds, and COUNT() also returns int8 — all far below 2^53 —
 * so parse them as plain numbers to keep the API's JSON types unchanged.
 * Registered globally, before the pool hands out any connection.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // loadConfig() in lib/env.ts reports this first on a normal start; this guard
  // covers scripts that import the client directly.
  throw new Error('DATABASE_URL is required (e.g. postgres://dtkb:<password>@localhost:5432/dtkb)');
}

/**
 * The process-wide connection pool. Small on purpose: a single-user app on the
 * same host as Postgres rarely has more than a couple of requests in flight.
 * Connections are opened lazily, so importing this module touches nothing.
 */
export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

// An idle client can error out (Postgres restarted, network blip). Without a
// listener the pool re-emits it as an uncaught 'error' and the process dies;
// the pool already discards the broken client, so logging is enough.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/** Drizzle over the same pool — used for migrations; routes use raw SQL. */
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * All rows of a query, typed by the caller's snake_case Row interface (rows are
 * not validated — the SQL's column list is the contract). Placeholders are
 * $1, $2, …
 */
export async function many<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  conn: Queryable = pool,
): Promise<T[]> {
  return (await conn.query(text, params)).rows as T[];
}

/** The first row of a query, or undefined. */
export async function one<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  conn: Queryable = pool,
): Promise<T | undefined> {
  return (await conn.query(text, params)).rows[0] as T | undefined;
}

/** Run a statement and return how many rows it affected. */
export async function exec(
  text: string,
  params: unknown[] = [],
  conn: Queryable = pool,
): Promise<number> {
  return (await conn.query(text, params)).rowCount ?? 0;
}

/**
 * Run fn inside a transaction on one checked-out client: BEGIN, COMMIT on
 * success, ROLLBACK (and rethrow) on any error. The client is always released.
 * Every query in fn must go through the client it is given — a query on the
 * pool would run on another connection, outside the transaction.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection itself is broken; the original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply pending migrations from db/migrations (index.ts pins the working
 * directory to server/). The ledger lives in public.__drizzle_migrations — the
 * same place drizzle.config.cjs points `npm run db:migrate` at.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, {
    migrationsFolder: resolve('./db/migrations'),
    migrationsSchema: 'public',
    migrationsTable: '__drizzle_migrations',
  });
}

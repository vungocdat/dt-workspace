// CommonJS config for drizzle-kit — an ESM drizzle.config.ts triggers a
// "require is not defined" error because server/ has "type":"module".
// drizzle-kit always loads .cjs files as CommonJS regardless of that setting.
const path = require('path');

// Same .env the server reads (repo root). Only db:migrate needs the URL;
// db:generate works offline from db/schema.ts.
require('dotenv').config({ path: path.join(__dirname, '../.env') });

module.exports = {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Keep the ledger where the server's own migrator (db/client.ts) writes it,
  // so `db:migrate` and a server start agree on what has been applied.
  migrations: { schema: 'public', table: '__drizzle_migrations' },
};

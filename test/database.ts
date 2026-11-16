/**
 * Database tests need a real PostgreSQL (DATABASE_URL). Locally they are
 * skipped when it is not set; in CI a missing database is a failure, so the
 * suite can never go green by silently skipping.
 */
export const databaseUrl = process.env['DATABASE_URL'];

if (process.env['CI'] && !databaseUrl) {
  throw new Error('DATABASE_URL must be set in CI: database tests may not be skipped');
}

export const hasDatabase = Boolean(databaseUrl);

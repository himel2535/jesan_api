import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// The Prisma CLI does not load .env by itself; Node's built-in loader avoids an extra dependency.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Migrations need a direct (non-pooled) connection. DIRECT_URL is used when set;
// otherwise DATABASE_URL (locally both point at the same database).
// `prisma generate` needs no database, so the URL may be absent.
const url = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.mjs',
  },
  ...(url ? { datasource: { url } } : {}),
});

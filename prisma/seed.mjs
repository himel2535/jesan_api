// Base data only: default roles and the first business. No users or passwords.
// Idempotent: existing rows are never changed, so it is safe to run repeatedly.
// Plain JavaScript on purpose, so it runs with `node` alone (no TypeScript runner).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Seed needs DIRECT_URL or DATABASE_URL to be set.');
  process.exit(1);
}

/** UUID v7 (time-ordered), matching the ids Prisma generates for these tables. */
function uuidv7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const roles = [
  { key: 'owner', nameEn: 'Owner', nameBn: 'মালিক' },
  { key: 'manager', nameEn: 'Manager', nameBn: 'ম্যানেজার' },
  { key: 'accountant', nameEn: 'Accountant', nameBn: 'হিসাবরক্ষক' },
  { key: 'salesman', nameEn: 'Salesman', nameBn: 'বিক্রয়কর্মী' },
];

const businesses = [
  {
    slug: 'akij-cement',
    nameEn: 'Akij Cement',
    nameBn: 'আকিজ সিমেন্ট',
    type: 'dealership',
    config: {
      unit: { key: 'bag', nameEn: 'Bag', nameBn: 'বস্তা', decimals: 0 },
      principalSupplier: { nameEn: 'Akij Cement', nameBn: 'আকিজ সিমেন্ট' },
    },
  },
];

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  let created = 0;
  for (const [index, role] of roles.entries()) {
    const result = await client.query(
      `INSERT INTO roles (id, key, name_en, name_bn, is_system, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, true, $5, now())
       ON CONFLICT (key) DO NOTHING`,
      [uuidv7(), role.key, role.nameEn, role.nameBn, index + 1],
    );
    created += result.rowCount ?? 0;
  }
  for (const [index, business] of businesses.entries()) {
    const result = await client.query(
      `INSERT INTO businesses (id, slug, name_en, name_bn, type, config, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (slug) DO NOTHING`,
      [
        uuidv7(),
        business.slug,
        business.nameEn,
        business.nameBn,
        business.type,
        JSON.stringify(business.config),
        index + 1,
      ],
    );
    created += result.rowCount ?? 0;
  }
  await client.query('COMMIT');
  console.log(`Seed finished: ${String(created)} row(s) created, existing rows left untouched.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

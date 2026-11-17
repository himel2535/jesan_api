// Base data only: default roles, the first business and its principal supplier.
// No users or passwords, and no sample data (that is prisma/seed-dev.mjs).
// Idempotent: existing rows are never changed, so it is safe to run repeatedly.
// Plain JavaScript on purpose, so it runs with `node` alone (no TypeScript runner).
import { connect, formatCode, nextNumber, prefixFor, uuidv7 } from './seed-helpers.mjs';

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
      units: [{ key: 'bag', nameEn: 'Bag', nameBn: 'বস্তা', decimals: 0 }],
      defaultUnit: 'bag',
      codePrefixes: { product: 'P', customer: 'C', supplier: 'S' },
      principalSupplier: { nameEn: 'Akij Cement', nameBn: 'আকিজ সিমেন্ট' },
    },
  },
];

const client = await connect('Seed');
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

  // Each dealership's principal supplier, taken from its config (one per business).
  const dealerships = await client.query(
    `SELECT b.id, b.config FROM businesses b
     WHERE b.type = 'dealership'
       AND b.config ? 'principalSupplier'
       AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.business_id = b.id AND s.is_principal)`,
  );
  for (const business of dealerships.rows) {
    const principal = business.config.principalSupplier;
    const number = await nextNumber(client, business.id, 'supplier');
    await client.query(
      `INSERT INTO suppliers (id, business_id, code, name_en, name_bn, is_principal, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, now())`,
      [
        uuidv7(),
        business.id,
        formatCode(prefixFor(business.config, 'supplier', 'S'), number, 3),
        principal.nameEn,
        principal.nameBn ?? principal.nameEn,
      ],
    );
    created += 1;
  }

  await client.query('COMMIT');
  console.log(`Seed finished: ${String(created)} row(s) created, existing rows left untouched.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

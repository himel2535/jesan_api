// Shared helpers for the seed scripts (plain JavaScript, run with `node`).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';

/** Loads .env (if present) and connects with DIRECT_URL or DATABASE_URL. */
export async function connect(scriptName) {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${scriptName} needs DIRECT_URL or DATABASE_URL to be set.`);
    process.exit(1);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/** UUID v7 (time-ordered), matching the ids Prisma generates. */
export function uuidv7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same atomic counter the API uses (src/core/numbering). */
export async function nextNumber(client, businessId, docType, period = 0) {
  const result = await client.query(
    `INSERT INTO document_counters (business_id, doc_type, period, last_value, updated_at)
     VALUES ($1, $2, $3, 1, now())
     ON CONFLICT (business_id, doc_type, period)
     DO UPDATE SET last_value = document_counters.last_value + 1, updated_at = now()
     RETURNING last_value`,
    [businessId, docType, period],
  );
  return Number(result.rows[0].last_value);
}

export function formatCode(prefix, value, width) {
  return `${prefix}-${String(value).padStart(width, '0')}`;
}

/** Code prefix from a business config, as the API reads it. */
export function prefixFor(config, kind, fallback) {
  const value = config?.codePrefixes?.[kind];
  return typeof value === 'string' && /^[A-Z][A-Z0-9]{0,5}$/.test(value) ? value : fallback;
}

/**
 * The expense kinds a dealership starts with when its config names none. Kept
 * business-neutral on purpose: a business that wants other kinds puts them in
 * `config.defaultExpenseCategories`, and the owner can rename or deactivate
 * any of them afterwards.
 */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { nameEn: 'Salary', nameBn: 'বেতন' },
  { nameEn: 'Rent', nameBn: 'ভাড়া' },
  { nameEn: 'Electricity', nameBn: 'বিদ্যুৎ' },
  { nameEn: 'Vehicle and fuel', nameBn: 'যানবাহন ও জ্বালানি' },
  { nameEn: 'Hospitality', nameBn: 'আপ্যায়ন' },
  { nameEn: 'Other', nameBn: 'অন্যান্য' },
];

/** The starting expense kinds of a business: its config's list, or the default. */
export function expenseCategoriesFor(config) {
  const listed = Array.isArray(config?.defaultExpenseCategories)
    ? config.defaultExpenseCategories
        .filter((item) => item && typeof item.nameEn === 'string' && item.nameEn.trim() !== '')
        .map((item) => ({
          nameEn: item.nameEn.trim(),
          nameBn:
            typeof item.nameBn === 'string' && item.nameBn.trim() !== ''
              ? item.nameBn.trim()
              : item.nameEn.trim(),
        }))
    : [];
  return listed.length > 0 ? listed : DEFAULT_EXPENSE_CATEGORIES;
}

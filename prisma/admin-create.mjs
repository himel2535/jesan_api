// Creates the first platform owner. Run once: `npm run admin:create`.
//
// Reads ADMIN_EMAIL and/or ADMIN_PHONE, ADMIN_PASSWORD and ADMIN_NAME from the
// environment (or .env). The password is never printed, logged or stored anywhere
// except as an argon2id hash. If the user already exists nothing is changed.
// Plain JavaScript so it runs with `node` alone.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import pg from 'pg';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

function fail(message) {
  console.error(`admin:create: ${message}`);
  process.exit(1);
}

/** Same rules as the API: lowercase email, E.164 phone (01XXXXXXXXX works). */
function normalizePhone(value) {
  const compact = value.replace(/[\s\-().]/g, '');
  let candidate = compact;
  if (/^01\d{9}$/.test(compact)) candidate = `+880${compact.slice(1)}`;
  else if (/^8801\d{9}$/.test(compact)) candidate = `+${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

/** UUID v7 (time-ordered), like the ids Prisma generates. */
function uuidv7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() || null;
const phoneInput = process.env.ADMIN_PHONE?.trim();
const phone = phoneInput ? normalizePhone(phoneInput) : null;
const password = process.env.ADMIN_PASSWORD ?? '';
const name = process.env.ADMIN_NAME?.trim() || 'Owner';

if (phoneInput && !phone) fail('ADMIN_PHONE is not a valid phone number');
if (!email && !phone) fail('set ADMIN_EMAIL or ADMIN_PHONE (or both)');
if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('ADMIN_EMAIL is not a valid email');
if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
  fail(`ADMIN_PASSWORD must be ${String(MIN_LENGTH)} to ${String(MAX_LENGTH)} characters`);
}
if ([email, phone].some((value) => value && value.toLowerCase() === password.toLowerCase())) {
  fail('ADMIN_PASSWORD must not be the email or phone number');
}

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) fail('DIRECT_URL or DATABASE_URL must be set');

// Same parameters as the API (OWASP minimum for argon2id).
const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const existing = await client.query(
    'SELECT is_platform_owner FROM users WHERE email = $1 OR phone = $2 LIMIT 1',
    [email, phone],
  );
  if (existing.rowCount) {
    console.log(
      existing.rows[0].is_platform_owner
        ? 'A platform owner with this email or phone already exists. Nothing changed.'
        : 'A user with this email or phone already exists but is not a platform owner. Nothing changed.',
    );
  } else {
    await client.query(
      `INSERT INTO users (id, email, phone, name, password_hash, is_platform_owner, password_changed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, now(), now())`,
      [uuidv7(), email, phone, name, passwordHash],
    );
    console.log(`Platform owner created: ${email ?? phone}`);
    console.log('Remove ADMIN_PASSWORD from your .env now; it is not needed again.');
  }
} finally {
  await client.end();
}

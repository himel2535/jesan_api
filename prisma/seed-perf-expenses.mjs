// Expense and cash-book performance data, for a throw-away perf database
// only: `npm run db:seed:perf:expenses`. Refuses production. Adds expense
// categories and 50,000 expenses, spread over ~3 years, to a business that
// already has orders, deliveries, purchases and collections (normally
// "perf-sales" or "perf-dealer", named via PERF_SLUG). Fake data only.
import { connect } from './seed-helpers.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('db:seed:perf:expenses refuses to run in production.');
  process.exit(1);
}

const SLUG = process.env.PERF_SLUG ?? 'perf-sales';
const EXPENSES = 50_000;
const CATEGORY_NAMES = [
  'Salary',
  'Rent',
  'Electricity',
  'Vehicle and fuel',
  'Hospitality',
  'Other',
];
const METHODS = ['cash', 'bkash', 'nagad', 'bank', 'cheque'];

const client = await connect('db:seed:perf:expenses');
const started = Date.now();
const step = async (label, sql, params = []) => {
  const t0 = Date.now();
  const result = await client.query(sql, params);
  console.log(`${label}: ${String(result.rowCount ?? '')} rows, ${String(Date.now() - t0)} ms`);
  return result;
};

try {
  const business = await client.query('SELECT id FROM businesses WHERE slug = $1', [SLUG]);
  if (!business.rowCount) {
    throw new Error(`Business "${SLUG}" not found. Run its own perf seed first.`);
  }
  const bid = business.rows[0].id;
  if (
    (await client.query('SELECT 1 FROM expenses WHERE business_id = $1 LIMIT 1', [bid])).rowCount
  ) {
    console.log(`${SLUG} already has expenses; nothing to do.`);
    process.exit(0);
  }
  const actor = await client.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
  if (!actor.rowCount) throw new Error('Create a user first (npm run admin:create).');
  const actorId = actor.rows[0].id;

  await client.query('BEGIN');
  await step(
    'expense categories',
    `INSERT INTO expense_categories (id, business_id, name_en, name_bn, sort_order, updated_at)
    SELECT gen_random_uuid(), $1, name, name, n, now()
      FROM unnest($2::text[]) WITH ORDINALITY AS t(name, n)
     ON CONFLICT (business_id, name_en) DO NOTHING`,
    [bid, CATEGORY_NAMES],
  );
  await client.query(
    `CREATE TEMP TABLE pec ON COMMIT DROP AS
    SELECT id, row_number() OVER (ORDER BY sort_order) AS n FROM expense_categories WHERE business_id = $1`,
    [bid],
  );
  await step(
    'expenses',
    `INSERT INTO expenses (id, business_id, code, expense_date, category_id, method, amount,
      note, status, created_by, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'EXP-' || lpad(g::text, 6, '0'),
           date '2024-01-01' + (g * 1000 / ${EXPENSES}), pec.id,
           (ARRAY['cash','bkash','nagad','bank','cheque'])[1 + g % 5],
           round((200 + (g % 5000))::numeric, 2), 'Perf expense ' || g, 'active', $2,
           timestamp '2024-01-01' + g * interval '12 minutes', now()
      FROM generate_series(1, ${EXPENSES}) g
      JOIN pec ON pec.n = (g % 6) + 1`,
    [bid, actorId],
  );
  await step(
    'counter',
    `INSERT INTO document_counters (business_id, doc_type, period, last_value, updated_at)
    VALUES ($1, 'expense', 0, ${EXPENSES}, now())
    ON CONFLICT (business_id, doc_type, period)
    DO UPDATE SET last_value = ${EXPENSES}, updated_at = now()`,
    [bid],
  );
  await client.query('COMMIT');
  await client.query('ANALYZE');
  console.log(
    `Expenses perf seed finished in ${String(Math.round((Date.now() - started) / 1000))} s.`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

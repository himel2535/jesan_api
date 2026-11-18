// Performance data, for a throw-away perf database only: `npm run db:seed:perf`.
// Refuses production. Creates one business "perf-dealer" (no users) with 300
// products, 100,000 cash purchases (200,000 lines) and 1,000,000 stock
// movements (purchases plus small +1/-1 adjustments), with balances, current
// stock, last purchase prices and monthly counters all consistent, so
// `npm run stock:check` passes. Fake names only, no real business data.
import { connect } from './seed-helpers.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('db:seed:perf refuses to run in production.');
  process.exit(1);
}

const SLUG = 'perf-dealer';
const PRODUCTS = 300;
const PURCHASES = 100_000;
const MOVEMENTS = 1_000_000;

const client = await connect('db:seed:perf');
const started = Date.now();
const step = async (label, sql, params = []) => {
  const t0 = Date.now();
  const result = await client.query(sql, params);
  console.log(`${label}: ${String(result.rowCount ?? '')} rows, ${String(Date.now() - t0)} ms`);
  return result;
};

try {
  const exists = await client.query('SELECT 1 FROM businesses WHERE slug = $1', [SLUG]);
  if (exists.rowCount) {
    console.log(`${SLUG} already exists; nothing to do.`);
    process.exit(0);
  }
  await client.query('BEGIN');
  // Any user can own the rows' created_by; perf data needs one.
  const actor = await client.query(
    `SELECT id FROM users ORDER BY created_at LIMIT 1`,
  );
  if (!actor.rowCount) {
    throw new Error('Create a user first (npm run admin:create) so rows have a creator.');
  }
  const actorId = actor.rows[0].id;
  const business = await step(
    'business',
    `INSERT INTO businesses (id, slug, name_en, name_bn, type, config, updated_at)
     VALUES (gen_random_uuid(), $1, 'Perf Dealer', 'পারফ ডিলার', 'dealership',
             '{"units":[{"key":"bag","nameEn":"Bag","nameBn":"বস্তা","decimals":0}],"defaultUnit":"bag"}', now())
     RETURNING id`,
    [SLUG],
  );
  const bid = business.rows[0].id;
  await step(
    'supplier',
    `INSERT INTO suppliers (id, business_id, code, name_en, name_bn, is_principal, updated_at)
     VALUES (gen_random_uuid(), $1, 'S-001', 'Perf Supplier', 'পারফ সরবরাহকারী', true, now())`,
    [bid],
  );
  await step(
    'category',
    `INSERT INTO product_categories (id, business_id, name_en, name_bn, updated_at)
     VALUES (gen_random_uuid(), $1, 'Perf', 'পারফ', now())`,
    [bid],
  );
  await step(
    'products',
    `INSERT INTO products (id, business_id, code, category_id, name_en, name_bn, unit_key, updated_at)
     SELECT gen_random_uuid(), $1, 'P-' || lpad(g::text, 4, '0'),
            (SELECT id FROM product_categories WHERE business_id = $1),
            'Perf Cement ' || g, 'পারফ সিমেন্ট ' || g, 'bag', now()
       FROM generate_series(1, ${PRODUCTS}) g`,
    [bid],
  );
  await client.query(`CREATE TEMP TABLE perf_products ON COMMIT DROP AS
    SELECT id, row_number() OVER (ORDER BY code) AS n FROM products WHERE business_id = $1`, [bid]);

  // Purchases spread over ~3 years, two lines each.
  await step(
    'purchases',
    `INSERT INTO purchases (id, business_id, code, supplier_id, purchase_date, payment_method,
                            total_quantity, total_amount, created_by, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'PUR-' || lpad(g::text, 6, '0'),
            (SELECT id FROM suppliers WHERE business_id = $1),
            date '2024-01-01' + (g * 1000 / ${PURCHASES}),
            'cash', 1, 0, $2, -- real totals set below
            timestamp '2024-01-01' + g * interval '15 minutes', now()
       FROM generate_series(1, ${PURCHASES}) g`,
    [bid, actorId],
  );
  await step(
    'purchase lines',
    `INSERT INTO purchase_items (id, business_id, purchase_id, product_id, quantity, unit_price,
                                 line_total, purchase_date, created_at, updated_at)
     SELECT gen_random_uuid(), $1, p.id, pp.id, q.quantity, q.price,
            round(q.quantity * q.price, 2), p.purchase_date, p.created_at, now()
       FROM (SELECT id, purchase_date, created_at, row_number() OVER (ORDER BY created_at) AS n
               FROM purchases WHERE business_id = $1) p
       CROSS JOIN LATERAL (VALUES (0), (1)) AS line(k)
       JOIN perf_products pp ON pp.n = ((p.n * 2 + line.k) % ${PRODUCTS}) + 1
       CROSS JOIN LATERAL (SELECT (100 + (p.n % 400))::numeric AS quantity,
                                  (540 + (p.n % 40))::numeric AS price) q`,
    [bid],
  );
  await step(
    'purchase totals',
    `UPDATE purchases pu SET total_quantity = t.q, total_amount = t.a
       FROM (SELECT purchase_id, sum(quantity) q, sum(line_total) a FROM purchase_items
              WHERE business_id = $1 GROUP BY purchase_id) t
      WHERE pu.id = t.purchase_id AND pu.business_id = $1`,
    [bid],
  );

  // Movements: one per purchase line, then +1/-1 adjustments to reach the total.
  const adjustments = MOVEMENTS - PURCHASES * 2;
  await client.query(`CREATE TEMP TABLE perf_moves ON COMMIT DROP AS
    SELECT i.product_id, 'purchase'::text AS kind, i.quantity, i.purchase_date AS movement_date,
           'purchase'::text AS source_type, i.purchase_id AS source_id, NULL::text AS reason,
           i.created_at
      FROM purchase_items i WHERE i.business_id = $1
    UNION ALL
    SELECT pp.id, 'adjustment', CASE WHEN g % 2 = 1 THEN 1 ELSE -1 END,
           date '2024-01-01' + (g * 1000 / ${adjustments}), 'adjustment', NULL, 'perf adjustment',
           timestamp '2024-01-01' + g * interval '90 seconds' + interval '1 second'
      FROM generate_series(1, ${adjustments}) g
      JOIN perf_products pp ON pp.n = ((g + 1) / 2 % ${PRODUCTS}) + 1`, [bid]);
  await step(
    'stock movements',
    `INSERT INTO stock_movements (id, business_id, product_id, kind, quantity, balance_after,
                                  movement_date, source_type, source_id, reason, created_by, created_at)
     SELECT gen_random_uuid(), $1, product_id, kind, quantity,
            sum(quantity) OVER (PARTITION BY product_id ORDER BY created_at, kind
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
            movement_date, source_type, source_id, reason, $2, created_at
       FROM perf_moves`,
    [bid, actorId],
  );
  await step(
    'current stock and last purchase price',
    `UPDATE products p SET
            current_stock = coalesce((SELECT sum(quantity) FROM stock_movements m
                                       WHERE m.business_id = p.business_id AND m.product_id = p.id), 0),
            (last_purchase_price, last_purchased_at) = (
              SELECT i.unit_price, (i.purchase_date::timestamp AT TIME ZONE 'Asia/Dhaka')
                FROM purchase_items i
               WHERE i.business_id = p.business_id AND i.product_id = p.id AND i.status = 'active'
               ORDER BY i.purchase_date DESC, i.created_at DESC, i.id DESC LIMIT 1)
      WHERE p.business_id = $1`,
    [bid],
  );
  await step(
    'monthly counters',
    `INSERT INTO monthly_purchase_counters (business_id, period, quantity, updated_at)
     SELECT $1, (extract(year FROM purchase_date) * 100 + extract(month FROM purchase_date))::int,
            sum(quantity), now()
       FROM purchase_items WHERE business_id = $1 GROUP BY 2`,
    [bid],
  );
  await step(
    'document counter',
    `INSERT INTO document_counters (business_id, doc_type, period, last_value, updated_at)
     VALUES ($1, 'purchase', 0, ${PURCHASES}, now()), ($1, 'product', 0, ${PRODUCTS}, now())`,
    [bid],
  );
  await client.query('COMMIT');
  await client.query('ANALYZE');
  console.log(`Perf seed finished in ${String(Math.round((Date.now() - started) / 1000))} s.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

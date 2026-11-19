// Sales performance data, for a throw-away perf database only:
// `npm run db:seed:perf:sales`. Refuses production. Creates one business
// "perf-sales" (no users) with 100 products, 2,000 customers, 100,000 orders,
// 100,000 deliveries and 100,000 collections, with stock, balances, ledger and
// summaries all consistent (`npm run consistency:check` passes). Fake names only.
import { connect } from './seed-helpers.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('db:seed:perf:sales refuses to run in production.');
  process.exit(1);
}

const SLUG = 'perf-sales';
const PRODUCTS = 100;
const CUSTOMERS = 2_000;
const ORDERS = 100_000;

const client = await connect('db:seed:perf:sales');
const started = Date.now();
const step = async (label, sql, params = []) => {
  const t0 = Date.now();
  const result = await client.query(sql, params);
  console.log(`${label}: ${String(result.rowCount ?? '')} rows, ${String(Date.now() - t0)} ms`);
  return result;
};

try {
  if ((await client.query('SELECT 1 FROM businesses WHERE slug = $1', [SLUG])).rowCount) {
    console.log(`${SLUG} already exists; nothing to do.`);
    process.exit(0);
  }
  const actor = await client.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
  if (!actor.rowCount) throw new Error('Create a user first (npm run admin:create).');
  const actorId = actor.rows[0].id;
  await client.query('BEGIN');
  const bid = (
    await step(
      'business',
      `INSERT INTO businesses (id, slug, name_en, name_bn, type, config, updated_at)
       VALUES (gen_random_uuid(), $1, 'Perf Sales', 'পারফ বিক্রি', 'dealership',
               '{"units":[{"key":"bag","nameEn":"Bag","nameBn":"বস্তা","decimals":0}],"defaultUnit":"bag"}', now())
       RETURNING id`,
      [SLUG],
    )
  ).rows[0].id;
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
           (SELECT id FROM product_categories WHERE business_id = $1), 'Perf Cement ' || g, 'পারফ ' || g, 'bag', now()
      FROM generate_series(1, ${PRODUCTS}) g`,
    [bid],
  );
  await step(
    'customers',
    `INSERT INTO customers (id, business_id, code, name_en, phone, opening_balance, current_balance, updated_at)
    SELECT gen_random_uuid(), $1, 'C-' || lpad(g::text, 5, '0'), 'Perf Shop ' || g,
           '+8801000' || lpad(g::text, 6, '0'), 0, 0, now()
      FROM generate_series(1, ${CUSTOMERS}) g`,
    [bid],
  );
  await client.query(
    `CREATE TEMP TABLE pp ON COMMIT DROP AS
    SELECT id, row_number() OVER (ORDER BY code) AS n FROM products WHERE business_id = $1`,
    [bid],
  );
  await client.query(
    `CREATE TEMP TABLE pc ON COMMIT DROP AS
    SELECT id, row_number() OVER (ORDER BY code) AS n FROM customers WHERE business_id = $1`,
    [bid],
  );

  // One-line orders over ~3 years; every order fully delivered the same day.
  await step(
    'orders',
    `INSERT INTO sales_orders (id, business_id, code, customer_id, order_date, delivery_window,
      total_quantity, delivered_quantity, total_amount, delivery_status, created_by, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'ORD-' || lpad(g::text, 6, '0'), pc.id,
           date '2024-01-01' + (g * 1000 / ${ORDERS}), 'two_days',
           (10 + g % 90), (10 + g % 90), (10 + g % 90) * (555 + g % 20), 'delivered', $2,
           timestamp '2024-01-01' + g * interval '15 minutes', now()
      FROM generate_series(1, ${ORDERS}) g
      JOIN pc ON pc.n = (g % ${CUSTOMERS}) + 1`,
    [bid, actorId],
  );
  await client.query(
    `CREATE TEMP TABLE po ON COMMIT DROP AS
    SELECT id, customer_id, order_date, total_quantity, total_amount, created_at,
           row_number() OVER (ORDER BY created_at) AS n
      FROM sales_orders WHERE business_id = $1`,
    [bid],
  );
  await step(
    'order lines',
    `INSERT INTO sales_order_items (id, business_id, order_id, product_id, quantity,
      delivered_quantity, unit_price, line_total, created_at, updated_at)
    SELECT gen_random_uuid(), $1, po.id, pp.id, po.total_quantity, po.total_quantity,
           po.total_amount / po.total_quantity, po.total_amount, po.created_at, now()
      FROM po JOIN pp ON pp.n = (po.n % ${PRODUCTS}) + 1`,
    [bid],
  );
  await step(
    'deliveries',
    `INSERT INTO deliveries (id, business_id, code, order_id, customer_id, delivery_date,
      total_quantity, total_amount, created_by, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'DEL-' || lpad(po.n::text, 6, '0'), po.id, po.customer_id, po.order_date,
           po.total_quantity, po.total_amount, $2, po.created_at + interval '1 minute', now()
      FROM po`,
    [bid, actorId],
  );
  await step(
    'delivery lines',
    `INSERT INTO delivery_items (id, business_id, delivery_id, order_item_id, product_id,
      quantity, unit_price, line_total, created_at, updated_at)
    SELECT gen_random_uuid(), $1, d.id, i.id, i.product_id, i.quantity, i.unit_price, i.line_total, d.created_at, now()
      FROM deliveries d JOIN sales_order_items i ON i.business_id = d.business_id AND i.order_id = d.order_id
     WHERE d.business_id = $1`,
    [bid],
  );
  await step(
    'collections',
    `INSERT INTO collections (id, business_id, code, customer_id, collection_date, method,
      amount, created_by, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'COL-' || lpad(po.n::text, 6, '0'), po.customer_id, po.order_date,
           (ARRAY['cash','bkash','nagad','bank','cheque'])[1 + po.n % 5],
           round(po.total_amount * 0.9, 2), $2, po.created_at + interval '2 minutes', now()
      FROM po`,
    [bid, actorId],
  );

  // Stock: one large opening adjustment per product, then every delivery.
  await step(
    'stock movements',
    `INSERT INTO stock_movements (id, business_id, product_id, kind, quantity, balance_after,
      movement_date, source_type, source_id, reason, created_by, created_at)
    SELECT gen_random_uuid(), $1, product_id, kind, quantity,
           sum(quantity) OVER (PARTITION BY product_id ORDER BY created_at ROWS UNBOUNDED PRECEDING),
           movement_date, source_type, source_id, reason, $2, created_at
      FROM (
        SELECT id AS product_id, 'adjustment' AS kind, 10000000::numeric AS quantity, date '2023-12-31' AS movement_date,
               'adjustment' AS source_type, NULL::uuid AS source_id, 'perf opening stock' AS reason,
               timestamp '2023-12-31' AS created_at
          FROM products WHERE business_id = $1
        UNION ALL
        SELECT i.product_id, 'delivery', -i.quantity, d.delivery_date, 'delivery', d.id, NULL, d.created_at
          FROM delivery_items i JOIN deliveries d ON d.id = i.delivery_id WHERE d.business_id = $1
      ) m`,
    [bid, actorId],
  );
  await step(
    'customer ledger',
    `INSERT INTO customer_ledger_entries (id, business_id, customer_id, kind, amount,
      entry_date, source_type, source_id, created_by, created_at)
    SELECT gen_random_uuid(), $1::uuid, customer_id, 'delivery', total_amount, delivery_date, 'delivery', id, $2::uuid, created_at
      FROM deliveries WHERE business_id = $1
    UNION ALL
    SELECT gen_random_uuid(), $1::uuid, customer_id, 'collection', -amount, collection_date, 'collection', id, $2::uuid, created_at
      FROM collections WHERE business_id = $1`,
    [bid, actorId],
  );
  await step(
    'summaries',
    `UPDATE customers c SET
      delivered_amount = coalesce((SELECT sum(total_amount) FROM deliveries d WHERE d.business_id = c.business_id AND d.customer_id = c.id), 0),
      collected_amount = coalesce((SELECT sum(amount) FROM collections k WHERE k.business_id = c.business_id AND k.customer_id = c.id), 0)
     WHERE c.business_id = $1`,
    [bid],
  );
  await step(
    'balances',
    `UPDATE customers SET current_balance = opening_balance + delivered_amount - collected_amount
     WHERE business_id = $1`,
    [bid],
  );
  await step(
    'stock',
    `UPDATE products p SET current_stock = (SELECT sum(quantity) FROM stock_movements m
      WHERE m.business_id = p.business_id AND m.product_id = p.id) WHERE p.business_id = $1`,
    [bid],
  );
  await step(
    'counters',
    `INSERT INTO document_counters (business_id, doc_type, period, last_value, updated_at)
    VALUES ($1, 'order', 0, ${ORDERS}, now()), ($1, 'delivery', 0, ${ORDERS}, now()),
           ($1, 'collection', 0, ${ORDERS}, now()), ($1, 'product', 0, ${PRODUCTS}, now()),
           ($1, 'customer', 0, ${CUSTOMERS}, now())`,
    [bid],
  );
  await client.query('COMMIT');
  await client.query('ANALYZE');
  console.log(
    `Sales perf seed finished in ${String(Math.round((Date.now() - started) / 1000))} s.`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

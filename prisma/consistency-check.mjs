// Read-only consistency check, run by hand (not in CI): `npm run consistency:check`
// (`npm run stock:check` is the same script). Checks, for every business:
// - each product's current_stock = sum of its stock movements = the balance
//   after its latest movement;
// - each month's purchase counter = the active purchase lines of that month;
// - each customer: current_balance = opening + delivered - collected, the
//   ledger sums to delivered - collected, delivered = active deliveries,
//   collected = active collections, pending bags = active orders not delivered;
// - each order's delivered bags = its active delivery lines;
// - each product's cost pools: costed + uncosted bags = current_stock, and
//   costed value and costed quantity are zero together.
// - the cash book (derived, no table of its own): the total net of active
//   collections minus active expenses minus active cash purchases equals the
//   same total added up day by day, for every business.
// Prints any mismatch (ids and numbers only) and exits 1 if one is found.
// Changes nothing.
import { connect } from './seed-helpers.mjs';

const client = await connect('consistency:check');
try {
  const stock = await client.query(`
    SELECT p.business_id, p.id, p.code, p.current_stock::text AS current_stock,
           coalesce(m.total, 0)::text AS movements_total,
           coalesce(l.balance_after, 0)::text AS last_balance
      FROM products p
      LEFT JOIN LATERAL (
        SELECT sum(quantity) AS total FROM stock_movements
         WHERE business_id = p.business_id AND product_id = p.id) m ON true
      LEFT JOIN LATERAL (
        SELECT balance_after FROM stock_movements
         WHERE business_id = p.business_id AND product_id = p.id
         ORDER BY created_at DESC, id DESC LIMIT 1) l ON true
     WHERE p.current_stock <> coalesce(m.total, 0)
        OR p.current_stock <> coalesce(l.balance_after, 0)`);
  const counters = await client.query(`
    WITH bought AS (
      SELECT business_id,
             (extract(year FROM purchase_date) * 100 + extract(month FROM purchase_date))::int AS period,
             sum(quantity) AS quantity
        FROM purchase_items WHERE status = 'active'
       GROUP BY 1, 2)
    SELECT coalesce(c.business_id, b.business_id) AS business_id,
           coalesce(c.period, b.period) AS period,
           coalesce(c.quantity, 0)::text AS counter, coalesce(b.quantity, 0)::text AS purchases
      FROM monthly_purchase_counters c
      FULL JOIN bought b ON b.business_id = c.business_id AND b.period = c.period
     WHERE coalesce(c.quantity, 0) <> coalesce(b.quantity, 0)`);
  const customers = await client.query(`
    SELECT c.business_id, c.id, c.code,
           c.current_balance::text AS balance, c.opening_balance::text AS opening,
           c.delivered_amount::text AS delivered, c.collected_amount::text AS collected,
           c.pending_delivery_quantity::text AS pending,
           coalesce(l.total, 0)::text AS ledger, coalesce(d.total, 0)::text AS deliveries,
           coalesce(k.total, 0)::text AS collections, coalesce(o.total, 0)::text AS orders
      FROM customers c
      LEFT JOIN LATERAL (SELECT sum(amount) AS total FROM customer_ledger_entries
                          WHERE business_id = c.business_id AND customer_id = c.id) l ON true
      LEFT JOIN LATERAL (SELECT sum(total_amount) AS total FROM deliveries
                          WHERE business_id = c.business_id AND customer_id = c.id AND status = 'active') d ON true
      LEFT JOIN LATERAL (SELECT sum(amount) AS total FROM collections
                          WHERE business_id = c.business_id AND customer_id = c.id AND status = 'active') k ON true
      LEFT JOIN LATERAL (SELECT sum(total_quantity - delivered_quantity) AS total FROM sales_orders
                          WHERE business_id = c.business_id AND customer_id = c.id AND status = 'active') o ON true
     WHERE c.current_balance <> c.opening_balance + c.delivered_amount - c.collected_amount
        OR coalesce(l.total, 0) <> c.delivered_amount - c.collected_amount
        OR coalesce(d.total, 0) <> c.delivered_amount
        OR coalesce(k.total, 0) <> c.collected_amount
        OR coalesce(o.total, 0) <> c.pending_delivery_quantity`);
  const orders = await client.query(`
    SELECT o.business_id, o.id, o.code, o.delivered_quantity::text AS delivered,
           coalesce(x.total, 0)::text AS lines
      FROM sales_orders o
      LEFT JOIN LATERAL (SELECT sum(i.quantity) AS total FROM delivery_items i
                          WHERE i.business_id = o.business_id AND i.status = 'active'
                            AND i.order_item_id IN (SELECT id FROM sales_order_items s
                                                     WHERE s.business_id = o.business_id AND s.order_id = o.id)) x ON true
     WHERE o.delivered_quantity <> coalesce(x.total, 0)`);

  // Cash book: it keeps no table of its own, so "consistency" means its total
  // (every business's net of active collections, active expenses and active
  // cash purchases) matches whether it is added up in one pass or day by day.
  // The business's own list of cash methods (config.cashMethodKeys, default
  // ["cash"]) decides which purchases count.
  const cashBook = await client.query(`
    WITH biz AS (
      SELECT id AS business_id,
             coalesce(
               (SELECT array_agg(value) FROM jsonb_array_elements_text(config -> 'cashMethodKeys')),
               ARRAY['cash']) AS cash_methods
        FROM businesses WHERE type = 'dealership'),
    direct AS (
      SELECT b.business_id,
             coalesce((SELECT sum(amount) FROM collections
                        WHERE business_id = b.business_id AND status = 'active'), 0)
             - coalesce((SELECT sum(amount) FROM expenses
                          WHERE business_id = b.business_id AND status = 'active'), 0)
             - coalesce((SELECT sum(total_amount) FROM purchases
                          WHERE business_id = b.business_id AND status = 'active'
                            AND payment_method = ANY (b.cash_methods)), 0) AS net
        FROM biz b),
    by_day AS (
      SELECT business_id, sum(amount) AS net FROM (
        SELECT business_id, amount FROM collections WHERE status = 'active'
        UNION ALL
        SELECT business_id, -amount FROM expenses WHERE status = 'active'
        UNION ALL
        SELECT p.business_id, -p.total_amount FROM purchases p JOIN biz b ON b.business_id = p.business_id
         WHERE p.status = 'active' AND p.payment_method = ANY (b.cash_methods)
      ) x GROUP BY business_id)
    SELECT d.business_id, d.net::text AS direct_net, coalesce(g.net, 0)::text AS by_day_net
      FROM direct d LEFT JOIN by_day g ON g.business_id = d.business_id
     WHERE d.net <> coalesce(g.net, 0)`);

  // Inventory cost pools: the costed and uncosted bags together are the stock
  // on hand, and value and quantity are empty together — a pool holding money
  // but no bags (or bags recorded at no value) means costing has drifted.
  // Before `npm run inventory:cost-backfill -- --commit` has been run, every
  // product with stock shows up here; that is the signal to run it.
  const costPools = await client.query(`
    SELECT business_id, id, code, current_stock::text AS current_stock,
           costed_quantity::text AS costed_quantity, costed_value::text AS costed_value,
           uncosted_quantity::text AS uncosted_quantity
      FROM products
     WHERE costed_quantity + uncosted_quantity <> current_stock
        OR (costed_quantity = 0) <> (costed_value = 0)`);

  // Defensive: an active expense's kind always belongs to its own business
  // (the composite foreign key already guarantees this; this just says so).
  const expenseCategories = await client.query(`
    SELECT e.business_id, e.id, e.code
      FROM expenses e
      LEFT JOIN expense_categories c ON c.business_id = e.business_id AND c.id = e.category_id
     WHERE e.status = 'active' AND c.id IS NULL`);
  for (const row of customers.rows) {
    console.error(
      `customer mismatch: business ${row.business_id} customer ${row.code} (${row.id}): ` +
        `balance ${row.balance}, opening ${row.opening}, delivered ${row.delivered} (deliveries ${row.deliveries}), ` +
        `collected ${row.collected} (collections ${row.collections}), ledger ${row.ledger}, ` +
        `pending ${row.pending} (orders ${row.orders})`,
    );
  }
  for (const row of orders.rows) {
    console.error(
      `order mismatch: business ${row.business_id} order ${row.code} (${row.id}): ` +
        `delivered ${row.delivered}, active delivery lines ${row.lines}`,
    );
  }
  for (const row of stock.rows) {
    console.error(
      `stock mismatch: business ${row.business_id} product ${row.code} (${row.id}): ` +
        `current ${row.current_stock}, movements ${row.movements_total}, last balance ${row.last_balance}`,
    );
  }
  for (const row of counters.rows) {
    console.error(
      `counter mismatch: business ${row.business_id} month ${row.period}: ` +
        `counter ${row.counter}, active purchase lines ${row.purchases}`,
    );
  }
  for (const row of cashBook.rows) {
    console.error(
      `cash book mismatch: business ${row.business_id}: ` +
        `direct net ${row.direct_net}, day-by-day net ${row.by_day_net}`,
    );
  }
  for (const row of costPools.rows) {
    console.error(
      `cost pool mismatch: business ${row.business_id} product ${row.code} (${row.id}): ` +
        `current ${row.current_stock}, costed ${row.costed_quantity} worth ${row.costed_value}, ` +
        `uncosted ${row.uncosted_quantity} (run inventory:cost-backfill if costing has not been run yet)`,
    );
  }
  for (const row of expenseCategories.rows) {
    console.error(
      `expense category mismatch: business ${row.business_id} expense ${row.code} (${row.id}): ` +
        `its kind is missing or belongs to another business`,
    );
  }
  if (
    stock.rows.length ||
    counters.rows.length ||
    customers.rows.length ||
    orders.rows.length ||
    cashBook.rows.length ||
    costPools.rows.length ||
    expenseCategories.rows.length
  ) {
    process.exitCode = 1;
  } else {
    console.log(
      'Stock, cost pools, purchase counters, customer balances, orders, and the cash book are consistent.',
    );
  }
} finally {
  await client.end();
}

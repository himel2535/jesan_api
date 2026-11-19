// Read-only consistency check, run by hand (not in CI): `npm run consistency:check`
// (`npm run stock:check` is the same script). Checks, for every business:
// - each product's current_stock = sum of its stock movements = the balance
//   after its latest movement;
// - each month's purchase counter = the active purchase lines of that month;
// - each customer: current_balance = opening + delivered - collected, the
//   ledger sums to delivered - collected, delivered = active deliveries,
//   collected = active collections, pending bags = active orders not delivered;
// - each order's delivered bags = its active delivery lines.
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
  if (stock.rows.length || counters.rows.length || customers.rows.length || orders.rows.length) {
    process.exitCode = 1;
  } else {
    console.log('Stock, purchase counters, customer balances and orders are consistent.');
  }
} finally {
  await client.end();
}

// Read-only consistency check, run by hand (not in CI): `npm run stock:check`.
// For every product, current_stock must equal the sum of its stock movements
// and the balance after its latest movement; each month's purchase counter
// must equal the active purchase lines of that month. Prints any mismatch
// (ids and numbers only) and exits 1 if one is found. Changes nothing.
import { connect } from './seed-helpers.mjs';

const client = await connect('stock:check');
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
  if (stock.rows.length || counters.rows.length) {
    process.exitCode = 1;
  } else {
    console.log('Stock and purchase counters are consistent.');
  }
} finally {
  await client.end();
}

import { expect } from 'vitest';
import type { TestApp } from './helpers';

/** Balance identity, summaries and stock: everything kept in step must agree. */
export async function expectSalesConsistent(t: TestApp, businessId: string) {
  const customers = await t.prisma.client.$queryRawUnsafe<
    {
      id: string;
      ok_balance: boolean;
      ok_ledger: boolean;
      ok_delivered: boolean;
      ok_collected: boolean;
      ok_pending: boolean;
    }[]
  >(
    `SELECT c.id,
            c.current_balance = c.opening_balance + c.delivered_amount - c.collected_amount AS ok_balance,
            coalesce((SELECT sum(amount) FROM customer_ledger_entries l
                       WHERE l.business_id = c.business_id AND l.customer_id = c.id), 0)
              = c.delivered_amount - c.collected_amount AS ok_ledger,
            coalesce((SELECT sum(total_amount) FROM deliveries d
                       WHERE d.business_id = c.business_id AND d.customer_id = c.id AND d.status = 'active'), 0)
              = c.delivered_amount AS ok_delivered,
            coalesce((SELECT sum(amount) FROM collections k
                       WHERE k.business_id = c.business_id AND k.customer_id = c.id AND k.status = 'active'), 0)
              = c.collected_amount AS ok_collected,
            coalesce((SELECT sum(total_quantity - delivered_quantity) FROM sales_orders o
                       WHERE o.business_id = c.business_id AND o.customer_id = c.id AND o.status = 'active'), 0)
              = c.pending_delivery_quantity AS ok_pending
       FROM customers c WHERE c.business_id = $1::uuid`,
    businessId,
  );
  for (const row of customers) {
    expect(row).toMatchObject({
      ok_balance: true,
      ok_ledger: true,
      ok_delivered: true,
      ok_collected: true,
      ok_pending: true,
    });
  }
  const stock = await t.prisma.client.$queryRawUnsafe<{ ok: boolean }[]>(
    `SELECT p.current_stock = coalesce((SELECT sum(quantity) FROM stock_movements m
              WHERE m.business_id = p.business_id AND m.product_id = p.id), 0) AS ok
       FROM products p WHERE p.business_id = $1::uuid`,
    businessId,
  );
  expect(stock.every((row) => row.ok)).toBe(true);
}

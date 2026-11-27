import { expect } from 'vitest';
import type { TestApp } from './helpers';

/**
 * The facts that must hold after every scenario (the same checks `consistency:check` runs):
 * pools equal the batches, what each batch has left equals what came in less what was drawn,
 * a line's frozen snapshot equals what the delivery itself consumed, and a line's price is
 * shared out to its batches exactly.
 */
export async function expectFifoInvariants(t: TestApp, businessId: string) {
  const query = async (sql: string) =>
    (await t.prisma.client.$queryRawUnsafe<{ id: string }[]>(sql, businessId)).map((row) => row.id);
  expect(
    await query(
      `SELECT id::text FROM products WHERE business_id = $1::uuid
        AND costed_quantity + uncosted_quantity <> current_stock`,
    ),
  ).toEqual([]);
  expect(
    await query(
      `SELECT p.id::text FROM products p WHERE p.business_id = $1::uuid
        AND (p.costed_quantity <> coalesce((SELECT sum(remaining_quantity) FROM inventory_batches b
                                             WHERE b.product_id = p.id AND b.unit_cost IS NOT NULL), 0)
          OR p.costed_value <> coalesce((SELECT sum(remaining_quantity * unit_cost) FROM inventory_batches b
                                          WHERE b.product_id = p.id AND b.unit_cost IS NOT NULL), 0))`,
    ),
  ).toEqual([]);
  expect(
    await query(
      `SELECT b.id::text FROM inventory_batches b WHERE b.business_id = $1::uuid
        AND b.remaining_quantity <> b.received_quantity
            - coalesce((SELECT sum(quantity) FROM delivery_item_allocations a WHERE a.batch_id = b.id), 0)
            + coalesce((SELECT sum(quantity_delta) FROM inventory_batch_events e
                         WHERE e.batch_id = b.id AND e.event_type = 'adjust_out'), 0)`,
    ),
  ).toEqual([]);
  expect(
    await query(
      `SELECT di.id::text FROM delivery_items di
        WHERE di.business_id = $1::uuid AND di.cost_source = 'live' AND di.status = 'active'
          AND (coalesce(di.cost_amount, 0) <> coalesce((SELECT sum(cost_amount) FROM delivery_item_allocations a
                     WHERE a.delivery_item_id = di.id AND a.kind IN ('original', 'reversal')), 0)
            OR di.uncosted_quantity <> coalesce((SELECT sum(quantity) FROM delivery_item_allocations a
                     WHERE a.delivery_item_id = di.id AND a.kind IN ('original', 'reversal')
                       AND NOT a.cost_known), 0))`,
    ),
  ).toEqual([]);
  expect(
    await query(
      `SELECT di.id::text FROM delivery_items di
        WHERE di.business_id = $1::uuid AND di.status = 'active'
          AND EXISTS (SELECT 1 FROM delivery_item_allocations a WHERE a.delivery_item_id = di.id)
          AND di.line_total <> (SELECT sum(revenue_amount) FROM delivery_item_allocations a
                                 WHERE a.delivery_item_id = di.id)`,
    ),
  ).toEqual([]);
}

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { todayIn } from '../src/core/common/business-time';
import { hasDatabase } from './database';
import { expectFifoInvariants } from './fifo-invariants';
import { FifoBackfillService } from '../src/modules/dealership/stock/fifo-backfill.service';
import { TestApp, TestData, cookieHeader, createTestApp, login, runSeed } from './helpers';
import type { Cookies } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

const TODAY = todayIn('Asia/Dhaka');

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0179${String(phoneCounter).padStart(7, '0')}`;
};

interface OrderBody {
  id: string;
  items: { id: string }[];
}

/**
 * The FIFO backfill against the real database: history that predates batches is rebuilt from what
 * is already recorded, never from a made-up price, only after the report has been read, and it can
 * be undone. "Before FIFO" is simulated by stripping a product's batches and allocations and
 * leaving the delivery snapshots the way the old moving-average code (or no costing) left them.
 */
describe.skipIf(!hasDatabase)('FIFO backfill', () => {
  let t: TestApp;
  let data: TestData;
  let backfill: FifoBackfillService;
  let owner: Cookies = {};
  let actorId = '';
  const shops: { id: string; slug: string }[] = [];

  const world = async (slug: string) => {
    const shop = await data.createBusiness(slug);
    shops.push(shop);
    await runSeed();
    const path = (suffix: string) => `/b/${shop.slug}/${suffix}`;
    const post = (suffix: string, body: object) =>
      request(t.server)
        .post(`/api/v1${path(suffix)}`)
        .set('Cookie', cookieHeader(owner))
        .send(body);
    const created = (response: request.Response) => {
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response;
    };
    const category = (
      created(await post('product-categories', { nameEn: 'OPC', nameBn: 'ওপিসি' })).body as {
        id: string;
      }
    ).id;
    const customer = (
      created(await post('customers', { nameEn: 'Shop', phone: newPhone() })).body as { id: string }
    ).id;
    const db = t.prisma.forBusiness(shop.id);
    return {
      shop,
      db,
      product: async () =>
        (
          created(
            await post('products', {
              categoryId: category,
              nameEn: `Cement ${String(Math.random()).slice(2, 12)}`,
              nameBn: 'সিমেন্ট',
            }),
          ).body as { id: string }
        ).id,
      buy: async (productId: string, quantity: string, unitPrice: string, purchaseDate: string) =>
        created(
          await post('purchases', {
            items: [{ productId, quantity, unitPrice }],
            purchaseDate,
          }),
        ),
      found: async (productId: string, quantity: string) =>
        created(
          await post('stock/adjustments', {
            productId,
            quantity,
            reason: 'found during the count',
          }),
        ),
      deliver: async (productId: string, quantity: string, unitPrice: string, date: string) => {
        const order = created(
          await post('orders', {
            customerId: customer,
            orderDate: date,
            deliveryWindow: 'two_days',
            items: [{ productId, quantity, unitPrice }],
          }),
        ).body as OrderBody;
        const response = await post('deliveries', {
          orderId: order.id,
          items: [{ orderItemId: order.items[0]?.id, quantity }],
          deliveryDate: date,
        });
        return created(response).body as { id: string };
      },
      /** Turns a product back into one from before batches: no batches, empty pools, no allocations. */
      makeLegacy: async (productId: string) => {
        const client = t.prisma.client;
        await client.$transaction([
          client.$executeRawUnsafe(`SET LOCAL jesan.allow_purge = 'on'`),
          client.$executeRawUnsafe(
            'DELETE FROM delivery_item_allocations WHERE product_id = $1::uuid',
            productId,
          ),
          client.$executeRawUnsafe(
            'DELETE FROM inventory_batch_events WHERE product_id = $1::uuid',
            productId,
          ),
          client.$executeRawUnsafe(
            'DELETE FROM inventory_batches WHERE product_id = $1::uuid',
            productId,
          ),
          client.$executeRawUnsafe(
            `UPDATE products SET costed_quantity = 0, costed_value = 0, uncosted_quantity = 0 WHERE id = $1::uuid`,
            productId,
          ),
          client.$executeRawUnsafe(
            `UPDATE delivery_items SET cost_source = NULL WHERE product_id = $1::uuid`,
            productId,
          ),
        ]);
      },
      setSnapshot: (deliveryId: string, unitCost: string | null, costAmount: string | null) =>
        t.prisma.client.$executeRawUnsafe(
          `UPDATE delivery_items SET unit_cost = $2::numeric, cost_amount = $3::numeric, uncosted_quantity = 0
            WHERE delivery_id = $1::uuid`,
          deliveryId,
          unitCost,
          costAmount,
        ),
      counts: async (productId: string) => ({
        batches: await db.inventoryBatch.count({ where: { productId } }),
        allocations: await db.deliveryItemAllocation.count({ where: { productId } }),
        events: await db.inventoryBatchEvent.count({ where: { productId } }),
      }),
      line: async (deliveryId: string) => {
        const row = await db.deliveryItem.findFirstOrThrow({ where: { deliveryId } });
        return {
          unitCost: row.unitCost?.toString() ?? null,
          costAmount: row.costAmount?.toString() ?? null,
          uncosted: row.uncostedQuantity.toString(),
          costSource: row.costSource,
        };
      },
      pools: async (productId: string) => {
        const row = await db.product.findUniqueOrThrow({ where: { id: productId } });
        return {
          stock: row.currentStock.toString(),
          costed: row.costedQuantity.toString(),
          value: row.costedValue.toString(),
          uncosted: row.uncostedQuantity.toString(),
        };
      },
    };
  };

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    backfill = t.app.get(FifoBackfillService);
    const user = await data.createUser({ name: 'owner', isPlatformOwner: true });
    actorId = user.id;
    owner = (await login(t.server, user.email ?? '', user.password)).cookies;
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  /**
   * 100 @ 500 (June) and 100 @ 580 (July); 120 delivered in August, 30 more ten days later. FIFO
   * says 61,600 and 17,400. The first delivery is left with a moving-average snapshot (540 × 120)
   * and the second with no cost at all, as the code before FIFO would have left them.
   */
  async function legacyHistory(w: Awaited<ReturnType<typeof world>>) {
    const product = await w.product();
    await w.buy(product, '100', '500', '2026-06-01');
    await w.buy(product, '100', '580', '2026-07-01');
    const first = await w.deliver(product, '120', '900', '2026-08-01');
    const second = await w.deliver(product, '30', '900', '2026-08-10');
    await w.makeLegacy(product);
    await w.setSnapshot(first.id, '540', '64800');
    await w.setSnapshot(second.id, null, null);
    return { product, first: first.id, second: second.id };
  }

  describe('the dry run', () => {
    it('reports before and after, rebuilds nothing, and changes no row', async () => {
      const w = await world('fifobf-plan');
      const { product } = await legacyHistory(w);
      const before = await w.counts(product);
      const poolsBefore = await w.pools(product);

      const report = await backfill.plan(w.shop.id);
      const plan = report.products.find((entry) => entry.productId === product);
      expect(plan).toMatchObject({
        status: 'ready',
        cogsBefore: '64800.00', // only the first delivery had a cost
        cogsAfter: '79000.00', // 61,600 + 17,400
        policyDifference: '-3200.00', // FIFO vs the moving-average snapshot
        newlyCosted: '17400.00', // the delivery that never had a cost
        remainingQuantity: '50',
        remainingValue: '29000.00',
      });
      expect(plan?.batches.map((b) => [b.date, b.quantity, b.unitCost])).toEqual([
        ['2026-06-01', '100', '500.00'],
        ['2026-07-01', '100', '580.00'],
      ]);
      expect(report.totals).toMatchObject({
        ready: 1,
        cogsBefore: '64800.00',
        cogsAfter: '79000.00',
        netProfitChange: '-14200.00',
        policyDifference: '-3200.00',
      });
      expect(report.fingerprint).toMatch(/^[0-9a-f]{16}$/);

      // Nothing was written.
      expect(await w.counts(product)).toEqual(before);
      expect(await w.pools(product)).toEqual(poolsBefore);
    });

    it('the fingerprint is stable until the history changes', async () => {
      const w = await world('fifobf-fp');
      const { product } = await legacyHistory(w);
      const one = await backfill.plan(w.shop.id);
      const two = await backfill.plan(w.shop.id);
      expect(two.fingerprint).toBe(one.fingerprint);
      await w.buy(product, '10', '600', '2026-09-01');
      expect((await backfill.plan(w.shop.id)).fingerprint).not.toBe(one.fingerprint);
    });
  });

  describe('committing', () => {
    it('refuses without the fingerprint of a report that was read', async () => {
      const w = await world('fifobf-gate');
      const { product } = await legacyHistory(w);
      await expect(
        backfill.commit(w.shop.id, {
          fingerprint: 'deadbeefdeadbeef',
          actorUserId: actorId,
          bookPolicyCorrection: false,
        }),
      ).rejects.toThrow(/fingerprint|changed/);
      expect((await w.counts(product)).batches).toBe(0);
    });

    it('rebuilds batches and allocations, fills only the missing cost, and leaves reported snapshots alone', async () => {
      const w = await world('fifobf-commit');
      const { product, first, second } = await legacyHistory(w);
      const report = await backfill.plan(w.shop.id);
      const done = await backfill.commit(w.shop.id, {
        fingerprint: report.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: false,
      });
      expect(done.written).toEqual([product]);

      const batches = await w.db.inventoryBatch.findMany({
        where: { productId: product },
        orderBy: { receivedDate: 'asc' },
      });
      expect(
        batches.map((b) => [
          b.unitCost?.toString(),
          b.remainingQuantity.toString(),
          b.originalUnitCost?.toString(),
        ]),
      ).toEqual([
        ['500', '0', '500'],
        ['580', '50', '580'],
      ]);
      expect(batches.every((b) => b.backfillRunId === done.runId)).toBe(true);

      // A snapshot that was already reported is a fact and is not rewritten.
      expect(await w.line(first)).toEqual({
        unitCost: '540',
        costAmount: '64800',
        uncosted: '0',
        costSource: null,
      });
      // A delivery that never had a cost gains one, and says where it came from.
      expect(await w.line(second)).toMatchObject({ costAmount: '17400', costSource: 'backfill' });

      // The bags came from the right batches: 100 @ 500 then 20 @ 580, then 30 @ 580.
      const slices = await w.db.deliveryItemAllocation.findMany({
        where: { productId: product },
        orderBy: [{ allocationDate: 'asc' }, { quantity: 'desc' }],
      });
      expect(
        slices.map((s) => [
          s.quantity.toString(),
          s.costAmount?.toString(),
          s.revenueAmount.toString(),
        ]),
      ).toEqual([
        ['100', '50000', '90000'],
        ['20', '11600', '18000'],
        ['30', '17400', '27000'],
      ]);
      expect(await w.pools(product)).toEqual({
        stock: '50',
        costed: '50',
        value: '29000',
        uncosted: '0',
      });
      await expectFifoInvariants(t, w.shop.id);

      // The money difference is NOT booked unless asked for.
      expect(await w.db.inventoryCostCorrection.count({ where: { productId: product } })).toBe(0);
    });

    it('is idempotent: a product that already has batches is skipped', async () => {
      const w = await world('fifobf-idem');
      const { product } = await legacyHistory(w);
      const first = await backfill.plan(w.shop.id);
      await backfill.commit(w.shop.id, {
        fingerprint: first.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: false,
      });
      const counts = await w.counts(product);
      const again = await backfill.plan(w.shop.id);
      expect(again.products.find((p) => p.productId === product)?.status).toBe('already_batched');
      const second = await backfill.commit(w.shop.id, {
        fingerprint: again.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: false,
      });
      expect(second.written).toEqual([]);
      expect(await w.counts(product)).toEqual(counts);
    });

    it('books the moving-average difference as one explicit correction, only on request', async () => {
      const w = await world('fifobf-policy');
      const { product } = await legacyHistory(w);
      const report = await backfill.plan(w.shop.id);
      const done = await backfill.commit(w.shop.id, {
        fingerprint: report.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: true,
      });
      const rows = await w.db.inventoryCostCorrection.findMany({ where: { productId: product } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'costing_policy_change',
        sourceType: 'backfill',
        sourceId: done.runId,
      });
      expect(rows[0]?.cogsDelta.toString()).toBe('-3200');
      // Reported snapshots (64,800 + 17,400) plus the correction (-3,200) = the FIFO cost of 79,000.
      const lines = await w.db.deliveryItem.findMany({ where: { productId: product } });
      const snapshots = lines.reduce((sum, row) => sum + Number(row.costAmount ?? 0), 0);
      expect(snapshots + Number(rows[0]?.cogsDelta)).toBe(79000);
    });

    it('never gives unknown-cost bags a price', async () => {
      const w = await world('fifobf-unknown');
      const product = await w.product();
      // Found first, bought after, both today: the found bags are the older stock.
      await w.found(product, '10');
      await w.buy(product, '100', '600', TODAY);
      const delivery = await w.deliver(product, '15', '900', TODAY);
      await w.makeLegacy(product);
      await w.setSnapshot(delivery.id, null, null);

      const report = await backfill.plan(w.shop.id);
      const plan = report.products.find((p) => p.productId === product);
      expect(plan?.problems.join(' ')).toMatch(/no known cost/);
      expect(plan?.lines[0]).toMatchObject({ costAfter: '3000.00', unknownCostQuantity: '10' });
      await backfill.commit(w.shop.id, {
        fingerprint: report.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: false,
      });
      // Found bags first (older), then 5 @ 600: 10 unknown + 3,000 known, never 15 × anything.
      expect(await w.line(delivery.id)).toMatchObject({
        costAmount: '3000',
        uncosted: '10',
        costSource: 'backfill',
      });
      const first = await w.db.deliveryItemAllocation.findFirstOrThrow({
        where: { productId: product },
        orderBy: { createdAt: 'asc' },
      });
      expect(first).toMatchObject({ costKnown: false, costAmount: null, unitCost: null });
      const adjustment = await w.db.inventoryBatch.findFirstOrThrow({
        where: { productId: product, sourceType: 'adjustment' },
      });
      expect(adjustment.unitCost).toBeNull();
      expect(adjustment.originalUnitCost).toBeNull();
    });

    it('reports a product whose history does not add up and leaves it alone', async () => {
      const w = await world('fifobf-bad');
      const product = await w.product();
      await w.buy(product, '100', '500', '2026-06-01');
      await w.makeLegacy(product);
      // The recorded stock disagrees with the recorded movements.
      await t.prisma.client.$executeRawUnsafe(
        `UPDATE products SET current_stock = 105 WHERE id = $1::uuid`,
        product,
      );
      const report = await backfill.plan(w.shop.id);
      const plan = report.products.find((p) => p.productId === product);
      expect(plan?.status).toBe('unresolved');
      expect(plan?.problems.join(' ')).toMatch(/ends at 100 but current stock is 105/);
      const done = await backfill.commit(w.shop.id, {
        fingerprint: report.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: false,
      });
      expect(done.written).toEqual([]);
      expect(done.skipped).toEqual([{ productId: product, reason: 'unresolved' }]);
      expect((await w.counts(product)).batches).toBe(0);
    });
  });

  describe('rolling back', () => {
    it('puts the pools and snapshots back and removes everything the run wrote', async () => {
      const w = await world('fifobf-undo');
      const { product, first, second } = await legacyHistory(w);
      const poolsBefore = await w.pools(product);
      const report = await backfill.plan(w.shop.id);
      const done = await backfill.commit(w.shop.id, {
        fingerprint: report.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: true,
      });
      expect((await w.counts(product)).batches).toBe(2);

      await backfill.rollback(w.shop.id, done.runId);
      expect(await w.counts(product)).toEqual({ batches: 0, allocations: 0, events: 0 });
      expect(await w.pools(product)).toEqual(poolsBefore);
      expect(await w.line(second)).toEqual({
        unitCost: null,
        costAmount: null,
        uncosted: '0',
        costSource: null,
      });
      expect(await w.line(first)).toMatchObject({ costAmount: '64800' });
      expect(await w.db.inventoryCostCorrection.count({ where: { productId: product } })).toBe(0);
      const run = await w.db.inventoryBackfillRun.findUniqueOrThrow({ where: { id: done.runId } });
      expect(run.status).toBe('rolled_back');

      // And it can be run again from scratch.
      const again = await backfill.plan(w.shop.id);
      expect(again.products.find((p) => p.productId === product)?.status).toBe('ready');
    });

    it('is refused once later deliveries have drawn from the rebuilt batches', async () => {
      const w = await world('fifobf-late');
      const { product } = await legacyHistory(w);
      const report = await backfill.plan(w.shop.id);
      const done = await backfill.commit(w.shop.id, {
        fingerprint: report.fingerprint,
        actorUserId: actorId,
        bookPolicyCorrection: false,
      });
      await w.deliver(product, '10', '900', '2026-09-01');
      await expect(backfill.rollback(w.shop.id, done.runId)).rejects.toThrow(/Cannot roll back/);
      expect((await w.counts(product)).batches).toBe(2);
      await expectFifoInvariants(t, w.shop.id);
    });
  });
});

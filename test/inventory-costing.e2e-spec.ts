import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { todayIn } from '../src/core/common/business-time';
import { hasDatabase } from './database';
import { expectFifoInvariants } from './fifo-invariants';
import {
  TestApp,
  TestData,
  cookieHeader,
  createTestApp,
  get,
  login,
  runSeed,
  send,
} from './helpers';
import type { Cookies } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

const TODAY = todayIn('Asia/Dhaka');

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0177${String(phoneCounter).padStart(7, '0')}`;
};

interface OrderBody {
  id: string;
  items: { id: string }[];
}

/**
 * FIFO batch costing against the real database: every purchase is its own batch at its own
 * price, a delivery draws the oldest bags first and records which batch each came from, and
 * history corrected after the fact is *adjusted*, never rewritten.
 */
describe.skipIf(!hasDatabase)('FIFO inventory costing', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string) => `/b/${shop.slug}/${suffix}`;
  const post = (who_: string, suffix: string, body: object) =>
    request(t.server)
      .post(`/api/v1${path(suffix)}`)
      .set('Cookie', cookieHeader(who(who_)))
      .send(body);

  async function member(name: string, roleKey: string | null) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) await data.giveAccess(user.id, shop.id, roleKey);
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  async function newProduct() {
    return (
      (
        await send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameEn: `Cement ${String(Math.random()).slice(2, 12)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  async function buy(
    productId: string,
    quantity: string,
    unitPrice: string,
    purchaseDate?: string,
  ) {
    return (
      await post('owner', 'purchases', {
        items: [{ productId, quantity, unitPrice }],
        ...(purchaseDate ? { purchaseDate } : {}),
      }).expect(201)
    ).body as { id: string; items: { id: string }[] };
  }

  async function newCustomer() {
    return (
      (
        await send(t.server, 'post', path('customers'), who('owner'), {
          nameEn: `Shop ${String(Math.random()).slice(2, 12)}`,
          phone: newPhone(),
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  /** An order and a delivery of `quantity` bags, returning the delivery id. */
  async function sell(productId: string, quantity: string, deliveryDate?: string) {
    const customerId = await newCustomer();
    const order = (
      await post('owner', 'orders', {
        customerId,
        deliveryWindow: 'two_days',
        items: [{ productId, quantity, unitPrice: '900' }],
      }).expect(201)
    ).body as OrderBody;
    const delivery = (
      await post('owner', 'deliveries', {
        orderId: order.id,
        items: [{ orderItemId: order.items[0]?.id, quantity }],
        ...(deliveryDate ? { deliveryDate } : {}),
      }).expect(201)
    ).body as { id: string };
    return { order, deliveryId: delivery.id };
  }

  /** The product's cost pools straight from the database. */
  async function pools(productId: string) {
    const row = await t.prisma.forBusiness(shop.id).product.findUniqueOrThrow({
      where: { id: productId },
      select: {
        currentStock: true,
        costedQuantity: true,
        costedValue: true,
        uncostedQuantity: true,
      },
    });
    return {
      stock: row.currentStock.toString(),
      costedQuantity: row.costedQuantity.toString(),
      costedValue: row.costedValue.toString(),
      uncosted: row.uncostedQuantity.toString(),
    };
  }

  /** The product's batches, oldest first. */
  async function batches(productId: string) {
    const rows = await t.prisma.forBusiness(shop.id).inventoryBatch.findMany({
      where: { productId },
      orderBy: [{ receivedDate: 'asc' }, { seq: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      sourceType: row.sourceType,
      received: row.receivedQuantity.toString(),
      remaining: row.remainingQuantity.toString(),
      unitCost: row.unitCost?.toString() ?? null,
      originalQuantity: row.originalQuantity.toString(),
      originalUnitCost: row.originalUnitCost?.toString() ?? null,
      originalDate: row.originalReceivedDate.toISOString().slice(0, 10),
      date: row.receivedDate.toISOString().slice(0, 10),
    }));
  }

  async function lineCost(deliveryId: string) {
    const row = await t.prisma.forBusiness(shop.id).deliveryItem.findFirstOrThrow({
      where: { deliveryId },
      select: {
        id: true,
        unitCost: true,
        costAmount: true,
        uncostedQuantity: true,
        status: true,
        costSource: true,
      },
    });
    return {
      id: row.id,
      unitCost: row.unitCost?.toString() ?? null,
      costAmount: row.costAmount?.toString() ?? null,
      uncosted: row.uncostedQuantity.toString(),
      status: row.status,
      costSource: row.costSource,
    };
  }

  /** What a delivery line drew from each batch, as appended rows (net per kind and batch). */
  async function allocations(deliveryId: string) {
    const line = await lineCost(deliveryId);
    const rows = await t.prisma.forBusiness(shop.id).deliveryItemAllocation.findMany({
      where: { deliveryItemId: line.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      kind: row.kind,
      batchId: row.batchId,
      quantity: row.quantity.toString(),
      unitCost: row.unitCost?.toString() ?? null,
      costAmount: row.costAmount?.toString() ?? null,
      revenue: row.revenueAmount.toString(),
      costKnown: row.costKnown,
    }));
  }

  const corrections = async (productId: string) =>
    t.prisma.forBusiness(shop.id).inventoryCostCorrection.findMany({
      where: { productId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        cogsDelta: true,
        stockValueDelta: true,
        correctionDate: true,
        effectiveDate: true,
      },
    });

  const summary = async (from: string, to: string, who_ = 'owner') =>
    (
      await get(
        t.server,
        path(`dashboard/finance-summary?from=${from}&to=${to}`),
        who(who_),
      ).expect(200)
    ).body as Record<string, string>;

  const requestChange = (who_: string, body: object) => post(who_, 'change-requests', body);
  const decide = (who_: string, id: string, action: 'approve' | 'reject') =>
    post(who_, `change-requests/${id}/${action}`, { note: 'ok' });

  async function approve(body: object) {
    const created = await requestChange('manager', body).expect(201);
    await decide('owner', (created.body as { id: string }).id, 'approve').expect(200);
  }

  /** Removes a product's batches, as if it had been created before batches existed. */
  async function makeLegacy(productId: string) {
    const db = t.prisma.client;
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL jesan.allow_purge = 'on'`),
      db.$executeRawUnsafe(
        'DELETE FROM inventory_batch_events WHERE product_id = $1::uuid',
        productId,
      ),
      db.$executeRawUnsafe('DELETE FROM inventory_batches WHERE product_id = $1::uuid', productId),
      db.$executeRawUnsafe(
        `UPDATE products SET costed_quantity = 0, costed_value = 0, uncosted_quantity = 0 WHERE id = $1::uuid`,
        productId,
      ),
    ]);
  }

  const expectInvariants = () => expectFifoInvariants(t, shop.id);

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('costing');
    await runSeed();
    await member('owner', null);
    await member('manager', 'manager');
    categoryId = (
      (
        await send(t.server, 'post', path('product-categories'), who('owner'), {
          nameEn: 'OPC',
          nameBn: 'ওপিসি',
        }).expect(201)
      ).body as { id: string }
    ).id;
  });

  afterEach(async () => {
    await expectInvariants();
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  /** `after[key] - before[key]` of two finance summaries, as a number. */
  const rise = (after: Record<string, string>, before: Record<string, string>, key: string) =>
    Number(after[key] ?? 0) - Number(before[key] ?? 0);

  const money = (value: string | null | undefined) =>
    value === null || value === undefined ? null : Number(value);

  describe('batches', () => {
    it('opens one batch per purchase, each at its own price, never merged', async () => {
      const product = await newProduct();
      await buy(product, '100', '570');
      await buy(product, '100', '580');
      const rows = await batches(product);
      expect(rows.map((row) => [row.received, row.remaining, row.unitCost])).toEqual([
        ['100', '100', '570'],
        ['100', '100', '580'],
      ]);
      expect(rows[0]?.originalUnitCost).toBe('570');
      expect(await pools(product)).toMatchObject({
        stock: '200',
        costedQuantity: '200',
        costedValue: '115000',
      });
    });

    it('a delivery of 120 takes 100 @ 570 and 20 @ 580: cost 68,600, 80 left worth 46,400', async () => {
      const product = await newProduct();
      await buy(product, '100', '570');
      await buy(product, '100', '580');
      const before = await summary(TODAY, TODAY);
      const { deliveryId } = await sell(product, '120');

      const rows = await batches(product);
      expect(rows.map((row) => row.remaining)).toEqual(['0', '80']);
      const slices = await allocations(deliveryId);
      expect(slices).toHaveLength(2);
      expect(slices[0]).toMatchObject({ kind: 'original', quantity: '100', costAmount: '57000' });
      expect(slices[1]).toMatchObject({ kind: 'original', quantity: '20', costAmount: '11600' });
      // The selling price (900 a bag, 108,000) is shared by bags, not by cost.
      expect(slices.map((slice) => slice.revenue)).toEqual(['90000', '18000']);

      const line = await lineCost(deliveryId);
      expect(line).toMatchObject({ costAmount: '68600', uncosted: '0', costSource: 'live' });
      expect(await pools(product)).toMatchObject({ costedQuantity: '80', costedValue: '46400' });

      const after = await summary(TODAY, TODAY);
      expect(rise(after, before, 'cogs')).toBe(68600);
    });

    it('partial deliveries keep drawing the oldest bags first', async () => {
      const product = await newProduct();
      await buy(product, '100', '570');
      await buy(product, '100', '580');
      const first = await sell(product, '60');
      const second = await sell(product, '60');
      expect((await lineCost(first.deliveryId)).costAmount).toBe('34200');
      // 40 left @ 570, then 20 @ 580.
      expect((await lineCost(second.deliveryId)).costAmount).toBe('34400');
      expect((await batches(product)).map((row) => row.remaining)).toEqual(['0', '80']);
    });

    it('a later purchase never changes what an earlier delivery cost or which batch it drew from', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      const { deliveryId } = await sell(product, '50');
      const before = { line: await lineCost(deliveryId), slices: await allocations(deliveryId) };
      await buy(product, '100', '900');
      expect({ line: await lineCost(deliveryId), slices: await allocations(deliveryId) }).toEqual(
        before,
      );
      expect(before.line.costAmount).toBe('25000');
    });

    it('keeps products separate', async () => {
      const a = await newProduct();
      const b = await newProduct();
      await buy(a, '10', '500');
      await buy(b, '10', '900');
      const { deliveryId } = await sell(b, '4');
      expect((await lineCost(deliveryId)).costAmount).toBe('3600');
      expect((await batches(a))[0]?.remaining).toBe('10');
    });

    it('refuses a delivery for more bags than exist, and moves nothing', async () => {
      const product = await newProduct();
      await buy(product, '10', '500');
      const customerId = await newCustomer();
      const order = (
        await post('owner', 'orders', {
          customerId,
          deliveryWindow: 'two_days',
          items: [{ productId: product, quantity: '11', unitPrice: '900' }],
        }).expect(201)
      ).body as OrderBody;
      const response = await post('owner', 'deliveries', {
        orderId: order.id,
        items: [{ orderItemId: order.items[0]?.id, quantity: '11' }],
      });
      expect(response.status).toBe(409);
      expect((response.body as { code: string }).code).toBe('STOCK_INSUFFICIENT');
      expect((await batches(product))[0]?.remaining).toBe('10');
      expect((await pools(product)).stock).toBe('10');
    });
  });

  describe('unknown-cost stock', () => {
    it('keeps found bags out of the cost, and a later purchase does not price them', async () => {
      const product = await newProduct();
      await post('owner', 'stock/adjustments', {
        productId: product,
        quantity: '10',
        reason: 'ten bags found during the count',
      }).expect(201);
      await buy(product, '100', '580');
      const rows = await batches(product);
      expect(rows.map((row) => [row.sourceType, row.unitCost, row.remaining])).toEqual([
        ['adjustment', null, '10'],
        ['purchase', '580', '100'],
      ]);
      expect(await pools(product)).toMatchObject({
        stock: '110',
        costedQuantity: '100',
        costedValue: '58000',
        uncosted: '10',
      });
    });

    it('delivers them in their turn, flagged unknown (never zero), when stock suffices', async () => {
      const product = await newProduct();
      await post('owner', 'stock/adjustments', {
        productId: product,
        quantity: '10',
        reason: 'ten bags found during the count',
      }).expect(201);
      await buy(product, '100', '580');
      const before = await summary(TODAY, TODAY);

      const { deliveryId } = await sell(product, '15');
      const slices = await allocations(deliveryId);
      expect(slices[0]).toMatchObject({ quantity: '10', costAmount: null, costKnown: false });
      expect(slices[1]).toMatchObject({ quantity: '5', costAmount: '2900', costKnown: true });
      const line = await lineCost(deliveryId);
      expect(line).toMatchObject({ costAmount: '2900', uncosted: '10' });

      const after = await summary(TODAY, TODAY);
      expect(rise(after, before, 'uncostedQuantityDelivered')).toBe(10);
      expect(after['uncostedDeliveryLines']).not.toBe(before['uncostedDeliveryLines']);
    });

    it('a delivery of only unknown-cost bags has a null cost, not zero', async () => {
      const product = await newProduct();
      await post('owner', 'stock/adjustments', {
        productId: product,
        quantity: '10',
        reason: 'ten bags found during the count',
      }).expect(201);
      const { deliveryId } = await sell(product, '4');
      expect(await lineCost(deliveryId)).toMatchObject({
        costAmount: null,
        unitCost: null,
        uncosted: '4',
      });
    });

    it('a negative adjustment takes the oldest bags out of the stock value, not out of cost of sales', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      await buy(product, '100', '600');
      const before = await summary(TODAY, TODAY);
      await post('owner', 'stock/adjustments', {
        productId: product,
        quantity: '-10',
        reason: 'ten bags damaged',
      }).expect(201);
      expect((await batches(product)).map((row) => row.remaining)).toEqual(['90', '100']);
      const after = await summary(TODAY, TODAY);
      expect(after['cogs']).toBe(before['cogs']);
    });
  });

  describe('stock from before batches existed', () => {
    it('is delivered first, unknown-cost, and never blocks a delivery (no 500)', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      await makeLegacy(product);
      expect(await pools(product)).toMatchObject({ stock: '100', costedQuantity: '0' });

      await buy(product, '100', '570');
      const { deliveryId } = await sell(product, '120');
      // 100 legacy bags (cost unknown) then 20 @ 570.
      const slices = await allocations(deliveryId);
      expect(
        slices.map((slice) => [slice.batchId === null, slice.quantity, slice.costAmount]),
      ).toEqual([
        [true, '100', null],
        [false, '20', '11400'],
      ]);
      expect(await lineCost(deliveryId)).toMatchObject({ costAmount: '11400', uncosted: '100' });
      expect(await pools(product)).toMatchObject({
        stock: '80',
        costedQuantity: '80',
        uncosted: '0',
      });
    });
  });

  describe('voids and cuts', () => {
    it('a voided delivery puts the bags back in the batches they left, at the cost they left with', async () => {
      const product = await newProduct();
      await buy(product, '100', '570');
      await buy(product, '100', '580');
      const { deliveryId } = await sell(product, '120');
      await buy(product, '100', '900');
      const snapshot = await lineCost(deliveryId);

      await approve({
        entityType: 'delivery',
        entityId: deliveryId,
        kind: 'void',
        reason: 'the truck came back loaded',
      });

      expect((await batches(product)).map((row) => row.remaining)).toEqual(['100', '100', '100']);
      const slices = await allocations(deliveryId);
      expect(
        slices.filter((slice) => slice.kind === 'reversal').map((slice) => slice.quantity),
      ).toEqual(['-20', '-100']);
      // The snapshot is a fact about the delivery and stays; the void takes the line out of the totals.
      expect(await lineCost(deliveryId)).toEqual({ ...snapshot, status: 'void' });
      expect(await pools(product)).toMatchObject({ stock: '300', costedValue: '205000' });
    });

    it('cutting a delivery line returns the last bags drawn, to their own batch', async () => {
      const product = await newProduct();
      await buy(product, '100', '570');
      await buy(product, '100', '580');
      const { deliveryId } = await sell(product, '120');
      const line = await lineCost(deliveryId);
      await approve({
        entityType: 'delivery',
        entityId: deliveryId,
        kind: 'edit',
        reason: 'ten bags were refused',
        proposedChange: { [`items.${line.id}.quantity`]: '110' },
      });
      expect((await batches(product)).map((row) => row.remaining)).toEqual(['0', '90']);
      // What the delivery itself consumed is now 100 @ 570 + 10 @ 580.
      expect((await lineCost(deliveryId)).costAmount).toBe('62800');
    });
  });

  describe('corrections to history', () => {
    it('a price edit changes the batch, books the difference, and leaves every original row alone', async () => {
      const product = await newProduct();
      const purchase = await buy(product, '100', '500');
      const { deliveryId } = await sell(product, '40');
      const snapshot = await lineCost(deliveryId);
      const original = await allocations(deliveryId);
      expect(snapshot.costAmount).toBe('20000');

      await approve({
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'the challan says 560, not 500',
        proposedChange: { [`items.${purchase.items[0]?.id ?? ''}.unitPrice`]: '560' },
      });

      // Original facts: the frozen snapshot and the original allocation are untouched.
      expect(await lineCost(deliveryId)).toEqual(snapshot);
      const slices = await allocations(deliveryId);
      expect(slices[0]).toEqual(original[0]);
      // The adjustment is appended: no bags moved, 2,400 more cost.
      expect(slices[1]).toMatchObject({ kind: 'adjustment', quantity: '0', costAmount: '2400' });

      const rows = await corrections(product);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('purchase_edit');
      expect(money(rows[0]?.cogsDelta.toString() ?? null)).toBe(2400);
      expect(money(rows[0]?.stockValueDelta.toString() ?? null)).toBe(-2400);
      expect(rows[0]?.correctionDate.toISOString().slice(0, 10)).toBe(TODAY);

      // The batch shows the corrected price; what was entered is kept.
      expect((await batches(product))[0]).toMatchObject({
        unitCost: '560',
        originalUnitCost: '500',
        remaining: '60',
      });
      expect(await pools(product)).toMatchObject({ costedValue: '33600' });
    });

    it('a second edit books only its own difference, not the first one again', async () => {
      const product = await newProduct();
      const purchase = await buy(product, '100', '500');
      await sell(product, '40');
      const edit = (price: string) =>
        approve({
          entityType: 'purchase',
          entityId: purchase.id,
          kind: 'edit',
          reason: `price ${price}`,
          proposedChange: { [`items.${purchase.items[0]?.id ?? ''}.unitPrice`]: price },
        });
      await edit('560');
      await edit('580');
      const rows = await corrections(product);
      expect(rows.map((row) => money(row.cogsDelta.toString()))).toEqual([2400, 800]);
    });

    it('voiding a purchase nobody drew from changes no cost of sales and books no correction', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      const second = await buy(product, '100', '700');
      await approve({
        entityType: 'purchase',
        entityId: second.id,
        kind: 'void',
        reason: 'this delivery never arrived',
      });
      expect(await pools(product)).toMatchObject({ costedQuantity: '100', costedValue: '50000' });
      expect(await corrections(product)).toHaveLength(0);
      const rows = await batches(product);
      expect(rows[1]).toMatchObject({ received: '0', remaining: '0', originalQuantity: '100' });
      const events = await t.prisma.forBusiness(shop.id).inventoryBatchEvent.findMany({
        where: { batchId: rows[1]?.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((event) => [event.eventType, event.valueDelta.toString()])).toEqual([
        ['received', '70000'],
        ['void', '-70000'],
      ]);
    });

    it('a purchase dated after a delivery makes it draw the next batch: adjusted, not rewritten', async () => {
      const product = await newProduct();
      const january = await buy(product, '100', '400', '2026-01-10');
      await buy(product, '100', '800', '2026-06-10');
      const customerId = await newCustomer();
      const order = (
        await post('owner', 'orders', {
          customerId,
          orderDate: '2026-07-01',
          deliveryWindow: 'two_days',
          items: [{ productId: product, quantity: '50', unitPrice: '900' }],
        }).expect(201)
      ).body as OrderBody;
      const delivery = (
        await post('owner', 'deliveries', {
          orderId: order.id,
          items: [{ orderItemId: order.items[0]?.id, quantity: '50' }],
          deliveryDate: '2026-07-05',
        }).expect(201)
      ).body as { id: string };
      const snapshot = await lineCost(delivery.id);
      expect(snapshot.costAmount).toBe('20000'); // 50 from the January batch @ 400

      // The January challan turns out to be dated August, after the delivery.
      await approve({
        entityType: 'purchase',
        entityId: january.id,
        kind: 'edit',
        reason: 'the challan is dated August',
        proposedChange: { purchaseDate: '2026-08-10' },
      });

      expect(await lineCost(delivery.id)).toEqual(snapshot);
      const rows = await corrections(product);
      expect(rows).toHaveLength(1);
      // 50 bags really came from the June batch @ 800: 20,000 more than was reported.
      expect(money(rows[0]?.cogsDelta.toString() ?? null)).toBe(20000);
      expect(rows[0]?.correctionDate.toISOString().slice(0, 10)).toBe(TODAY);
      expect(rows[0]?.effectiveDate.toISOString().slice(0, 10)).toBe('2026-06-10');
      // Rows written together have no defined order among themselves; compare by size.
      const slices = (await allocations(delivery.id))
        .filter((slice) => slice.kind === 'adjustment')
        .sort((a, b) => Number(a.quantity) - Number(b.quantity));
      expect(slices.map((slice) => [slice.quantity, slice.costAmount, slice.revenue])).toEqual([
        ['-50', '-20000', '-45000'],
        ['50', '40000', '45000'],
      ]);
      // The January batch keeps what was entered and shows its corrected date.
      expect(
        (await batches(product)).find((row) => row.originalDate === '2026-01-10'),
      ).toMatchObject({
        date: '2026-08-10',
        originalDate: '2026-01-10',
        remaining: '100',
      });
    });

    it('a purchase entered today but dated earlier is drawn first, and the difference is booked', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      const { deliveryId } = await sell(product, '50');
      const snapshot = await lineCost(deliveryId);
      expect(snapshot.costAmount).toBe('25000');

      await buy(product, '100', '400', '2026-01-01');
      expect(await lineCost(deliveryId)).toEqual(snapshot);
      const rows = await corrections(product);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('backdated_entry');
      // Oldest first: the 50 bags were really the cheaper January ones, 5,000 less.
      expect(money(rows[0]?.cogsDelta.toString() ?? null)).toBe(-5000);
      expect((await batches(product)).map((row) => [row.unitCost, row.remaining])).toEqual([
        ['400', '50'],
        ['500', '100'],
      ]);
    });
  });

  describe('business-date chronology', () => {
    it('draws a backdated purchase first, whenever it was typed in', async () => {
      const product = await newProduct();
      await buy(product, '100', '400', '2026-01-01');
      await buy(product, '100', '800');
      const { deliveryId } = await sell(product, '50');
      expect((await lineCost(deliveryId)).costAmount).toBe('20000');
    });

    it('refuses a delivery dated before the product had any stock', async () => {
      const product = await newProduct();
      await buy(product, '100', '500', '2026-06-01');
      const customerId = await newCustomer();
      const order = (
        await post('owner', 'orders', {
          customerId,
          orderDate: '2026-02-01',
          deliveryWindow: 'two_days',
          items: [{ productId: product, quantity: '10', unitPrice: '900' }],
        }).expect(201)
      ).body as OrderBody;
      const response = await post('owner', 'deliveries', {
        orderId: order.id,
        items: [{ orderItemId: order.items[0]?.id, quantity: '10' }],
        deliveryDate: '2026-03-01',
      });
      expect(response.status).toBe(409);
      expect((response.body as { code: string }).code).toBe('BACKDATED_STOCK_NEGATIVE');
      expect((response.body as { details: { date: string } }).details.date).toBe('2026-03-01');
      // The whole transaction rolled back: no stock moved, no line was written.
      expect((await pools(product)).stock).toBe('100');
      expect((await batches(product))[0]?.remaining).toBe('100');
    });

    it('allows the same delivery once it is dated after the purchase', async () => {
      const product = await newProduct();
      await buy(product, '100', '500', '2026-06-01');
      const customerId = await newCustomer();
      const order = (
        await post('owner', 'orders', {
          customerId,
          orderDate: '2026-02-01',
          deliveryWindow: 'two_days',
          items: [{ productId: product, quantity: '10', unitPrice: '900' }],
        }).expect(201)
      ).body as OrderBody;
      const delivery = (
        await post('owner', 'deliveries', {
          orderId: order.id,
          items: [{ orderItemId: order.items[0]?.id, quantity: '10' }],
          deliveryDate: '2026-07-01',
        }).expect(201)
      ).body as { id: string };
      expect((await lineCost(delivery.id)).costAmount).toBe('5000');
    });
  });

  describe('the finance summary', () => {
    it('reports profit as sales minus cost of goods sold, minus expenses, plus commission', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      const before = await summary(TODAY, TODAY);
      await sell(product, '40'); // 40 × 900 = 36,000 revenue, 20,000 cost
      const body = await summary(TODAY, TODAY);

      expect(rise(body, before, 'sales')).toBe(36000);
      expect(rise(body, before, 'cogs')).toBe(20000);
      const identity =
        Number(body['sales']) -
        Number(body['cogs']) -
        Number(body['expenses']) +
        Number(body['commissionReceived']);
      expect(Number(body['netProfit'])).toBeCloseTo(identity, 2);
      // Unsold stock is an asset, never a cost: the whole purchase is not deducted.
      expect(Number(body['totalPurchase'])).toBeGreaterThan(Number(body['cogs']));
    });

    it('counts each month and All Time from delivery dates, not purchase dates', async () => {
      const product = await newProduct();
      await buy(product, '100', '500', '2025-02-01');
      const customerId = await newCustomer();
      const deliver = async (date: string, quantity: string) => {
        const order = (
          await post('owner', 'orders', {
            customerId,
            orderDate: date,
            deliveryWindow: 'two_days',
            items: [{ productId: product, quantity, unitPrice: '900' }],
          }).expect(201)
        ).body as OrderBody;
        await post('owner', 'deliveries', {
          orderId: order.id,
          items: [{ orderItemId: order.items[0]?.id, quantity }],
          deliveryDate: date,
        }).expect(201);
      };
      await deliver('2025-03-10', '10');
      await deliver('2025-04-10', '20');
      const march = await summary('2025-03-01', '2025-03-31');
      const april = await summary('2025-04-01', '2025-04-30');
      const both = await summary('2025-03-01', '2025-04-30');
      expect([march['sales'], march['cogs']]).toEqual(['9000.00', '5000.00']);
      expect([april['sales'], april['cogs']]).toEqual(['18000.00', '10000.00']);
      expect([both['sales'], both['cogs']]).toEqual(['27000.00', '15000.00']);
      // The February purchase is stock, not a cost, in every one of those windows.
      expect(march['totalPurchase']).toBe('0.00');
    });

    it('hides cost and profit from a manager, who has no profit.view', async () => {
      const body = await summary(TODAY, TODAY, 'manager');
      expect(body['sales']).toBeDefined();
      expect(body['cogs']).toBeUndefined();
      expect(body['netProfit']).toBeUndefined();
      expect(body['currentStockValue']).toBeUndefined();
    });
  });
});

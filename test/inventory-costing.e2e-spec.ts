import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { todayIn } from '../src/core/common/business-time';
import { hasDatabase } from './database';
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
 * Moving weighted average cost against the real database: what a delivery cost,
 * what the stock left behind is worth, and what happens when history is
 * corrected after the fact.
 */
describe.skipIf(!hasDatabase)('inventory costing', () => {
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
      average: row.costedQuantity.isZero()
        ? null
        : row.costedValue.div(row.costedQuantity).toDecimalPlaces(6).toString(),
    };
  }

  async function lineCost(deliveryId: string) {
    const row = await t.prisma.forBusiness(shop.id).deliveryItem.findFirstOrThrow({
      where: { deliveryId },
      select: { unitCost: true, costAmount: true, uncostedQuantity: true, status: true },
    });
    return {
      unitCost: row.unitCost?.toString() ?? null,
      costAmount: row.costAmount?.toString() ?? null,
      uncosted: row.uncostedQuantity.toString(),
      status: row.status,
    };
  }

  const corrections = async (productId: string) =>
    t.prisma.forBusiness(shop.id).inventoryCostCorrection.findMany({
      where: { productId },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, cogsDelta: true, correctionDate: true, effectiveDate: true },
    });

  const requestChange = (who_: string, body: object) => post(who_, 'change-requests', body);
  const decide = (who_: string, id: string, action: 'approve' | 'reject') =>
    post(who_, `change-requests/${id}/${action}`, { note: 'ok' });

  /** The pools always add up to the stock on hand. */
  async function expectPoolsReconcile() {
    const rows = await t.prisma.client.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT costed_quantity + uncosted_quantity = current_stock AS ok
         FROM products WHERE business_id = $1::uuid`,
      shop.id,
    );
    expect(rows.every((row) => row.ok)).toBe(true);
  }

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

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('the weighted average', () => {
    it('re-averages on a second purchase at a different price', async () => {
      const product = await newProduct();
      await buy(product, '30', '670');
      expect(await pools(product)).toMatchObject({
        costedQuantity: '30',
        costedValue: '20100',
        average: '670',
      });

      await buy(product, '100', '580');
      expect(await pools(product)).toMatchObject({
        stock: '130',
        costedQuantity: '130',
        costedValue: '78100',
        average: '600.769231',
      });
      await expectPoolsReconcile();
    });

    it('costs a delivery at the average of that moment and leaves the rest behind', async () => {
      const product = await newProduct();
      await buy(product, '30', '670');
      await buy(product, '100', '580');
      const { deliveryId } = await sell(product, '50');

      const line = await lineCost(deliveryId);
      expect(line.unitCost).toBe('600.769231');
      expect(Number(line.costAmount)).toBeCloseTo(30038.46, 2);
      expect(line.uncosted).toBe('0');

      const after = await pools(product);
      expect(after.costedQuantity).toBe('80');
      expect(Number(after.costedValue)).toBeCloseTo(48061.54, 2);
      expect(after.average).toBe('600.769231');
      await expectPoolsReconcile();
    });

    it('uses only what is left when some was sold before the new purchase', async () => {
      const product = await newProduct();
      await buy(product, '30', '670');
      const { deliveryId } = await sell(product, '10');
      expect((await lineCost(deliveryId)).costAmount).toBe('6700');

      await buy(product, '100', '580');
      expect(await pools(product)).toMatchObject({
        costedQuantity: '120',
        costedValue: '71400',
        average: '595',
      });
    });

    it('does not change what an earlier delivery already cost', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      const { deliveryId } = await sell(product, '50');
      const before = await lineCost(deliveryId);
      expect(before.costAmount).toBe('25000');

      await buy(product, '100', '900');
      expect((await pools(product)).average).toBe('766.666667');
      // The snapshot is frozen: a later purchase never rewrites it.
      expect(await lineCost(deliveryId)).toEqual(before);
    });
  });

  describe('uncosted stock', () => {
    it('keeps found bags out of the average, and a later purchase does not price them', async () => {
      const product = await newProduct();
      await post('owner', 'stock/adjustments', {
        productId: product,
        quantity: '10',
        reason: 'ten bags found during the count',
      }).expect(201);
      expect(await pools(product)).toMatchObject({
        stock: '10',
        costedQuantity: '0',
        uncosted: '10',
        average: null,
      });

      await buy(product, '100', '580');
      // 580, not 58,000 / 110 = 527.27.
      expect(await pools(product)).toMatchObject({
        stock: '110',
        costedQuantity: '100',
        uncosted: '10',
        average: '580',
      });
      await expectPoolsReconcile();
    });

    it('takes costed bags first and flags the ones with no cost basis', async () => {
      const product = await newProduct();
      await post('owner', 'stock/adjustments', {
        productId: product,
        quantity: '10',
        reason: 'ten bags found during the count',
      }).expect(201);
      await buy(product, '100', '580');

      const first = await sell(product, '100');
      expect((await lineCost(first.deliveryId)).costAmount).toBe('58000');
      expect((await lineCost(first.deliveryId)).uncosted).toBe('0');

      // Only the uncosted bags are left; the next delivery has no cost basis
      // and says so instead of pretending the bags were free.
      const second = await sell(product, '4');
      const line = await lineCost(second.deliveryId);
      expect(line.costAmount).toBe('0');
      expect(line.uncosted).toBe('4');
      expect(line.unitCost).toBeNull();
      await expectPoolsReconcile();
    });
  });

  describe('corrections to history', () => {
    it('re-costs later deliveries after a price edit, without touching the snapshot', async () => {
      const product = await newProduct();
      const purchase = await buy(product, '100', '500');
      const { deliveryId } = await sell(product, '40');
      const snapshot = await lineCost(deliveryId);
      expect(snapshot.costAmount).toBe('20000');

      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'the challan says 560, not 500',
        proposedChange: { [`items.${purchase.items[0]?.id ?? ''}.unitPrice`]: '560' },
      }).expect(201);
      await decide('owner', (created.body as { id: string }).id, 'approve').expect(200);

      // The snapshot is history and stays as it was reported.
      expect(await lineCost(deliveryId)).toEqual(snapshot);

      // The difference is booked as a correction, dated today.
      const rows = await corrections(product);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('purchase_edit');
      // 40 bags should have cost 560 each, not 500: 2,400 more.
      expect(Number(rows[0]?.cogsDelta)).toBeCloseTo(2400, 2);
      expect(rows[0]?.correctionDate.toISOString().slice(0, 10)).toBe(TODAY);

      // And the stock still on hand is revalued at the corrected price.
      expect((await pools(product)).average).toBe('560');
      await expectPoolsReconcile();
    });

    it('re-costs after a purchase is voided', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      const second = await buy(product, '100', '700');
      expect((await pools(product)).average).toBe('600');

      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: second.id,
        kind: 'void',
        reason: 'this delivery never arrived',
      }).expect(201);
      await decide('owner', (created.body as { id: string }).id, 'approve').expect(200);

      // The voided bags leave at the 700 they came in at, so what is left is
      // the original 100 at 500 — not the blended 600 smeared across them.
      expect(await pools(product)).toMatchObject({ costedQuantity: '100', average: '500' });
      // Nothing is booked as a correction: the void is dated today and no
      // delivery had drawn on those bags, so no past cost of goods sold moved.
      // A correction row with no money in it would be noise.
      expect(await corrections(product)).toHaveLength(0);
      await expectPoolsReconcile();
    });

    it('books a correction when a backdated purchase date reorders the history', async () => {
      const product = await newProduct();
      // Cheap bags in January, dear ones in June, then a delivery in July that
      // draws on the blend of both.
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
      expect(snapshot.costAmount).toBe('30000'); // 50 × the 600 blend

      // The January challan turns out to be dated August — after the delivery.
      // Those cheap bags were never there to be sold, so the delivery really
      // cost 800 each, and the difference is booked today.
      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: january.id,
        kind: 'edit',
        reason: 'the challan is dated August',
        proposedChange: { purchaseDate: '2026-08-10' },
      }).expect(201);
      await decide('owner', (created.body as { id: string }).id, 'approve').expect(200);

      expect(await lineCost(delivery.id)).toEqual(snapshot);
      const rows = await corrections(product);
      expect(rows).toHaveLength(1);
      // 50 bags at 800 instead of 600: 10,000 more than was reported.
      expect(Number(rows[0]?.cogsDelta)).toBeCloseTo(10000, 2);
      expect(rows[0]?.correctionDate.toISOString().slice(0, 10)).toBe(TODAY);
      expect(rows[0]?.effectiveDate.toISOString().slice(0, 10)).toBe('2026-06-10');
      await expectPoolsReconcile();
    });

    it('a voided delivery puts the value back at the cost it left with', async () => {
      const product = await newProduct();
      await buy(product, '100', '500');
      const { deliveryId } = await sell(product, '40');
      // Buying dearer afterwards must not change what the return is worth.
      await buy(product, '100', '900');
      const beforeVoid = await pools(product);

      const created = await requestChange('manager', {
        entityType: 'delivery',
        entityId: deliveryId,
        kind: 'void',
        reason: 'the truck came back loaded',
      }).expect(201);
      await decide('owner', (created.body as { id: string }).id, 'approve').expect(200);

      const after = await pools(product);
      expect(Number(after.costedQuantity) - Number(beforeVoid.costedQuantity)).toBeCloseTo(40, 3);
      // 40 bags return at the 500 they left at, not at today's average.
      expect(Number(after.costedValue) - Number(beforeVoid.costedValue)).toBeCloseTo(20000, 2);
      expect((await lineCost(deliveryId)).status).toBe('void');
      await expectPoolsReconcile();
    });
  });

  describe('business-date chronology', () => {
    it('costs a backdated purchase before a delivery that came after it', async () => {
      const product = await newProduct();
      // Entered now, but dated well before: it must still be the cheaper stock
      // the later delivery draws on.
      await buy(product, '100', '400', '2026-01-01');
      await buy(product, '100', '800');
      const { deliveryId } = await sell(product, '50');
      // Both purchases precede the delivery, so it costs the blended average.
      expect((await lineCost(deliveryId)).unitCost).toBe('600');
    });

    it('refuses a delivery dated before the product had any stock', async () => {
      const product = await newProduct();
      // Bought in June; the bags did not exist before that.
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

      // Delivering in March draws on stock that only arrived in June. Entry
      // order hides it — the purchase was typed in first — but on the business
      // timeline that day is short, and there is no average to cost it at.
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
      await expectPoolsReconcile();
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
      await sell(product, '40'); // 40 × 900 = 36,000 revenue, 20,000 cost

      const body = (
        await get(
          t.server,
          path(`dashboard/finance-summary?from=${TODAY}&to=${TODAY}`),
          who('owner'),
        ).expect(200)
      ).body as Record<string, string>;

      const identity =
        Number(body['sales']) -
        Number(body['cogs']) -
        Number(body['expenses']) +
        Number(body['commissionReceived']);
      expect(Number(body['netProfit'])).toBeCloseTo(identity, 2);
      // Unsold stock is an asset, never a cost: the whole purchase is not
      // deducted, only the 40 bags that left.
      expect(Number(body['totalPurchase'])).toBeGreaterThan(Number(body['cogs']));
      expect(Number(body['currentStockValue'])).toBeGreaterThan(0);
    });

    it('hides cost and profit from a manager, who has no profit.view', async () => {
      const body = (
        await get(
          t.server,
          path(`dashboard/finance-summary?from=${TODAY}&to=${TODAY}`),
          who('manager'),
        ).expect(200)
      ).body as Record<string, unknown>;
      expect(body['sales']).toBeDefined();
      expect(body['cogs']).toBeUndefined();
      expect(body['netProfit']).toBeUndefined();
      expect(body['currentStockValue']).toBeUndefined();
    });
  });
});

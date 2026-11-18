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

interface StockItem {
  id: string;
  code: string;
  currentStock: string;
  lastPurchasePrice?: string | null;
  lastPurchasedAt?: string | null;
}
interface Movement {
  kind: string;
  quantity: string;
  balanceAfter: string;
  movementDate: string;
  source: { type: string; id: string | null; code: string | null };
  reason: string | null;
}

const TODAY = todayIn('Asia/Dhaka');

describe.skipIf(!hasDatabase)('stock', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string, slug = shop.slug) => `/b/${slug}/${suffix}`;

  async function member(name: string, roleKey: string | null, businessId = shop.id) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) {
      await data.giveAccess(user.id, businessId, roleKey);
    }
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const newProduct = async (nameEn = `Cement ${String(Math.random()).slice(2, 10)}`) =>
    (
      (
        await send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameEn,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string; code: string }
    ).id;

  const buy = async (productId: string, quantity: string, unitPrice = '570') =>
    (
      await send(t.server, 'post', path('purchases'), who('ownerRole'), {
        items: [{ productId, quantity, unitPrice }],
      }).expect(201)
    ).body as { id: string; code: string };

  const adjust = (who_: string, productId: string, quantity: string, reason = 'Torn bags') =>
    send(t.server, 'post', path('stock/adjustments'), who(who_), { productId, quantity, reason });

  beforeAll(async () => {
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('stock');
    other = await data.createBusiness('stock-other');
    await runSeed();
    await member('owner', null);
    await member('ownerRole', 'owner');
    await member('manager', 'manager');
    await member('manager2', 'manager');
    await member('salesman', 'salesman');
    await member('accountant', 'accountant');
    await member('otherManager', 'manager', other.id);
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

  it('lists stock per product; the salesman sees quantities, never prices', async () => {
    const opc = await newProduct('Stock List OPC');
    await buy(opc, '120', '571.50');
    const forManager = await get(
      t.server,
      path('stock?search=stock%20list'),
      who('manager'),
    ).expect(200);
    const item = (forManager.body as { items: StockItem[] }).items[0];
    expect(item).toMatchObject({ id: opc, currentStock: '120', lastPurchasePrice: '571.50' });
    const forSalesman = await get(
      t.server,
      path('stock?search=stock%20list'),
      who('salesman'),
    ).expect(200);
    const seen = (forSalesman.body as { items: StockItem[] }).items[0];
    expect(seen?.currentStock).toBe('120');
    expect(seen).not.toHaveProperty('lastPurchasePrice');
    expect(seen).not.toHaveProperty('lastPurchasedAt');
    expect(JSON.stringify(forSalesman.body)).not.toContain('571.50');
    await get(t.server, path('stock'), who('accountant')).expect(403);
  });

  it('shows a product’s history newest first, with balances and purchase numbers', async () => {
    const opc = await newProduct();
    const purchase = await buy(opc, '50');
    await adjust('manager', opc, '-2', 'Two bags torn in the rain').expect(201);
    const response = await get(t.server, path(`stock/${opc}/movements`), who('salesman')).expect(
      200,
    );
    const body = response.body as { product: StockItem; items: Movement[]; total: number };
    expect(body.product.currentStock).toBe('48');
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({
      kind: 'adjustment',
      quantity: '-2',
      balanceAfter: '48',
      movementDate: TODAY,
      source: { type: 'adjustment', id: null, code: null },
      reason: 'Two bags torn in the rain',
    });
    expect(body.items[1]).toMatchObject({
      kind: 'purchase',
      quantity: '50',
      balanceAfter: '50',
      source: { type: 'purchase', id: purchase.id, code: purchase.code },
    });
    const filtered = await get(
      t.server,
      path(`stock/${opc}/movements?kind=purchase`),
      who('manager'),
    ).expect(200);
    expect((filtered.body as { total: number }).total).toBe(1);
    const missing = await get(
      t.server,
      path('stock/00000000-0000-7000-8000-000000000000/movements'),
      who('manager'),
    ).expect(404);
    expect(missing.body).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    await get(t.server, path(`stock/${opc}/movements`, other.slug), who('otherManager')).expect(
      404,
    );
  });

  describe('adjustments', () => {
    it('needs a reason, never takes stock below zero, and is audited', async () => {
      const opc = await newProduct();
      await buy(opc, '5');
      const noReason = await send(t.server, 'post', path('stock/adjustments'), who('manager'), {
        productId: opc,
        quantity: '-1',
      }).expect(400);
      expect((noReason.body as { errors: { field: string }[] }).errors[0]?.field).toBe('reason');
      const zero = await adjust('manager', opc, '0').expect(400);
      expect(zero.body).toMatchObject({ code: 'QUANTITY_INVALID', field: 'quantity' });
      const below = await adjust('ownerRole', opc, '-6').expect(409);
      expect(below.body).toMatchObject({
        code: 'STOCK_INSUFFICIENT',
        field: 'quantity',
        details: { available: '5', required: '6' },
      });
      await adjust('salesman', opc, '-1').expect(403);
      const done = await adjust('manager', opc, '-1', 'One bag torn').expect(201);
      expect((done.body as StockItem).currentStock).toBe('4');
      const audit = await t.prisma.client.auditLog.findFirstOrThrow({
        where: { businessId: shop.id, action: 'stock.adjusted', entityId: opc },
        select: { changes: true },
      });
      expect(audit.changes).toMatchObject({
        quantity: '-1',
        before: '5',
        after: '4',
        reason: 'One bag torn',
      });
    });

    it('limits each person to 10 bags per product per day, however it is split', async () => {
      const opc = await newProduct();
      await buy(opc, '100');
      await adjust('manager', opc, '-4').expect(201);
      await adjust('manager', opc, '3').expect(201);
      await adjust('manager', opc, '-3').expect(201); // 4 + 3 + 3 = 10: at the limit
      const over = await adjust('manager', opc, '-1').expect(403);
      expect(over.body).toMatchObject({
        code: 'ADJUSTMENT_APPROVAL_REQUIRED',
        field: 'quantity',
        details: { limit: '10', usedToday: '10' },
      });
      // Another person has their own allowance; another product too.
      await adjust('manager2', opc, '-5').expect(201);
      const other = await newProduct();
      await buy(other, '20');
      await adjust('manager', other, '-10').expect(201);
      // The owner level adjusts without a limit.
      await adjust('ownerRole', opc, '-30').expect(201);
      const stock = await get(t.server, path(`stock/${opc}/movements`), who('manager')).expect(200);
      expect((stock.body as { product: StockItem }).product.currentStock).toBe('61');
    });

    it('sends a larger adjustment as a change request that the owner approves', async () => {
      const opc = await newProduct();
      await buy(opc, '200');
      const asked = await request(t.server)
        .post(`/api/v1${path('change-requests')}`)
        .set('Cookie', cookieHeader(who('manager')))
        .send({
          entityType: 'product_stock',
          entityId: opc,
          kind: 'edit',
          reason: 'Thirty bags spoiled by water in the store',
          proposedChange: { adjustBy: '-30' },
        })
        .expect(201);
      const body = asked.body as {
        id: string;
        impact: { key: string; before: string; after: string }[];
      };
      expect(body.impact[0]).toMatchObject({ before: '200', after: '170' });
      // A purchase in between does not make it stale: it is an amount, not a target.
      await buy(opc, '10');
      await send(
        t.server,
        'post',
        path(`change-requests/${body.id}/approve`),
        who('manager2'),
      ).expect(403);
      await send(t.server, 'post', path(`change-requests/${body.id}/approve`), who('owner')).expect(
        200,
      );
      const after = await get(t.server, path(`stock/${opc}/movements`), who('manager')).expect(200);
      const history = after.body as { product: StockItem; items: Movement[] };
      expect(history.product.currentStock).toBe('180');
      expect(history.items[0]).toMatchObject({
        kind: 'adjustment',
        quantity: '-30',
        reason: 'Thirty bags spoiled by water in the store',
      });
      const bad = await request(t.server)
        .post(`/api/v1${path('change-requests')}`)
        .set('Cookie', cookieHeader(who('manager')))
        .send({
          entityType: 'product_stock',
          entityId: opc,
          kind: 'edit',
          reason: 'half a bag',
          proposedChange: { adjustBy: '-0.5' },
        })
        .expect(400);
      expect(bad.body).toMatchObject({
        code: 'ADJUST_BY_INVALID',
        field: 'proposedChange.adjustBy',
      });
    });
  });

  it('keeps current stock equal to the movements for every product', async () => {
    const rows = await t.prisma.client.$queryRawUnsafe<{ stock: string; total: string | null }[]>(
      `SELECT p.current_stock::text AS stock,
              (SELECT sum(m.quantity)::text FROM stock_movements m
                WHERE m.business_id = p.business_id AND m.product_id = p.id) AS total
         FROM products p WHERE p.business_id = $1::uuid`,
      shop.id,
    );
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(Number(row.total ?? 0)).toBe(Number(row.stock));
    }
  });
});

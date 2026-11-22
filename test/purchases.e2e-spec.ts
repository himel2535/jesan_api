import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, dayStartIn, todayIn } from '../src/core/common/business-time';
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

interface Line {
  id: string;
  product: { id: string; code: string };
  quantity: string;
  unitPrice?: string;
  lineTotal?: string;
}
interface PurchaseBody {
  id: string;
  code: string;
  purchaseDate: string;
  status: string;
  totalQuantity: string;
  totalAmount?: string;
  itemCount: number;
  supplier: { id: string; code: string };
  items: Line[];
  version: number;
}
interface ErrorBody {
  code: string;
  field?: string;
  details?: { productId: string; available: string; required: string };
}

const TODAY = todayIn('Asia/Dhaka');

describe.skipIf(!hasDatabase)('purchases', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string, slug = shop.slug) => `/b/${slug}/${suffix}`;

  async function member(name: string, roleKey: string | null, businessId?: string) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey && businessId) {
      await data.giveAccess(user.id, businessId, roleKey);
    }
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const newProduct = async (slug = shop.slug, category = categoryId) =>
    (
      (
        await send(t.server, 'post', path('products', slug), who('owner'), {
          categoryId: category,
          nameEn: `Cement ${String(Math.random()).slice(2, 10)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string; code: string }
    ).id;

  const buy = (
    who_: string,
    items: { productId: string; quantity: string; unitPrice: string }[],
    extra: object = {},
    headers: Record<string, string> = {},
    slug = shop.slug,
  ) => {
    let call = request(t.server)
      .post(`/api/v1${path('purchases', slug)}`)
      .set('Cookie', cookieHeader(who(who_)));
    for (const [name, value] of Object.entries(headers)) {
      call = call.set(name, value);
    }
    return call.send({ items, ...extra });
  };

  /** current_stock, the sum of movements and the last balance_after must agree. */
  async function expectConsistent(businessId = shop.id) {
    const rows = await t.prisma.client.$queryRawUnsafe<
      { id: string; stock: string; total: string | null; last: string | null }[]
    >(
      `SELECT p.id, p.current_stock::text AS stock,
              (SELECT sum(m.quantity)::text FROM stock_movements m
                WHERE m.business_id = p.business_id AND m.product_id = p.id) AS total,
              (SELECT m.balance_after::text FROM stock_movements m
                WHERE m.business_id = p.business_id AND m.product_id = p.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last
         FROM products p WHERE p.business_id = $1::uuid`,
      businessId,
    );
    for (const row of rows) {
      expect(Number(row.total ?? 0)).toBe(Number(row.stock));
      expect(Number(row.last ?? 0)).toBe(Number(row.stock));
    }
  }

  async function stockOf(productId: string) {
    const row = await t.prisma.forBusiness(shop.id).product.findUniqueOrThrow({
      where: { id: productId },
      select: { currentStock: true, lastPurchasePrice: true, lastPurchasedAt: true },
    });
    return {
      stock: row.currentStock.toString(),
      lastPrice: row.lastPurchasePrice?.toFixed(2) ?? null,
      lastAt: row.lastPurchasedAt?.toISOString() ?? null,
    };
  }

  async function counter(period: number, businessId = shop.id) {
    const row = await t.prisma
      .forBusiness(businessId)
      .monthlyPurchaseCounter.findFirst({ where: { period }, select: { quantity: true } });
    return row?.quantity.toString() ?? '0';
  }

  beforeAll(async () => {
    await runSeed(); // roles must exist before a business gets its default grants
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('buy');
    other = await data.createBusiness('buy-other');
    await runSeed(); // creates each business's principal supplier
    await member('owner', null);
    await member('ownerRole', 'owner', shop.id);
    await member('manager', 'manager', shop.id);
    await member('accountant', 'accountant', shop.id);
    await member('salesman', 'salesman', shop.id);
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

  describe('creating a purchase', () => {
    it('adds stock, movements, the month counter and the last purchase price in one go', async () => {
      const opc = await newProduct();
      const pcc = await newProduct();
      const response = await buy('manager', [
        { productId: opc, quantity: '500', unitPrice: '570' },
        { productId: pcc, quantity: '200', unitPrice: '545.50' },
      ]).expect(201);
      const body = response.body as PurchaseBody;
      expect(body).toMatchObject({
        code: expect.stringMatching(/^PUR-\d{4}$/) as string,
        purchaseDate: TODAY,
        status: 'active',
        totalQuantity: '700',
        totalAmount: '394100.00',
        itemCount: 2,
        supplier: { code: expect.any(String) as string },
      });
      expect(body.items.map((line) => [line.quantity, line.unitPrice, line.lineTotal])).toEqual([
        ['500', '570.00', '285000.00'],
        ['200', '545.50', '109100.00'],
      ]);

      expect(await stockOf(opc)).toEqual({
        stock: '500',
        lastPrice: '570.00',
        lastAt: dayStartIn(TODAY, 'Asia/Dhaka').toISOString(),
      });
      expect((await stockOf(pcc)).stock).toBe('200');
      expect(await counter(Number(TODAY.slice(0, 4) + TODAY.slice(5, 7)))).toBe('700');

      const movements = await t.prisma.forBusiness(shop.id).stockMovement.findMany({
        where: { sourceId: body.id },
        select: { kind: true, quantity: true, balanceAfter: true, sourceType: true },
      });
      expect(movements).toHaveLength(2);
      expect(movements.every((m) => m.kind === 'purchase' && m.sourceType === 'purchase')).toBe(
        true,
      );
      await expectConsistent();
    });

    it('rounds line totals half up, the same as the database CHECK', async () => {
      const kgShop = await data.createBusiness('buy-kg', {
        units: [{ key: 'kg', nameEn: 'Kilogram', nameBn: 'কেজি', decimals: 3 }],
        defaultUnit: 'kg',
        principalSupplier: { nameEn: 'Rod Co', nameBn: 'রড কোম্পানি' },
      });
      await runSeed();
      const category = (
        (
          await send(t.server, 'post', path('product-categories', kgShop.slug), who('owner'), {
            nameEn: 'Rod',
            nameBn: 'রড',
          }).expect(201)
        ).body as { id: string }
      ).id;
      const rod = await newProduct(kgShop.slug, category);
      // 0.005 kg × 1.00 = 0.005 → 0.01; 1.235 × 0.10 = 0.1235 → 0.12; 2.5 × 0.03 = 0.075 → 0.08
      const cases: [string, string, string][] = [
        ['0.005', '1', '0.01'],
        ['1.235', '0.10', '0.12'],
        ['2.5', '0.03', '0.08'],
        ['12.345', '99.99', '1234.38'],
      ];
      for (const [quantity, unitPrice, expected] of cases) {
        const response = await buy(
          'owner',
          [{ productId: rod, quantity, unitPrice }],
          {},
          {},
          kgShop.slug,
        ).expect(201);
        expect((response.body as PurchaseBody).items[0]?.lineTotal).toBe(expected);
      }
      await buy(
        'owner',
        [{ productId: rod, quantity: '0.0001', unitPrice: '1' }],
        {},
        {},
        kgShop.slug,
      ).expect(400);
    });

    it('keeps the last purchase price on the newest purchase date, not the last typed', async () => {
      const opc = await newProduct();
      await buy('manager', [{ productId: opc, quantity: '10', unitPrice: '560' }]).expect(201);
      // An older purchase entered later does not change the last price.
      await buy('manager', [{ productId: opc, quantity: '10', unitPrice: '555' }], {
        purchaseDate: addDays(TODAY, -3),
      }).expect(201);
      expect((await stockOf(opc)).lastPrice).toBe('560.00');
      expect((await stockOf(opc)).stock).toBe('20');
    });

    it('counts each month by purchase date, across the month boundary', async () => {
      const opc = await newProduct();
      const last = addDays(TODAY.slice(0, 8) + '01', -1); // last day of the previous month
      const first = TODAY.slice(0, 8) + '01';
      const lastPeriod = Number(last.slice(0, 4) + last.slice(5, 7));
      const firstPeriod = Number(first.slice(0, 4) + first.slice(5, 7));
      const beforeLast = Number(await counter(lastPeriod));
      const beforeFirst = Number(await counter(firstPeriod));
      await buy('owner', [{ productId: opc, quantity: '30', unitPrice: '560' }], {
        purchaseDate: last,
      }).expect(201);
      await buy('owner', [{ productId: opc, quantity: '40', unitPrice: '560' }], {
        purchaseDate: first,
      }).expect(201);
      expect(Number(await counter(lastPeriod))).toBe(beforeLast + 30);
      expect(Number(await counter(firstPeriod))).toBe(beforeFirst + 40);
    });

    it('refuses future dates, and old dates for staff without purchase.edit', async () => {
      const opc = await newProduct();
      const line = [{ productId: opc, quantity: '1', unitPrice: '1' }];
      const future = await buy('manager', line, { purchaseDate: addDays(TODAY, 1) }).expect(400);
      expect(future.body).toMatchObject({ code: 'PURCHASE_DATE_IN_FUTURE', field: 'purchaseDate' });
      await buy('manager', line, { purchaseDate: addDays(TODAY, -7) }).expect(201);
      const old = await buy('manager', line, { purchaseDate: addDays(TODAY, -8) }).expect(400);
      expect(old.body).toMatchObject({ code: 'PURCHASE_DATE_TOO_OLD', field: 'purchaseDate' });
      await buy('ownerRole', line, { purchaseDate: addDays(TODAY, -40) }).expect(201);
      const unreal = await buy('manager', line, { purchaseDate: '2026-02-30' }).expect(400);
      expect(unreal.body).toMatchObject({ code: 'PURCHASE_DATE_INVALID' });
    });

    it('validates lines with a code and field for each', async () => {
      const opc = await newProduct();
      const inactive = await newProduct();
      await send(t.server, 'patch', path(`products/${inactive}`), who('owner'), {
        isActive: false,
        reason: 'not sold',
      }).expect(200);
      const otherProduct = await newProduct(
        other.slug,
        (
          (
            await send(t.server, 'post', path('product-categories', other.slug), who('owner'), {
              nameEn: 'X',
              nameBn: 'X',
            }).expect(201)
          ).body as { id: string }
        ).id,
      );
      const cases: [object[], string, string][] = [
        [
          [
            { productId: opc, quantity: '1', unitPrice: '1' },
            { productId: opc, quantity: '2', unitPrice: '1' },
          ],
          'PRODUCT_DUPLICATE',
          'items.1.productId',
        ],
        [
          [{ productId: inactive, quantity: '1', unitPrice: '1' }],
          'PRODUCT_NOT_FOUND_OR_INACTIVE',
          'items.0.productId',
        ],
        [
          [{ productId: otherProduct, quantity: '1', unitPrice: '1' }],
          'PRODUCT_NOT_FOUND_OR_INACTIVE',
          'items.0.productId',
        ],
        [
          [{ productId: opc, quantity: '1.5', unitPrice: '1' }],
          'QUANTITY_INVALID',
          'items.0.quantity',
        ],
        [
          [{ productId: opc, quantity: '0', unitPrice: '1' }],
          'QUANTITY_INVALID',
          'items.0.quantity',
        ],
      ];
      for (const [items, code, field] of cases) {
        const response = await buy('manager', items as never).expect(400);
        expect(response.body).toMatchObject({ code, field });
      }
      const shape = await buy('manager', [
        { productId: opc, quantity: 5, unitPrice: '1' } as never,
      ]).expect(400);
      expect((shape.body as { errors: { field: string; code: string }[] }).errors).toEqual([
        expect.objectContaining({ field: 'items.0.quantity', code: 'QUANTITY_INVALID' }),
      ]);
      const none = await buy('manager', []).expect(400);
      expect((none.body as { errors: { code: string }[] }).errors[0]?.code).toBe('ITEMS_TOO_SHORT');
      const supplier = await buy('manager', [{ productId: opc, quantity: '1', unitPrice: '1' }], {
        supplierId: '00000000-0000-7000-8000-000000000000',
      }).expect(400);
      expect(supplier.body).toMatchObject({
        code: 'SUPPLIER_NOT_FOUND_OR_INACTIVE',
        field: 'supplierId',
      });
    });

    it('returns the same purchase for the same Idempotency-Key, and saves it once', async () => {
      const opc = await newProduct();
      const key = `buy-${String(Math.random()).slice(2, 14)}`;
      const line = [{ productId: opc, quantity: '25', unitPrice: '570' }];
      const [first, second] = await Promise.all([
        buy('manager', line, {}, { 'Idempotency-Key': key }),
        buy('manager', line, {}, { 'Idempotency-Key': key }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect((first.body as PurchaseBody).id).toBe((second.body as PurchaseBody).id);
      expect((await stockOf(opc)).stock).toBe('25');
      const bad = await buy('manager', line, {}, { 'Idempotency-Key': 'bad key!' }).expect(400);
      expect(bad.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
    });

    it('keeps stock, numbers and counters right under concurrent purchases', async () => {
      const opc = await newProduct();
      const period = Number(TODAY.slice(0, 4) + TODAY.slice(5, 7));
      const before = Number(await counter(period));
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          buy(index % 2 ? 'manager' : 'ownerRole', [
            { productId: opc, quantity: '7', unitPrice: '570' },
          ]),
        ),
      );
      expect(results.every((result) => result.status === 201)).toBe(true);
      const codes = results.map((result) => (result.body as PurchaseBody).code);
      expect(new Set(codes).size).toBe(10);
      expect((await stockOf(opc)).stock).toBe('70');
      expect(Number(await counter(period))).toBe(before + 70);
      await expectConsistent();
    });
  });

  describe('reading purchases', () => {
    it('lists ten per page, newest first, with filters', async () => {
      const shopList = await data.createBusiness('buy-list');
      await runSeed();
      const category = (
        (
          await send(t.server, 'post', path('product-categories', shopList.slug), who('owner'), {
            nameEn: 'C',
            nameBn: 'C',
          }).expect(201)
        ).body as { id: string }
      ).id;
      const a = await newProduct(shopList.slug, category);
      const b = await newProduct(shopList.slug, category);
      for (let index = 0; index < 12; index += 1) {
        await buy(
          'owner',
          [{ productId: index < 3 ? b : a, quantity: '1', unitPrice: '1' }],
          { purchaseDate: addDays(TODAY, -index) },
          {},
          shopList.slug,
        ).expect(201);
      }
      const first = await get(t.server, path('purchases', shopList.slug), who('owner')).expect(200);
      const page = first.body as { items: PurchaseBody[]; total: number; pageSize: number };
      expect(page.total).toBe(12);
      expect(page.items).toHaveLength(10);
      expect(page.items[0]?.purchaseDate).toBe(TODAY);
      expect(page.items[0]).not.toHaveProperty('items');
      const second = await get(
        t.server,
        path('purchases?page=2', shopList.slug),
        who('owner'),
      ).expect(200);
      expect((second.body as { items: unknown[] }).items).toHaveLength(2);
      const byProduct = await get(
        t.server,
        path(`purchases?productId=${b}`, shopList.slug),
        who('owner'),
      ).expect(200);
      expect((byProduct.body as { total: number }).total).toBe(3);
      const byDate = await get(
        t.server,
        path(`purchases?from=${addDays(TODAY, -4)}&to=${addDays(TODAY, -2)}`, shopList.slug),
        who('owner'),
      ).expect(200);
      expect((byDate.body as { total: number }).total).toBe(3);
    });

    it('hides prices and totals from viewers without product.cost.view', async () => {
      const opc = await newProduct();
      const created = (
        await buy('manager', [{ productId: opc, quantity: '3', unitPrice: '571.25' }]).expect(201)
      ).body as PurchaseBody;
      // Give the salesman purchase.view only.
      const matrix = await get(t.server, path('roles/permissions'), who('owner')).expect(200);
      const salesman =
        (matrix.body as { roles: { key: string; permissions: string[] }[] }).roles.find(
          (role) => role.key === 'salesman',
        )?.permissions ?? [];
      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: [...salesman, 'purchase.view'],
      }).expect(200);
      const detail = await get(t.server, path(`purchases/${created.id}`), who('salesman')).expect(
        200,
      );
      const body = detail.body as PurchaseBody;
      expect(body.totalQuantity).toBe('3');
      expect(body).not.toHaveProperty('totalAmount');
      expect(body.items[0]).not.toHaveProperty('unitPrice');
      expect(body.items[0]).not.toHaveProperty('lineTotal');
      expect(JSON.stringify(detail.body)).not.toContain('571.25');
      const list = await get(t.server, path('purchases'), who('salesman')).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('totalAmount');
      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: salesman,
      }).expect(200);
    });
  });

  describe('GET purchases/summary', () => {
    it('aggregates active purchases in range, hiding the amount without product.cost.view', async () => {
      const shopSummary = await data.createBusiness('buy-summary');
      await runSeed();
      const category = (
        (
          await send(t.server, 'post', path('product-categories', shopSummary.slug), who('owner'), {
            nameEn: 'C',
            nameBn: 'C',
          }).expect(201)
        ).body as { id: string }
      ).id;
      const a = await newProduct(shopSummary.slug, category);
      await buy(
        'owner',
        [{ productId: a, quantity: '10', unitPrice: '100' }],
        { purchaseDate: TODAY },
        {},
        shopSummary.slug,
      ).expect(201);
      await buy(
        'owner',
        [{ productId: a, quantity: '5', unitPrice: '100' }],
        { purchaseDate: addDays(TODAY, -10) },
        {},
        shopSummary.slug,
      ).expect(201);
      const voided = (
        await buy(
          'owner',
          [{ productId: a, quantity: '99', unitPrice: '100' }],
          { purchaseDate: TODAY },
          {},
          shopSummary.slug,
        ).expect(201)
      ).body as PurchaseBody;
      await send(
        t.server,
        'post',
        path(`purchases/${voided.id}/void`, shopSummary.slug),
        who('owner'),
        { reason: 'test' },
      ).expect(200);

      const todayOnly = await get(
        t.server,
        path(`purchases/summary?from=${TODAY}&to=${TODAY}`, shopSummary.slug),
        who('owner'),
      ).expect(200);
      expect(todayOnly.body).toMatchObject({
        from: TODAY,
        to: TODAY,
        count: 1,
        totalQuantity: '10',
        totalAmount: '1000.00',
      });

      const wholeRange = await get(
        t.server,
        path(`purchases/summary?from=${addDays(TODAY, -10)}&to=${TODAY}`, shopSummary.slug),
        who('owner'),
      ).expect(200);
      expect(wholeRange.body).toMatchObject({
        count: 2,
        totalQuantity: '15',
        totalAmount: '1500.00',
      });

      // Give the salesman purchase.view only, in this business (role permissions are per-business).
      const matrix = await get(
        t.server,
        path('roles/permissions', shopSummary.slug),
        who('owner'),
      ).expect(200);
      const salesman =
        (matrix.body as { roles: { key: string; permissions: string[] }[] }).roles.find(
          (role) => role.key === 'salesman',
        )?.permissions ?? [];
      await send(
        t.server,
        'put',
        path('roles/salesman/permissions', shopSummary.slug),
        who('owner'),
        { permissions: [...salesman, 'purchase.view'] },
      ).expect(200);
      await member('summarySalesman', 'salesman', shopSummary.id);
      const hidden = await get(
        t.server,
        path(`purchases/summary?from=${TODAY}&to=${TODAY}`, shopSummary.slug),
        who('summarySalesman'),
      ).expect(200);
      expect(hidden.body).toMatchObject({ count: 1, totalQuantity: '10' });
      expect(hidden.body).not.toHaveProperty('totalAmount');
      await send(
        t.server,
        'put',
        path('roles/salesman/permissions', shopSummary.slug),
        who('owner'),
        { permissions: salesman },
      ).expect(200);
    });

    it('requires purchase.view', async () => {
      await get(
        t.server,
        path(`purchases/summary?from=${TODAY}&to=${TODAY}`),
        who('accountant'),
      ).expect(403);
    });
  });

  describe('permissions and isolation', () => {
    it('lets only purchase.create (with cost view) buy, and purchase.view read', async () => {
      const opc = await newProduct();
      const line = [{ productId: opc, quantity: '1', unitPrice: '1' }];
      await buy('salesman', line).expect(403);
      await buy('accountant', line).expect(403);
      await get(t.server, path('purchases'), who('salesman')).expect(403);
      await get(t.server, path('purchases'), who('accountant')).expect(403);
      await get(t.server, path('purchases'), who('manager')).expect(200);
    });

    it('keeps the monthly counter owner-only', async () => {
      const year = TODAY.slice(0, 4);
      for (const staff of ['manager', 'ownerRole', 'salesman', 'accountant']) {
        await get(t.server, path(`purchase-counters?year=${year}`), who(staff)).expect(403);
      }
      const response = await get(
        t.server,
        path(`purchase-counters?year=${year}`),
        who('owner'),
      ).expect(200);
      const body = response.body as { year: number; months: { month: string; quantity: string }[] };
      expect(body.months).toHaveLength(12);
      expect(body.months.find((month) => month.month === TODAY.slice(0, 7))?.quantity).not.toBe(
        '0',
      );
    });

    it('answers another business’s purchase like a missing one', async () => {
      const opc = await newProduct();
      const created = (
        await buy('manager', [{ productId: opc, quantity: '1', unitPrice: '1' }]).expect(201)
      ).body as PurchaseBody;
      const theirs = await get(
        t.server,
        path(`purchases/${created.id}`, other.slug),
        who('otherManager'),
      ).expect(404);
      const missing = await get(
        t.server,
        path('purchases/00000000-0000-7000-8000-000000000000', other.slug),
        who('otherManager'),
      ).expect(404);
      expect(theirs.body).toEqual(missing.body);
      expect((theirs.body as ErrorBody).code).toBe('PURCHASE_NOT_FOUND');
      await get(t.server, path('purchases', shop.slug), who('otherManager')).expect(403);
    });
  });

  describe('the stock ledger', () => {
    it('refuses to change or delete a movement', async () => {
      await expect(
        t.prisma.client.$executeRawUnsafe(
          'UPDATE stock_movements SET quantity = quantity + 1 WHERE business_id = $1::uuid',
          shop.id,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        t.prisma.client.$executeRawUnsafe(
          'DELETE FROM stock_movements WHERE business_id = $1::uuid',
          shop.id,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });
});

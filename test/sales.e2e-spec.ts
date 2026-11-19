import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, todayIn } from '../src/core/common/business-time';
import { hasDatabase } from './database';
import { expectSalesConsistent } from './sales-helpers';
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

interface OrderBody {
  id: string;
  code: string;
  status: string;
  deliveryStatus: string;
  totalQuantity: string;
  deliveredQuantity: string;
  remainingQuantity: string;
  totalAmount: string;
  items: { id: string; quantity: string; deliveredQuantity: string; remainingQuantity: string }[];
  deliveries: { id: string; code: string; totalQuantity: string }[];
}
interface DeliveryBody {
  id: string;
  code: string;
  totalQuantity: string;
  totalAmount: string;
  creditLimitExceeded?: boolean;
  items: { id: string; quantity: string; unitPrice: string; lineTotal: string }[];
}
interface CustomerBody {
  currentBalance?: string;
  deliveredAmount?: string;
  collectedAmount?: string;
  pendingDeliveryQuantity: string;
}

const TODAY = todayIn('Asia/Dhaka');

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0173${String(phoneCounter).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('orders, deliveries and collections', () => {
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
    if (roleKey) await data.giveAccess(user.id, businessId, roleKey);
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const post = (
    who_: string,
    suffix: string,
    body: object,
    headers: Record<string, string> = {},
    slug = shop.slug,
  ) => {
    let call = request(t.server)
      .post(`/api/v1${path(suffix, slug)}`)
      .set('Cookie', cookieHeader(who(who_)));
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send(body);
  };

  async function product(slug = shop.slug, category = categoryId) {
    return (
      (
        await send(t.server, 'post', path('products', slug), who('owner'), {
          categoryId: category,
          nameEn: `Cement ${String(Math.random()).slice(2, 10)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  async function stockUp(productId: string, quantity: string, slug = shop.slug) {
    await post(
      'owner',
      'purchases',
      { items: [{ productId, quantity, unitPrice: '540' }] },
      {},
      slug,
    ).expect(201);
  }

  async function customer(extra: object = {}, slug = shop.slug) {
    return (
      (
        await send(t.server, 'post', path('customers', slug), who('owner'), {
          nameEn: `Shop ${String(Math.random()).slice(2, 10)}`,
          phone: newPhone(),
          openingBalance: '1000',
          ...extra,
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  async function order(
    who_: string,
    customerId: string,
    items: object[],
    extra: object = {},
    slug = shop.slug,
  ) {
    return (
      await post(
        who_,
        'orders',
        { customerId, deliveryWindow: 'two_days', items, ...extra },
        {},
        slug,
      ).expect(201)
    ).body as OrderBody;
  }

  const customerNow = async (id: string, who_ = 'owner') =>
    (await get(t.server, path(`customers/${id}`), who(who_)).expect(200)).body as CustomerBody;

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('sales');
    other = await data.createBusiness('sales-other');
    await runSeed();
    await member('owner', null);
    await member('ownerRole', 'owner');
    await member('manager', 'manager');
    await member('salesman', 'salesman');
    await member('salesman2', 'salesman');
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
    await expectSalesConsistent(t, shop.id);
    await data.cleanup();
    await t.app.close();
  });

  describe('orders', () => {
    it('creates an order that changes no stock or balance, only bags still to deliver', async () => {
      const opc = await product();
      const shopId = await customer();
      const created = await post('salesman', 'orders', {
        customerId: shopId,
        deliveryWindow: 'today',
        deliverBy: addDays(TODAY, 1),
        items: [{ productId: opc, quantity: '100', unitPrice: '565' }],
      }).expect(201);
      const body = created.body as OrderBody & { deliverBy: string; deliveryWindow: string };
      expect(body).toMatchObject({
        code: expect.stringMatching(/^ORD-\d{4}$/) as string,
        status: 'active',
        deliveryStatus: 'pending',
        deliveryWindow: 'today',
        deliverBy: addDays(TODAY, 1),
        totalQuantity: '100',
        deliveredQuantity: '0',
        remainingQuantity: '100',
        totalAmount: '56500.00',
      });
      expect(await customerNow(shopId)).toMatchObject({
        currentBalance: '1000.00',
        pendingDeliveryQuantity: '100',
      });
    });

    it('validates orders with a code and field', async () => {
      const opc = await product();
      const shopId = await customer();
      const line = [{ productId: opc, quantity: '1', unitPrice: '1' }];
      const cases: [object, string, string][] = [
        [
          { customerId: '00000000-0000-7000-8000-000000000000', items: line },
          'CUSTOMER_NOT_FOUND_OR_INACTIVE',
          'customerId',
        ],
        [
          { customerId: shopId, items: line, deliverBy: addDays(TODAY, -1) },
          'DELIVER_BY_INVALID',
          'deliverBy',
        ],
        [
          { customerId: shopId, items: line, orderDate: addDays(TODAY, 1) },
          'ORDER_DATE_IN_FUTURE',
          'orderDate',
        ],
        [
          { customerId: shopId, items: line, orderDate: addDays(TODAY, -9) },
          'ORDER_DATE_TOO_OLD',
          'orderDate',
        ],
        [
          { customerId: shopId, items: [...line, ...line] },
          'PRODUCT_DUPLICATE',
          'items.1.productId',
        ],
        [
          { customerId: shopId, items: [{ productId: opc, quantity: '1.5', unitPrice: '1' }] },
          'QUANTITY_INVALID',
          'items.0.quantity',
        ],
      ];
      for (const [body, code, field] of cases) {
        const response = await post('salesman', 'orders', {
          deliveryWindow: 'one_week',
          ...body,
        }).expect(400);
        expect(response.body).toMatchObject({ code, field });
      }
      const window = await post('salesman', 'orders', {
        customerId: shopId,
        deliveryWindow: 'tomorrow',
        items: line,
      }).expect(400);
      expect((window.body as { errors: { field: string; code: string }[] }).errors).toEqual([
        expect.objectContaining({ field: 'deliveryWindow', code: 'DELIVERY_WINDOW_INVALID' }),
      ]);
    });

    it('shows a salesman only their own orders; the manager sees all', async () => {
      const opc = await product();
      const shopId = await customer();
      const mine = await order('salesman', shopId, [
        { productId: opc, quantity: '5', unitPrice: '560' },
      ]);
      const theirs = await order('salesman2', shopId, [
        { productId: opc, quantity: '6', unitPrice: '560' },
      ]);
      const list = await get(t.server, path(`orders?customerId=${shopId}`), who('salesman')).expect(
        200,
      );
      expect((list.body as { items: OrderBody[] }).items.map((row) => row.id)).toEqual([mine.id]);
      await get(t.server, path(`orders/${theirs.id}`), who('salesman')).expect(404);
      const all = await get(t.server, path(`orders?customerId=${shopId}`), who('manager')).expect(
        200,
      );
      expect((all.body as { total: number }).total).toBe(2);
      await get(t.server, path('orders'), who('accountant')).expect(403);
      await post('accountant', 'orders', {
        customerId: shopId,
        deliveryWindow: 'today',
        items: [],
      }).expect(403);
    });

    it('returns the same order for the same Idempotency-Key', async () => {
      const opc = await product();
      const shopId = await customer();
      const body = {
        customerId: shopId,
        deliveryWindow: 'today',
        items: [{ productId: opc, quantity: '3', unitPrice: '560' }],
      };
      const key = `ord-${String(Math.random()).slice(2, 14)}`;
      const [a, b] = await Promise.all([
        post('salesman', 'orders', body, { 'Idempotency-Key': key }),
        post('salesman', 'orders', body, { 'Idempotency-Key': key }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as OrderBody).id).toBe((b.body as OrderBody).id);
      expect((await customerNow(shopId)).pendingDeliveryQuantity).toBe('3');
    });
  });

  describe('deliveries', () => {
    it('delivers part of an order: stock out, balance and ledger up, bags still to deliver down', async () => {
      const opc = await product();
      await stockUp(opc, '300');
      const shopId = await customer();
      const placed = await order('salesman', shopId, [
        { productId: opc, quantity: '100', unitPrice: '565' },
      ]);
      const delivered = await post('manager', 'deliveries', {
        orderId: placed.id,
        transportReference: 'Truck DHA-11-2233',
        items: [{ orderItemId: placed.items[0]?.id, quantity: '40' }],
      }).expect(201);
      const body = delivered.body as DeliveryBody;
      expect(body).toMatchObject({
        code: expect.stringMatching(/^DEL-\d{4}$/) as string,
        totalQuantity: '40',
        totalAmount: '22600.00',
        creditLimitExceeded: false,
      });
      const after = (await get(t.server, path(`orders/${placed.id}`), who('salesman')).expect(200))
        .body as OrderBody;
      expect(after).toMatchObject({
        deliveredQuantity: '40',
        remainingQuantity: '60',
        deliveryStatus: 'partial',
      });
      expect(after.deliveries.map((row) => row.code)).toEqual([body.code]);
      expect(await customerNow(shopId)).toMatchObject({
        currentBalance: '23600.00',
        deliveredAmount: '22600.00',
        pendingDeliveryQuantity: '60',
      });
      const stock = await get(t.server, path(`stock/${opc}/movements`), who('manager')).expect(200);
      expect(
        (
          stock.body as {
            product: { currentStock: string };
            items: { kind: string; quantity: string }[];
          }
        ).items[0],
      ).toMatchObject({
        kind: 'delivery',
        quantity: '-40',
      });
      const ledger = await get(
        t.server,
        path(`customers/${shopId}/ledger`),
        who('accountant'),
      ).expect(200);
      expect(
        (ledger.body as { items: { kind: string; amount: string; source: { code: string } }[] })
          .items[0],
      ).toMatchObject({
        kind: 'delivery',
        amount: '22600.00',
        source: { code: body.code },
      });

      // The rest, then nothing more.
      await post('manager', 'deliveries', {
        orderId: placed.id,
        items: [{ orderItemId: placed.items[0]?.id, quantity: '60' }],
      }).expect(201);
      const full = (await get(t.server, path(`orders/${placed.id}`), who('manager')).expect(200))
        .body as OrderBody;
      expect(full.deliveryStatus).toBe('delivered');
      const extra = await post('manager', 'deliveries', {
        orderId: placed.id,
        items: [{ orderItemId: placed.items[0]?.id, quantity: '1' }],
      }).expect(400);
      expect(extra.body).toMatchObject({
        code: 'DELIVERY_QUANTITY_TOO_LARGE',
        field: 'items.0.quantity',
        details: { remaining: '0' },
      });
    });

    it('refuses deliveries without stock, for unknown lines and before the order date', async () => {
      const opc = await product();
      await stockUp(opc, '5');
      const shopId = await customer();
      const placed = await order('manager', shopId, [
        { productId: opc, quantity: '50', unitPrice: '560' },
      ]);
      const short = await post('manager', 'deliveries', {
        orderId: placed.id,
        items: [{ orderItemId: placed.items[0]?.id, quantity: '10' }],
      }).expect(409);
      expect(short.body).toMatchObject({
        code: 'STOCK_INSUFFICIENT',
        field: 'items.0.quantity',
        details: { available: '5', required: '10' },
      });
      const unknown = await post('manager', 'deliveries', {
        orderId: placed.id,
        items: [{ orderItemId: '00000000-0000-7000-8000-000000000000', quantity: '1' }],
      }).expect(400);
      expect(unknown.body).toMatchObject({
        code: 'ORDER_ITEM_NOT_FOUND',
        field: 'items.0.orderItemId',
      });
      const early = await post('manager', 'deliveries', {
        orderId: placed.id,
        deliveryDate: addDays(TODAY, -1),
        items: [{ orderItemId: placed.items[0]?.id, quantity: '1' }],
      }).expect(400);
      expect(early.body).toMatchObject({ code: 'DELIVERY_DATE_INVALID', field: 'deliveryDate' });
      const missing = await post('manager', 'deliveries', {
        orderId: '00000000-0000-7000-8000-000000000000',
        items: [{ orderItemId: placed.items[0]?.id, quantity: '1' }],
      }).expect(404);
      expect(missing.body).toMatchObject({ code: 'ORDER_NOT_FOUND', field: 'orderId' });
      await post('salesman', 'deliveries', { orderId: placed.id, items: [] }).expect(403);
      expect((await customerNow(shopId)).currentBalance).toBe('1000.00');
    });

    it('flags a delivery over the credit limit (warn mode)', async () => {
      const opc = await product();
      await stockUp(opc, '100');
      const shopId = await customer({ creditLimit: '10000' });
      const placed = await order('manager', shopId, [
        { productId: opc, quantity: '20', unitPrice: '560' },
      ]);
      const response = await post('manager', 'deliveries', {
        orderId: placed.id,
        items: [{ orderItemId: placed.items[0]?.id, quantity: '20' }],
      }).expect(201);
      // 1000 + 20 × 560 = 12,200 > 10,000.
      expect((response.body as DeliveryBody).creditLimitExceeded).toBe(true);
      // The flag is due information: hidden without customer.due.view.
      const matrix = await get(t.server, path('roles/permissions'), who('owner')).expect(200);
      const salesman =
        (matrix.body as { roles: { key: string; permissions: string[] }[] }).roles.find(
          (role) => role.key === 'salesman',
        )?.permissions ?? [];
      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: [...salesman, 'delivery.view'],
      }).expect(200);
      const seen = await get(
        t.server,
        path(`deliveries/${(response.body as DeliveryBody).id}`),
        who('salesman'),
      ).expect(200);
      expect(seen.body).not.toHaveProperty('creditLimitExceeded');
      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: salesman,
      }).expect(200);
    });

    it('blocks a delivery over the credit limit when the business says so, unless overridden', async () => {
      const strict = await data.createBusiness('sales-strict', {
        units: [{ key: 'bag', nameEn: 'Bag', nameBn: 'বস্তা', decimals: 0 }],
        defaultUnit: 'bag',
        principalSupplier: { nameEn: 'Principal Co', nameBn: 'প্রধান কোম্পানি' },
        creditLimitMode: 'block',
      });
      await runSeed();
      await member('strictManager', 'manager', strict.id);
      await member('strictOwnerRole', 'owner', strict.id);
      const category = (
        (
          await send(t.server, 'post', path('product-categories', strict.slug), who('owner'), {
            nameEn: 'C',
            nameBn: 'C',
          }).expect(201)
        ).body as { id: string }
      ).id;
      const opc = await product(strict.slug, category);
      await stockUp(opc, '100', strict.slug);
      const shopId = await customer({ creditLimit: '5000', openingBalance: '0' }, strict.slug);
      const placed = await order(
        'strictManager',
        shopId,
        [{ productId: opc, quantity: '20', unitPrice: '560' }],
        {},
        strict.slug,
      );
      const blocked = await post(
        'strictManager',
        'deliveries',
        {
          orderId: placed.id,
          items: [{ orderItemId: placed.items[0]?.id, quantity: '10' }],
        },
        {},
        strict.slug,
      ).expect(409);
      expect(blocked.body).toMatchObject({
        code: 'CREDIT_LIMIT_EXCEEDED',
        field: 'items',
        details: { creditLimit: '5000.00', balanceAfter: '5600.00' },
      });
      // Within the limit it goes through.
      await post(
        'strictManager',
        'deliveries',
        {
          orderId: placed.id,
          items: [{ orderItemId: placed.items[0]?.id, quantity: '8' }],
        },
        {},
        strict.slug,
      ).expect(201);
      // The owner level may override, and the delivery is flagged.
      const overridden = await post(
        'strictOwnerRole',
        'deliveries',
        {
          orderId: placed.id,
          items: [{ orderItemId: placed.items[0]?.id, quantity: '12' }],
        },
        {},
        strict.slug,
      ).expect(201);
      expect((overridden.body as DeliveryBody).creditLimitExceeded).toBe(true);
      await expectSalesConsistent(t, strict.id);
    });

    it('never delivers more than remains when two deliveries race for the same bags', async () => {
      const opc = await product();
      await stockUp(opc, '100');
      const shopId = await customer();
      const placed = await order('manager', shopId, [
        { productId: opc, quantity: '10', unitPrice: '560' },
      ]);
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          post('manager', 'deliveries', {
            orderId: placed.id,
            items: [{ orderItemId: placed.items[0]?.id, quantity: '6' }],
          }),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([201, 400, 400]);
      const after = (await get(t.server, path(`orders/${placed.id}`), who('manager')).expect(200))
        .body as OrderBody;
      expect(after.deliveredQuantity).toBe('6');
      await expectSalesConsistent(t, shop.id);
    });
  });

  describe('collections', () => {
    it('takes money straight to the balance, allows an advance, and lists the methods', async () => {
      const shopId = await customer({ openingBalance: '0' });
      const methods = await get(t.server, path('collection-methods'), who('accountant')).expect(
        200,
      );
      expect((methods.body as { items: string[] }).items).toEqual([
        'cash',
        'bkash',
        'nagad',
        'bank',
        'cheque',
      ]);
      const opc = await product();
      const placed = await order('salesman', shopId, [
        { productId: opc, quantity: '10', unitPrice: '560' },
      ]);
      const advance = await post('accountant', 'collections', {
        customerId: shopId,
        orderId: placed.id,
        method: 'bkash',
        amount: '3000',
        reference: 'TRX8XK2',
      }).expect(201);
      expect(advance.body).toMatchObject({
        code: expect.stringMatching(/^COL-\d{4}$/) as string,
        method: 'bkash',
        amount: '3000.00',
        order: { id: placed.id, code: placed.code },
      });
      expect(await customerNow(shopId)).toMatchObject({
        currentBalance: '-3000.00',
        collectedAmount: '3000.00',
      });
      const bad = await post('accountant', 'collections', {
        customerId: shopId,
        method: 'crypto',
        amount: '1',
      }).expect(400);
      expect(bad.body).toMatchObject({ code: 'COLLECTION_METHOD_UNKNOWN', field: 'method' });
      const zero = await post('accountant', 'collections', {
        customerId: shopId,
        method: 'cash',
        amount: '0',
      }).expect(400);
      expect(zero.body).toMatchObject({ code: 'AMOUNT_TOO_SMALL', field: 'amount' });
      const otherShop = await customer();
      const wrongOrder = await post('accountant', 'collections', {
        customerId: otherShop,
        orderId: placed.id,
        method: 'cash',
        amount: '1',
      }).expect(404);
      expect(wrongOrder.body).toMatchObject({ code: 'ORDER_NOT_FOUND', field: 'orderId' });
      await post('salesman', 'collections', {
        customerId: shopId,
        method: 'cash',
        amount: '1',
      }).expect(403);
      const list = await get(
        t.server,
        path(`collections?customerId=${shopId}`),
        who('accountant'),
      ).expect(200);
      expect((list.body as { total: number }).total).toBe(1);
      await get(t.server, path('collections'), who('salesman')).expect(403);
    });

    it('hides balances from the salesman but shows bags still to deliver', async () => {
      const shopId = await customer();
      const opc = await product();
      await order('salesman', shopId, [{ productId: opc, quantity: '7', unitPrice: '560' }]);
      const seen = await customerNow(shopId, 'salesman');
      expect(seen.pendingDeliveryQuantity).toBe('7');
      expect(seen).not.toHaveProperty('deliveredAmount');
      expect(seen).not.toHaveProperty('collectedAmount');
      expect(seen).not.toHaveProperty('currentBalance');
      await get(t.server, path(`customers/${shopId}/ledger`), who('salesman')).expect(403);
    });
  });

  describe('isolation', () => {
    it('answers another business’s order, delivery and collection like missing ones', async () => {
      const opc = await product();
      await stockUp(opc, '10');
      const shopId = await customer();
      const placed = await order('manager', shopId, [
        { productId: opc, quantity: '2', unitPrice: '560' },
      ]);
      const delivered = (
        await post('manager', 'deliveries', {
          orderId: placed.id,
          items: [{ orderItemId: placed.items[0]?.id, quantity: '1' }],
        }).expect(201)
      ).body as DeliveryBody;
      const collected = (
        await post('manager', 'collections', {
          customerId: shopId,
          method: 'cash',
          amount: '100',
        }).expect(201)
      ).body as { id: string };
      const missing = '00000000-0000-7000-8000-000000000000';
      for (const [kind, id, code] of [
        ['orders', placed.id, 'ORDER_NOT_FOUND'],
        ['deliveries', delivered.id, 'DELIVERY_NOT_FOUND'],
        ['collections', collected.id, 'COLLECTION_NOT_FOUND'],
      ] as const) {
        const theirs = await get(
          t.server,
          path(`${kind}/${id}`, other.slug),
          who('otherManager'),
        ).expect(404);
        const none = await get(
          t.server,
          path(`${kind}/${missing}`, other.slug),
          who('otherManager'),
        ).expect(404);
        expect(theirs.body).toEqual(none.body);
        expect((theirs.body as { code: string }).code).toBe(code);
      }
      const delivery = await post(
        'otherManager',
        'deliveries',
        {
          orderId: placed.id,
          items: [{ orderItemId: placed.items[0]?.id, quantity: '1' }],
        },
        {},
        other.slug,
      ).expect(404);
      expect(delivery.body).toMatchObject({ code: 'ORDER_NOT_FOUND' });
    });
  });

  it('refuses to change or delete a customer ledger line', async () => {
    await expect(
      t.prisma.client.$executeRawUnsafe(
        'UPDATE customer_ledger_entries SET amount = amount + 1 WHERE business_id = $1::uuid',
        shop.id,
      ),
    ).rejects.toThrow(/append-only/);
  });
});

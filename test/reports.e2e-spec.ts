import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, todayIn } from '../src/core/common/business-time';
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

interface SalesReportBody {
  from: string;
  to: string;
  groupBy: string;
  items: { key: string; label: string; quantity: string; amount: string }[];
  totalQuantity: string;
  totalAmount: string;
  page: number;
  pageSize: number;
  total: number;
}
interface CollectionsReportBody {
  items: { key: string; count: number; amount: string }[];
  totalAmount: string;
}
interface DuesReportBody {
  items: {
    id: string;
    code: string;
    currentBalance: string;
    dueAmount: string;
    advanceAmount: string;
    aging: { d0To7: string; d8To30: string; d30Plus: string };
  }[];
  totalDue: string;
  totalAdvance: string;
}
interface StockReportBody {
  items: { id: string; code: string; currentStock: string }[];
}
interface StockMovementsReportBody {
  items: { productId: string; net: string; byKind: { kind: string; quantity: string }[] }[];
}
interface ExpensesReportBody {
  groupBy: string;
  items: { key: string; label: string; count: number; amount: string }[];
  totalAmount: string;
}
interface DailySummaryBody {
  date: string;
  orders: { count: number; amount: string };
  deliveries: { count: number; amount: string };
  collections: { count: number; amount: string };
  expenses: { count: number; amount: string };
  cash?: { openingBalance: string; closingBalance: string; net: string };
}
interface ErrorBody {
  code: string;
  field?: string;
}

const TODAY = todayIn('Asia/Dhaka');

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0176${String(phoneCounter).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('reports', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;
  let productId: string;
  let customerId: string;
  let salary: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string) => `/b/${shop.slug}/${suffix}`;

  async function member(name: string, roleKey: string | null) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) await data.giveAccess(user.id, shop.id, roleKey);
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const post = (who_: string, suffix: string, body: object) =>
    request(t.server)
      .post(`/api/v1${path(suffix)}`)
      .set('Cookie', cookieHeader(who(who_)))
      .send(body);

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('reports');
    await runSeed();
    await member('owner', null);
    await member('manager', 'manager');
    await member('salesman', 'salesman');

    categoryId = (
      (
        await send(t.server, 'post', path('product-categories'), who('owner'), {
          nameEn: 'OPC',
          nameBn: 'ওপিসি',
        }).expect(201)
      ).body as { id: string }
    ).id;
    productId = (
      (
        await send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameEn: 'Cement Report',
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;
    await post('owner', 'purchases', {
      items: [{ productId, quantity: '200', unitPrice: '500' }],
    }).expect(201);
    customerId = (
      (
        await send(t.server, 'post', path('customers'), who('owner'), {
          nameEn: 'Report Shop',
          phone: newPhone(),
          openingBalance: '2000',
        }).expect(201)
      ).body as { id: string }
    ).id;
    const order = (
      await post('owner', 'orders', {
        customerId,
        deliveryWindow: 'today',
        items: [{ productId, quantity: '20', unitPrice: '600' }],
      }).expect(201)
    ).body as { id: string; items: { id: string }[] };
    await post('owner', 'deliveries', {
      orderId: order.id,
      items: [{ orderItemId: order.items[0]?.id, quantity: '20' }],
    }).expect(201);
    await post('owner', 'collections', { customerId, method: 'cash', amount: '5000' }).expect(201);
    const seeded = (await get(t.server, path('expense-categories'), who('owner')).expect(200))
      .body as { items: { id: string; nameEn: string }[] };
    salary = seeded.items.find((row) => row.nameEn === 'Salary')?.id ?? '';
    await post('owner', 'expenses', { categoryId: salary, method: 'cash', amount: '800' }).expect(
      201,
    );
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('sales report', () => {
    it('groups by date, customer, product and category, matching totals', async () => {
      const byDate = (
        await get(
          t.server,
          path(`reports/sales?groupBy=date&from=${TODAY}&to=${TODAY}`),
          who('owner'),
        ).expect(200)
      ).body as SalesReportBody;
      expect(byDate.groupBy).toBe('date');
      expect(Number(byDate.totalAmount)).toBeGreaterThanOrEqual(12000);

      const byCustomer = (
        await get(
          t.server,
          path(`reports/sales?groupBy=customer&from=${TODAY}&to=${TODAY}`),
          who('owner'),
        ).expect(200)
      ).body as SalesReportBody;
      expect(byCustomer.totalAmount).toBe(byDate.totalAmount);
      expect(byCustomer.items.some((row) => row.label.includes('Report Shop'))).toBe(true);

      const byProduct = (
        await get(
          t.server,
          path(`reports/sales?groupBy=product&from=${TODAY}&to=${TODAY}`),
          who('owner'),
        ).expect(200)
      ).body as SalesReportBody;
      expect(byProduct.totalAmount).toBe(byDate.totalAmount);
      expect(byProduct.totalQuantity).toBe(byDate.totalQuantity);

      const byCategory = (
        await get(
          t.server,
          path(`reports/sales?groupBy=category&from=${TODAY}&to=${TODAY}`),
          who('owner'),
        ).expect(200)
      ).body as SalesReportBody;
      expect(byCategory.totalAmount).toBe(byDate.totalAmount);
    });

    it('never carries a purchase price or profit figure', async () => {
      const body = (
        await get(t.server, path('reports/sales?groupBy=product'), who('owner')).expect(200)
      ).body as Record<string, unknown>;
      expect(body).not.toHaveProperty('unitCost');
      expect(body).not.toHaveProperty('profit');
      const row = (body['items'] as Record<string, unknown>[])[0] ?? {};
      expect(row).not.toHaveProperty('unitCost');
      expect(row).not.toHaveProperty('profit');
    });
  });

  it('collections report groups by date and by method', async () => {
    const byDate = (
      await get(
        t.server,
        path(`reports/collections?from=${TODAY}&to=${TODAY}`),
        who('owner'),
      ).expect(200)
    ).body as CollectionsReportBody;
    expect(Number(byDate.totalAmount)).toBeGreaterThanOrEqual(5000);

    const byMethod = (
      await get(
        t.server,
        path(`reports/collections?groupBy=method&from=${TODAY}&to=${TODAY}`),
        who('owner'),
      ).expect(200)
    ).body as CollectionsReportBody;
    expect(byMethod.totalAmount).toBe(byDate.totalAmount);
    expect(byMethod.items.some((row) => row.key === 'cash')).toBe(true);
  });

  it('dues report splits due from advance and buckets by age', async () => {
    const body = (await get(t.server, path('reports/dues'), who('owner')).expect(200))
      .body as DuesReportBody;
    const row = body.items.find((item) => item.id === customerId);
    expect(row).toBeDefined();
    // Opening balance 2000 + delivered 12000 - collected 5000 = 9000 due.
    expect(row?.currentBalance).toBe('9000.00');
    expect(row?.dueAmount).toBe('9000.00');
    expect(row?.advanceAmount).toBe('0.00');
    const buckets = row?.aging;
    const total =
      Number(buckets?.d0To7 ?? '0') +
      Number(buckets?.d8To30 ?? '0') +
      Number(buckets?.d30Plus ?? '0');
    expect(total).toBeCloseTo(9000, 2);
  });

  it('stock report lists current stock, and stock-movements summarizes by kind', async () => {
    const stock = (await get(t.server, path('reports/stock'), who('owner')).expect(200))
      .body as StockReportBody;
    const row = stock.items.find((item) => item.id === productId);
    expect(row).toBeDefined();
    expect(Number(row?.currentStock)).toBe(180); // 200 bought - 20 delivered

    const movements = (
      await get(
        t.server,
        path(`reports/stock-movements?from=${addDays(TODAY, -1)}&to=${TODAY}`),
        who('owner'),
      ).expect(200)
    ).body as StockMovementsReportBody;
    const moved = movements.items.find((item) => item.productId === productId);
    expect(moved).toBeDefined();
    expect(moved?.byKind.some((k) => k.kind === 'purchase')).toBe(true);
    expect(moved?.byKind.some((k) => k.kind === 'delivery')).toBe(true);
  });

  it('expenses report groups by category and by month', async () => {
    const byCategory = (
      await get(t.server, path(`reports/expenses?from=${TODAY}&to=${TODAY}`), who('owner')).expect(
        200,
      )
    ).body as ExpensesReportBody;
    expect(byCategory.groupBy).toBe('category');
    expect(byCategory.items.some((row) => row.label === 'Salary')).toBe(true);

    const byMonth = (
      await get(
        t.server,
        path(`reports/expenses?groupBy=month&from=${TODAY}&to=${TODAY}`),
        who('owner'),
      ).expect(200)
    ).body as ExpensesReportBody;
    expect(byMonth.totalAmount).toBe(byCategory.totalAmount);
  });

  it('daily summary shows the cash position only with cashbook.view', async () => {
    const owner = (
      await get(t.server, path(`reports/daily-summary?date=${TODAY}`), who('owner')).expect(200)
    ).body as DailySummaryBody;
    expect(owner.collections.count).toBeGreaterThanOrEqual(1);
    expect(owner.expenses.count).toBeGreaterThanOrEqual(1);
    expect(owner.cash).toBeDefined();
    expect(owner.cash?.closingBalance).toBeDefined();
  });

  it('refuses a bad groupBy and a backwards range, but accepts a lifetime-wide one', async () => {
    const bad = (
      await get(t.server, path('reports/sales?groupBy=nonsense'), who('owner')).expect(400)
    ).body as ErrorBody;
    expect(bad.code).toBe('VALIDATION_FAILED');

    const backwards = (
      await get(
        t.server,
        path(`reports/sales?from=${TODAY}&to=${addDays(TODAY, -1)}`),
        who('owner'),
      ).expect(400)
    ).body as ErrorBody;
    expect(backwards).toMatchObject({ code: 'TO_INVALID', field: 'to' });

    // The range is no longer capped at 400 days: a lifetime-wide request
    // succeeds and returns the same total as the single day it actually
    // happened on (all of this suite's seed data is dated "today").
    const today = (
      await get(
        t.server,
        path(`reports/sales?groupBy=date&from=${TODAY}&to=${TODAY}`),
        who('owner'),
      ).expect(200)
    ).body as SalesReportBody;
    const lifetime = (
      await get(
        t.server,
        path(`reports/sales?from=${addDays(TODAY, -4000)}&to=${TODAY}`),
        who('owner'),
      ).expect(200)
    ).body as SalesReportBody;
    expect(lifetime.totalAmount).toBe(today.totalAmount);
    expect(lifetime.totalQuantity).toBe(today.totalQuantity);
  });

  it('is closed to a salesman', async () => {
    await get(t.server, path('reports/sales'), who('salesman')).expect(403);
    await get(t.server, path('reports/dues'), who('salesman')).expect(403);
    await get(t.server, path('reports/daily-summary'), who('salesman')).expect(403);
  });

  it('lets a manager read them too', async () => {
    await get(t.server, path('reports/sales'), who('manager')).expect(200);
  });
});

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
const YEAR = TODAY.slice(0, 4);
const MONTH = TODAY.slice(5, 7);

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0178${String(phoneCounter).padStart(7, '0')}`;
};

type Row = Record<string, string | boolean | null>;
interface OrderBody {
  id: string;
  items: { id: string }[];
}

/**
 * Money and stock reconciled against independent SQL: the finance summary, the purchase-batch
 * report, and the rules that keep sales, collections, dues, purchases, expenses and commission apart.
 */
describe.skipIf(!hasDatabase)('FIFO finance and batch report', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;
  let customerId: string;
  let product: string;

  const path = (suffix: string, slug = shop.slug) => `/b/${slug}/${suffix}`;
  const post = (who: string, suffix: string, body: object, slug = shop.slug) =>
    request(t.server)
      .post(`/api/v1${path(suffix, slug)}`)
      .set('Cookie', cookieHeader(as[who] ?? {}))
      .send(body);
  const read = (who: string, suffix: string, slug = shop.slug) =>
    get(t.server, path(suffix, slug), as[who] ?? {});

  /** A creation call that must succeed; the body is in the failure message when it does not. */
  const created = (response: request.Response) => {
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response;
  };

  async function member(name: string, roleKey: string | null) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) await data.giveAccess(user.id, shop.id, roleKey);
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const newProduct = async (slug = shop.slug) =>
    (
      (
        await send(t.server, 'post', path('products', slug), as['owner'] ?? {}, {
          categoryId,
          nameEn: `Cement ${String(Math.random()).slice(2, 12)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;

  const buy = (productId: string, quantity: string, unitPrice: string, purchaseDate: string) =>
    post('owner', 'purchases', {
      items: [{ productId, quantity, unitPrice }],
      purchaseDate,
    }).expect(201);

  async function deliver(
    productId: string,
    quantity: string,
    unitPrice: string,
    date: string,
    forCustomer = customerId,
  ) {
    const order = (
      await post('owner', 'orders', {
        customerId: forCustomer,
        orderDate: date,
        deliveryWindow: 'two_days',
        items: [{ productId, quantity, unitPrice }],
      }).expect(201)
    ).body as OrderBody;
    return post('owner', 'deliveries', {
      orderId: order.id,
      items: [{ orderItemId: order.items[0]?.id, quantity }],
      deliveryDate: date,
    });
  }

  const summary = async (from: string, to: string) =>
    (await read('owner', `dashboard/finance-summary?from=${from}&to=${to}`).expect(200))
      .body as Row;

  /** Net profit worked out from the tables themselves, independent of the API's own code path. */
  async function independent(from: string, to: string) {
    const [row] = await t.prisma.client.$queryRawUnsafe<Row[]>(
      `SELECT
         coalesce((SELECT sum(total_amount) FROM deliveries
                    WHERE business_id = $1::uuid AND status = 'active'
                      AND delivery_date BETWEEN $2::date AND $3::date), 0)::text AS sales,
         (coalesce((SELECT sum(di.cost_amount) FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
                     WHERE di.business_id = $1::uuid AND di.status = 'active' AND d.status = 'active'
                       AND d.delivery_date BETWEEN $2::date AND $3::date), 0)
          + coalesce((SELECT sum(cogs_delta) FROM inventory_cost_corrections
                       WHERE business_id = $1::uuid AND correction_date BETWEEN $2::date AND $3::date), 0))::text AS cogs,
         coalesce((SELECT sum(amount) FROM business_ledger_entries
                    WHERE business_id = $1::uuid AND status = 'active' AND type = 'expense' AND direction = 'out'
                      AND entry_date BETWEEN $2::date AND $3::date), 0)::text AS expenses,
         coalesce((SELECT sum(amount) FROM business_ledger_entries
                    WHERE business_id = $1::uuid AND status = 'active' AND type = 'commission_receipt' AND direction = 'in'
                      AND entry_date BETWEEN $2::date AND $3::date), 0)::text AS commission,
         -- cost of goods sold a second way: from the batch allocations themselves
         (coalesce((SELECT sum(a.cost_amount) FROM delivery_item_allocations a
                      JOIN delivery_items di ON di.id = a.delivery_item_id
                      JOIN deliveries d ON d.id = di.delivery_id
                     WHERE a.business_id = $1::uuid AND a.kind IN ('original', 'reversal')
                       AND d.status = 'active' AND d.delivery_date BETWEEN $2::date AND $3::date), 0)
          + coalesce((SELECT sum(cost_amount) FROM delivery_item_allocations
                       WHERE business_id = $1::uuid AND kind = 'adjustment'
                         AND allocation_date BETWEEN $2::date AND $3::date), 0))::text AS cogs_allocations`,
      shop.id,
      from,
      to,
    );
    return row as Record<string, string>;
  }

  interface Batch {
    id: string;
    sourceType: string;
    supplierId: string | null;
    purchasedQuantity: string;
    deliveredQuantity: string;
    remainingQuantity: string;
    unitCost: string | null;
    originalUnitCost: string | null;
    purchaseValue: string | null;
    remainingValue: string | null;
    revenue: string;
    cogs: string | null;
    grossProfit: string | null;
    profitPerBag: string | null;
    costComplete: boolean;
  }
  interface BatchPage {
    items: Batch[];
    total: number;
    pageSize: number;
  }
  const list = async (query: string, who = 'owner', slug = shop.slug) =>
    (await read(who, `inventory/batches?${query}`, slug).expect(200)).body as BatchPage;

  const cents = (value: unknown) => Number(value).toFixed(2);

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('fifofin');
    other = await data.createBusiness('fifofin-other');
    await runSeed();
    await member('owner', null);
    await member('manager', 'manager');
    categoryId = (
      (
        await send(t.server, 'post', path('product-categories'), as['owner'] ?? {}, {
          nameEn: 'OPC',
          nameBn: 'ওপিসি',
        }).expect(201)
      ).body as { id: string }
    ).id;
    customerId = (
      (
        await send(t.server, 'post', path('customers'), as['owner'] ?? {}, {
          nameEn: 'Main shop',
          phone: newPhone(),
        }).expect(201)
      ).body as { id: string }
    ).id;

    // The scenario: two purchases at different prices, deliveries across two months.
    product = await newProduct();
    await buy(product, '100', '570', '2026-09-01');
    await buy(product, '100', '580', '2026-10-01');
    created(await deliver(product, '120', '900', '2026-10-15'));
    created(await deliver(product, '30', '950', `${YEAR}-${MONTH}-01`));

    // Money that is not sales: a collection, an expense, a commission, and a purchase of stock.
    created(await post('owner', 'collections', { customerId, method: 'cash', amount: '50000' }));
    const kind = (
      await post('owner', 'expense-categories', {
        nameEn: 'Test rent',
        nameBn: 'পরীক্ষার ভাড়া',
      }).expect(201)
    ).body as { id: string };
    await post('owner', 'expenses', { categoryId: kind.id, method: 'cash', amount: '5000' }).expect(
      201,
    );
    await post('owner', 'commission-entries', {
      amount: '3000',
      receivedDate: TODAY,
      note: 'Monthly bonus',
    }).expect(201);
  });

  afterEach(async () => {
    await expectFifoInvariants(t, shop.id);
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('the numbers reconcile to independent SQL', () => {
    it('October: sales, cost, gross profit and net profit', async () => {
      const october = await summary('2026-10-01', '2026-10-31');
      expect(october).toMatchObject({
        sales: '108000.00',
        cogs: '68600.00',
        grossProfit: '39400.00',
        expenses: '0.00',
        commissionReceived: '0.00',
        netProfit: '39400.00',
        costComplete: true,
      });
      const sql = await independent('2026-10-01', '2026-10-31');
      expect([cents(sql['sales']), cents(sql['cogs']), cents(sql['cogs_allocations'])]).toEqual([
        '108000.00',
        '68600.00',
        '68600.00',
      ]);
    });

    it('this month: only what was delivered in it, with the expense and commission', async () => {
      const month = await summary(`${YEAR}-${MONTH}-01`, TODAY);
      // 30 bags drawn from the second batch at 580.
      expect(month).toMatchObject({
        sales: '28500.00',
        cogs: '17400.00',
        grossProfit: '11100.00',
        expenses: '5000.00',
        commissionReceived: '3000.00',
        netProfit: '9100.00',
      });
    });

    it('All Time includes the whole history and matches the tables', async () => {
      const all = await summary('2000-01-01', TODAY);
      const sql = await independent('2000-01-01', TODAY);
      expect(all['sales']).toBe(cents(sql['sales']));
      expect(all['cogs']).toBe(cents(sql['cogs']));
      expect(all['cogs']).toBe(cents(sql['cogs_allocations']));
      expect(all['expenses']).toBe(cents(sql['expenses']));
      expect(all['commissionReceived']).toBe(cents(sql['commission']));
      const net =
        Number(sql['sales']) -
        Number(sql['cogs']) -
        Number(sql['expenses']) +
        Number(sql['commission']);
      expect(all['netProfit']).toBe(net.toFixed(2));
      expect(all).toMatchObject({ sales: '136500.00', cogs: '86000.00', netProfit: '48500.00' });
    });

    it('months add up to All Time', async () => {
      const [october, november, all] = await Promise.all([
        summary('2026-10-01', '2026-10-31'),
        summary(`${YEAR}-${MONTH}-01`, TODAY),
        summary('2000-01-01', TODAY),
      ]);
      for (const key of ['sales', 'cogs', 'netProfit'] as const) {
        expect(Number(october[key]) + Number(november[key])).toBeCloseTo(Number(all[key]), 2);
      }
    });
  });

  describe('what is not sales, cost or profit', () => {
    it('a customer collection is cash in, never extra revenue', async () => {
      const before = await summary('2000-01-01', TODAY);
      await post('owner', 'collections', { customerId, method: 'bank', amount: '1000' }).expect(
        201,
      );
      const after = await summary('2000-01-01', TODAY);
      expect(after['sales']).toBe(before['sales']);
      expect(after['netProfit']).toBe(before['netProfit']);
      expect(Number(after['collection']) - Number(before['collection'])).toBe(1000);
      // Money owed falls by what was collected, and is not itself profit.
      expect(Number(before['customerDue']) - Number(after['customerDue'])).toBe(1000);
    });

    it('customer due is sales less collections, and is not in profit', async () => {
      const all = await summary('2000-01-01', TODAY);
      expect(Number(all['customerDue'])).toBe(Number(all['sales']) - Number(all['collection']) + 0);
    });

    it('buying stock is an asset, not an expense: net profit does not move', async () => {
      const before = await summary('2000-01-01', TODAY);
      const stock = await newProduct();
      await buy(stock, '500', '600', TODAY);
      const after = await summary('2000-01-01', TODAY);
      expect(after['netProfit']).toBe(before['netProfit']);
      expect(after['cogs']).toBe(before['cogs']);
      expect(Number(after['totalPurchase']) - Number(before['totalPurchase'])).toBe(300000);
      expect(Number(after['currentStockValue']) - Number(before['currentStockValue'])).toBe(300000);
    });

    it('commission received is its own income, counted once', async () => {
      const before = await summary('2000-01-01', TODAY);
      await post('owner', 'commission-entries', {
        amount: '700',
        receivedDate: TODAY,
        note: 'Extra',
      }).expect(201);
      const after = await summary('2000-01-01', TODAY);
      expect(Number(after['commissionReceived']) - Number(before['commissionReceived'])).toBe(700);
      expect(Number(after['netProfit']) - Number(before['netProfit'])).toBe(700);
      expect(after['sales']).toBe(before['sales']);
    });

    it('an expense lowers net profit but not gross profit', async () => {
      const before = await summary('2000-01-01', TODAY);
      const kind = (
        await post('owner', 'expense-categories', {
          nameEn: 'Test fuel',
          nameBn: 'পরীক্ষার জ্বালানি',
        }).expect(201)
      ).body as { id: string };
      await post('owner', 'expenses', {
        categoryId: kind.id,
        method: 'cash',
        amount: '250',
      }).expect(201);
      const after = await summary('2000-01-01', TODAY);
      expect(Number(before['netProfit']) - Number(after['netProfit'])).toBe(250);
      expect(after['grossProfit']).toBe(before['grossProfit']);
    });
  });

  describe('stock opening, closing and cost completeness', () => {
    it('opening + received − cost of sales = closing, month by month', async () => {
      const october = await summary('2026-10-01', '2026-10-31');
      expect(october).toMatchObject({
        openingStockQuantity: '100.000',
        closingStockQuantity: '80.000',
        openingStockValue: '57000.00',
        closingStockValue: '46400.00',
        purchaseQuantity: '100.000',
        totalPurchase: '58000.00',
      });
      expect(57000 + 58000 - 68600).toBe(46400);

      const november = await summary(`${YEAR}-${MONTH}-01`, TODAY);
      // Closing stock of October is the opening stock of November.
      expect(november['openingStockQuantity']).toBe(october['closingStockQuantity']);
      expect(november['openingStockValue']).toBe(october['closingStockValue']);
    });

    it('flags an incomplete cost instead of showing a verified-looking zero', async () => {
      const found = await newProduct();
      await post('owner', 'stock/adjustments', {
        productId: found,
        quantity: '10',
        reason: 'found during the count',
      }).expect(201);
      const before = await summary('2000-01-01', TODAY);
      expect((await deliver(found, '4', '900', TODAY)).status).toBe(201);
      const after = await summary('2000-01-01', TODAY);
      expect(after['costComplete']).toBe(false);
      expect(
        Number(after['uncostedQuantityDelivered']) - Number(before['uncostedQuantityDelivered']),
      ).toBe(4);
      expect(Number(after['uncostedDeliveryLines'])).toBeGreaterThan(
        Number(before['uncostedDeliveryLines']),
      );
      expect(Number(after['productsWithUnknownCostStock'])).toBeGreaterThan(0);
      // Revenue is real; the missing cost is not invented, so cost of sales did not move.
      expect(after['cogs']).toBe(before['cogs']);
    });

    it('hides cost, profit and stock value from a manager', async () => {
      const body = (
        await read('manager', `dashboard/finance-summary?from=2026-10-01&to=2026-10-31`).expect(200)
      ).body as Row;
      expect(body['sales']).toBeDefined();
      for (const key of [
        'cogs',
        'grossProfit',
        'netProfit',
        'costComplete',
        'openingStockValue',
        'closingStockValue',
        'productsWithUnknownCostStock',
      ]) {
        expect(body[key]).toBeUndefined();
      }
    });
  });

  describe('the purchase-batch report', () => {
    it('shows each purchase with what it earned, from the real allocations', async () => {
      const page = await list(`productId=${product}`);
      expect(page.pageSize).toBe(10);
      const [a, b] = page.items;
      expect(a).toMatchObject({
        unitCost: '570.00',
        purchasedQuantity: '100',
        deliveredQuantity: '100',
        remainingQuantity: '0',
        purchaseValue: '57000.00',
        remainingValue: '0.00',
        // 100 of the first 120 bags: 100/120 of 108,000.
        revenue: '90000.00',
        cogs: '57000.00',
        grossProfit: '33000.00',
        profitPerBag: '330.00',
        costComplete: true,
      });
      expect(b).toMatchObject({
        unitCost: '580.00',
        purchasedQuantity: '100',
        deliveredQuantity: '50',
        remainingQuantity: '50',
        remainingValue: '29000.00',
        // 20/120 of 108,000, plus all of the 28,500 delivery.
        revenue: '46500.00',
        cogs: '29000.00',
        grossProfit: '17500.00',
        profitPerBag: '350.00',
      });
      // The batches' profit adds up to the business's gross profit for this product.
      expect(Number(a?.grossProfit) + Number(b?.grossProfit)).toBe(50500);
    });

    it('counts only deliveries inside a delivery date range', async () => {
      const page = await list(
        `productId=${product}&deliveryFrom=${YEAR}-${MONTH}-01&deliveryTo=${TODAY}`,
      );
      const [a, b] = page.items;
      expect(a).toMatchObject({ deliveredQuantity: '0', revenue: '0.00', cogs: '0.00' });
      expect(b).toMatchObject({
        deliveredQuantity: '30',
        revenue: '28500.00',
        cogs: '17400.00',
        grossProfit: '11100.00',
        profitPerBag: '370.00',
      });
    });

    it('filters by purchase date, supplier, source and result', async () => {
      expect((await list(`productId=${product}&purchaseFrom=2026-10-01`)).items).toHaveLength(1);
      expect((await list(`productId=${product}&purchaseTo=2026-09-30`)).items).toHaveLength(1);
      const supplierId = (await list(`productId=${product}`)).items[0]?.supplierId ?? '';
      expect(supplierId).not.toBe('');
      expect((await list(`productId=${product}&supplierId=${supplierId}`)).total).toBe(2);
      expect(
        (await list(`productId=${product}&supplierId=00000000-0000-7000-8000-0000000000aa`)).total,
      ).toBe(0);
      expect((await list(`productId=${product}&result=profit`)).total).toBe(2);
      expect((await list(`productId=${product}&result=loss`)).total).toBe(0);
    });

    it('shows a batch that sold below its cost as a loss, per bag too', async () => {
      const dear = await newProduct();
      await buy(dear, '10', '1000', '2026-08-01');
      expect((await deliver(dear, '5', '900', '2026-08-20')).status).toBe(201);
      const losses = await list(`productId=${dear}&result=loss`);
      expect(losses.items).toHaveLength(1);
      expect(losses.items[0]).toMatchObject({
        revenue: '4500.00',
        cogs: '5000.00',
        grossProfit: '-500.00',
        profitPerBag: '-100.00',
      });
      expect((await list(`productId=${dear}&result=profit`)).total).toBe(0);
    });

    it('does not call an unknown-cost batch profitable or zero-cost', async () => {
      const found = await newProduct();
      await post('owner', 'stock/adjustments', {
        productId: found,
        quantity: '10',
        reason: 'found during the count',
      }).expect(201);
      expect((await deliver(found, '4', '900', TODAY)).status).toBe(201);
      const page = await list(`productId=${found}&source=adjustment`);
      expect(page.items[0]).toMatchObject({
        sourceType: 'adjustment',
        unitCost: null,
        cogs: null,
        grossProfit: null,
        profitPerBag: null,
        purchaseValue: null,
        costComplete: false,
        deliveredQuantity: '4',
        revenue: '3600.00',
      });
      // A loss/profit filter never includes a batch whose cost is unknown.
      expect((await list(`productId=${found}&result=profit`)).total).toBe(0);
    });

    it('drills down to the purchase and the deliveries that drew from a batch', async () => {
      const second = (await list(`productId=${product}`)).items[1];
      const detail = (await read('owner', `inventory/batches/${second?.id ?? ''}`).expect(200))
        .body as Batch & {
        deliveries: { deliveryDate: string; quantity: string; cost: string; revenue: string }[];
        events: { eventType: string; valueDelta: string }[];
      };
      expect(detail.deliveries.map((d) => [d.deliveryDate, d.quantity, d.cost, d.revenue])).toEqual(
        [
          ['2026-10-15', '20', '11600.00', '18000.00'],
          [`${YEAR}-${MONTH}-01`, '30', '17400.00', '28500.00'],
        ],
      );
      expect(detail.events.map((e) => [e.eventType, e.valueDelta])).toEqual([
        ['received', '58000.00'],
      ]);
    });

    it('is owner-only: a manager cannot read prices, cost or profit per batch', async () => {
      const id = (await list(`productId=${product}`)).items[0]?.id ?? '';
      await read('manager', `inventory/batches?productId=${product}`).expect(403);
      await read('manager', `inventory/batches/${id}`).expect(403);
    });

    it('never shows another business’s batches', async () => {
      const id = (await list(`productId=${product}`)).items[0]?.id ?? '';
      const empty = await list('', 'owner', other.slug);
      expect(empty.total).toBe(0);
      const missing = await read('owner', `inventory/batches/${id}`, other.slug).expect(404);
      expect((missing.body as { code: string }).code).toBe('BATCH_NOT_FOUND');
    });
  });

  describe('two people delivering at once', () => {
    it('never draw the same bags twice', async () => {
      const racing = await newProduct();
      await buy(racing, '100', '500', TODAY);
      const [first, second] = await Promise.all([
        deliver(racing, '60', '900', TODAY),
        deliver(racing, '60', '900', TODAY),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const refused = first.status === 409 ? first : second;
      expect((refused.body as { code: string }).code).toBe('STOCK_INSUFFICIENT');
      const batch = (await list(`productId=${racing}`)).items[0];
      expect(batch).toMatchObject({
        deliveredQuantity: '60',
        remainingQuantity: '40',
        cogs: '30000.00',
      });
    });
  });
});

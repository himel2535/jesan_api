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

interface BucketView {
  opening: string;
  collectionsIn: string;
  in: string;
  out: string;
  closing: string;
}
interface CashbookBody {
  from: string;
  to: string;
  cash: BucketView;
  bank: BucketView;
  unassigned: BucketView;
  availableCashAndBank: string;
}
interface MonthlyBody {
  year: number;
  months: {
    month: string;
    collection: string;
    sales: string;
    salesQuantity: string;
    purchaseQuantity: string;
    purchaseAmount?: string;
  }[];
}
interface KpiWindowBody {
  from: string;
  to: string;
  collection: string;
  sales: string;
  salesQuantity: string;
  purchaseQuantity?: string;
}
interface KpisBody {
  current: KpiWindowBody;
  previous: KpiWindowBody | null;
}
interface CommissionBody {
  year: number;
  months: { month: string; received: string }[];
  yearReceived: string;
  lifetimeReceived: string;
}

const TODAY = todayIn('Asia/Dhaka');
const THIS_MONTH = TODAY.slice(0, 7);
const THIS_YEAR = Number(TODAY.slice(0, 4));

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0176${String(phoneCounter).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('dashboard aggregates', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
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

  const cashbook = async (who_ = 'owner', query = `?from=${TODAY}&to=${TODAY}`) =>
    (await get(t.server, path(`dashboard/cashbook${query}`), who(who_))) as {
      status: number;
      body: CashbookBody;
    };

  const monthly = async (who_ = 'owner', query = `?year=${String(THIS_YEAR)}`) =>
    (await get(t.server, path(`dashboard/monthly-series${query}`), who(who_))) as {
      status: number;
      body: MonthlyBody;
    };

  const commission = async (who_ = 'owner', query = `?year=${String(THIS_YEAR)}`) =>
    (await get(t.server, path(`dashboard/commission-series${query}`), who(who_))) as {
      status: number;
      body: CommissionBody;
    };

  async function customer() {
    return (
      (
        await send(t.server, 'post', path('customers'), who('owner'), {
          nameEn: `Dash ${String(Math.random()).slice(2, 10)}`,
          phone: newPhone(),
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('dashboard');
    await runSeed();
    await member('owner', null);
    await member('manager', 'manager');
    await member('salesman', 'salesman');
    await member('accountant', 'accountant');
    const seeded = (await get(t.server, path('expense-categories'), who('owner')).expect(200))
      .body as { items: { id: string; nameEn: string }[] };
    salary = seeded.items.find((row) => row.nameEn === 'Salary')?.id ?? '';
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('cashbook', () => {
    it('opening + in − out = closing for every bucket, and availableCashAndBank = cash + bank', async () => {
      const id = await customer();
      await post('owner', 'collections', { customerId: id, method: 'cash', amount: '400' }).expect(
        201,
      );
      await post('owner', 'expenses', { categoryId: salary, method: 'bkash', amount: '90' }).expect(
        201,
      );
      const { body } = await cashbook();
      for (const bucket of [body.cash, body.bank, body.unassigned]) {
        expect(Number(bucket.closing)).toBeCloseTo(
          Number(bucket.opening) + Number(bucket.in) - Number(bucket.out),
          2,
        );
      }
      expect(Number(body.availableCashAndBank)).toBeCloseTo(
        Number(body.cash.closing) + Number(body.bank.closing),
        2,
      );
    });

    it('counts a cash collection as actual cash collection, and the cash bucket moves by exactly that amount', async () => {
      const before = (await cashbook()).body;
      const id = await customer();
      await post('owner', 'collections', { customerId: id, method: 'cash', amount: '250' }).expect(
        201,
      );
      const after = (await cashbook()).body;
      expect(Number(after.cash.collectionsIn) - Number(before.cash.collectionsIn)).toBeCloseTo(
        250,
        2,
      );
      expect(Number(after.cash.closing) - Number(before.cash.closing)).toBeCloseTo(250, 2);
      expect(Number(after.bank.closing)).toBeCloseTo(Number(before.bank.closing), 2);
    });

    it('a manual entry with no method is shown as unassigned and never added to cash or bank', async () => {
      const before = (await cashbook()).body;
      await post('owner', 'accounts/entries', { direction: 'in', amount: '75' })
        .set('Idempotency-Key', `dash-manual-${String(Math.random()).slice(2)}`)
        .expect(201);
      const after = (await cashbook()).body;
      expect(Number(after.unassigned.in) - Number(before.unassigned.in)).toBeCloseTo(75, 2);
      expect(Number(after.cash.closing)).toBeCloseTo(Number(before.cash.closing), 2);
      expect(Number(after.bank.closing)).toBeCloseTo(Number(before.bank.closing), 2);
    });

    it('rejects a malformed date with 400', async () => {
      const response = await get(
        t.server,
        path('dashboard/cashbook?from=2026-13-40'),
        who('owner'),
      );
      expect(response.status).toBe(400);
    });

    it('is forbidden to a salesman who lacks cashbook.view', async () => {
      const { status } = await cashbook('salesman');
      expect(status).toBe(403);
    });
  });

  describe('monthly series', () => {
    it('returns twelve months, and a delta on this month equals a new collection', async () => {
      const before = (await monthly()).body;
      expect(before.months).toHaveLength(12);
      expect(before.months.map((row) => row.month)).toContain(THIS_MONTH);
      const id = await customer();
      await post('owner', 'collections', { customerId: id, method: 'bank', amount: '1000' }).expect(
        201,
      );
      const after = (await monthly()).body;
      const pick = (body: MonthlyBody) => body.months.find((row) => row.month === THIS_MONTH);
      expect(Number(pick(after)?.collection) - Number(pick(before)?.collection)).toBeCloseTo(
        1000,
        2,
      );
    });

    it('owner sees purchase cost; a manager (product.cost.view) does too', async () => {
      const owner = (await monthly()).body;
      expect(owner.months[0]?.purchaseAmount).toBeDefined();
      const manager = (await monthly('manager')).body;
      expect(manager.months[0]?.purchaseAmount).toBeDefined();
    });

    it('rejects a year outside the supported range with 400', async () => {
      const { status } = await monthly('owner', '?year=1999');
      expect(status).toBe(400);
    });
  });

  describe('kpis', () => {
    const kpis = async (who_ = 'owner', query = `?from=${THIS_MONTH}-01&to=${TODAY}`) =>
      (await get(t.server, path(`dashboard/kpis${query}`), who(who_))) as {
        status: number;
        body: KpisBody & { code?: string; field?: string };
      };

    it('matches the collection, sales and purchase reports for the same window', async () => {
      const window = `from=${THIS_MONTH}-01&to=${TODAY}`;
      const { body } = await kpis('owner', `?${window}`);
      const collections = (
        await get(
          t.server,
          path(`reports/collections?groupBy=date&${window}&page=1`),
          who('owner'),
        ).expect(200)
      ).body as { totalAmount: string };
      const sales = (
        await get(
          t.server,
          path(`reports/sales?groupBy=date&${window}&page=1`),
          who('owner'),
        ).expect(200)
      ).body as { totalAmount: string; totalQuantity: string };
      const purchases = (
        await get(t.server, path(`purchases/summary?${window}`), who('owner')).expect(200)
      ).body as { totalQuantity: string };
      expect(body.current.collection).toBe(collections.totalAmount);
      expect(body.current.sales).toBe(sales.totalAmount);
      expect(Number(body.current.salesQuantity)).toBeCloseTo(Number(sales.totalQuantity), 3);
      expect(Number(body.current.purchaseQuantity)).toBeCloseTo(Number(purchases.totalQuantity), 3);
      expect(body.previous).toBeNull();
    });

    it('a new collection moves only the window that contains it', async () => {
      const yesterday = new Date(`${TODAY}T00:00:00.000Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const day = yesterday.toISOString().slice(0, 10);
      const query = `?from=${TODAY}&to=${TODAY}&prevFrom=${day}&prevTo=${day}`;
      const before = (await kpis('owner', query)).body;
      const id = await customer();
      await post('owner', 'collections', { customerId: id, method: 'cash', amount: '125' }).expect(
        201,
      );
      const after = (await kpis('owner', query)).body;
      expect(Number(after.current.collection) - Number(before.current.collection)).toBeCloseTo(
        125,
        2,
      );
      expect(after.previous?.collection).toBe(before.previous?.collection);
      expect(after.previous?.from).toBe(day);
    });

    it('hides bags bought from someone without purchase.view, but still answers', async () => {
      const accountant = await kpis('accountant');
      expect(accountant.status).toBe(200);
      expect(accountant.body.current.collection).toBeDefined();
      expect(accountant.body.current.purchaseQuantity).toBeUndefined();
      expect((await kpis('manager')).body.current.purchaseQuantity).toBeDefined();
    });

    it('is forbidden to a salesman who lacks report.view', async () => {
      expect((await kpis('salesman')).status).toBe(403);
    });

    it('rejects a half-sent or invalid comparison window with the documented code', async () => {
      const half = await kpis('owner', `?from=${TODAY}&to=${TODAY}&prevFrom=${TODAY}`);
      expect([half.status, half.body.code, half.body.field]).toEqual([
        400,
        'PREV_TO_REQUIRED',
        'prevTo',
      ]);
      const other = await kpis('owner', `?from=${TODAY}&to=${TODAY}&prevTo=${TODAY}`);
      expect([other.status, other.body.code]).toEqual([400, 'PREV_FROM_REQUIRED']);
      const backwards = await kpis(
        'owner',
        `?from=${TODAY}&to=${TODAY}&prevFrom=${TODAY}&prevTo=2000-01-01`,
      );
      expect([backwards.status, backwards.body.code]).toEqual([400, 'PREV_TO_INVALID']);
      const notReal = await kpis(
        'owner',
        `?from=${TODAY}&to=${TODAY}&prevFrom=2026-02-30&prevTo=2026-03-01`,
      );
      expect([notReal.status, notReal.body.code]).toEqual([400, 'PREV_FROM_INVALID']);
    });
  });

  describe('commission series (owner only)', () => {
    it('is forbidden to a manager, who lacks commission.view', async () => {
      const { status } = await commission('manager');
      expect(status).toBe(403);
    });

    it('records commission received: the month, year and lifetime totals move by its amount', async () => {
      const before = (await commission()).body;
      await send(t.server, 'post', path('commission-entries'), who('owner'), {
        amount: '300',
        receivedDate: TODAY,
        note: 'DASH-E2E',
      }).expect(201);
      const after = (await commission()).body;
      const month = (body: CommissionBody) => body.months.find((row) => row.month === THIS_MONTH);
      expect(Number(month(after)?.received) - Number(month(before)?.received)).toBeCloseTo(300, 2);
      expect(Number(after.yearReceived) - Number(before.yearReceived)).toBeCloseTo(300, 2);
      expect(Number(after.lifetimeReceived) - Number(before.lifetimeReceived)).toBeCloseTo(300, 2);
      expect(after).not.toHaveProperty('receivable');
    });

    it('adds commission received to net profit for the same day', async () => {
      const q = `?from=${TODAY}&to=${TODAY}`;
      const profit = async () => {
        const res = await get(t.server, path(`dashboard/finance-summary${q}`), who('owner')).expect(
          200,
        );
        return Number((res.body as { netProfit: string }).netProfit);
      };
      const before = await profit();
      await send(t.server, 'post', path('commission-entries'), who('owner'), {
        amount: '700',
        receivedDate: TODAY,
        note: 'profit check',
      }).expect(201);
      expect((await profit()) - before).toBeCloseTo(700, 2);
    });
  });
});

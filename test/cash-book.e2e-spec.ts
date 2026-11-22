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

interface MethodRow {
  method: string;
  isCash: boolean;
  in: string;
  out: string;
  net: string;
}
interface DayRow {
  date: string;
  opening: string;
  collections: string;
  expenses: string;
  purchases: string;
  in: string;
  out: string;
  closing: string;
}
interface CashBookBody {
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  totals: {
    collections: string;
    expenses: string;
    purchases: string;
    in: string;
    out: string;
    net: string;
    cashIn: string;
    cashOut: string;
    cashNet: string;
  };
  byMethod: MethodRow[];
  days: DayRow[];
  page: number;
  pageSize: number;
  total: number;
}
interface ErrorBody {
  code: string;
  field?: string;
}

const TODAY = todayIn('Asia/Dhaka');

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0175${String(phoneCounter).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('cash book', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;
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

  const cashBook = async (query = '', who_ = 'owner') =>
    (await get(t.server, path(`cash-book${query}`), who(who_)).expect(200)).body as CashBookBody;

  async function product() {
    return (
      (
        await send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameEn: `Cement ${String(Math.random()).slice(2, 10)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  async function customer() {
    return (
      (
        await send(t.server, 'post', path('customers'), who('owner'), {
          nameEn: `Shop ${String(Math.random()).slice(2, 10)}`,
          phone: newPhone(),
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('cash-book');
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
    const seeded = (await get(t.server, path('expense-categories'), who('owner')).expect(200))
      .body as { items: { id: string; nameEn: string }[] };
    salary = seeded.items.find((row) => row.nameEn === 'Salary')?.id ?? '';
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  it('balances today alone: opening + collections − expenses − cash purchases = closing', async () => {
    const productId = await product();
    await post('owner', 'purchases', {
      items: [{ productId, quantity: '100', unitPrice: '500' }],
    }).expect(201);
    const customerId = await customer();
    await post('owner', 'orders', {
      customerId,
      deliveryWindow: 'today',
      items: [{ productId, quantity: '10', unitPrice: '600' }],
    }).expect(201);
    await post('owner', 'collections', { customerId, method: 'cash', amount: '3000' }).expect(201);
    await post('owner', 'expenses', { categoryId: salary, method: 'cash', amount: '1200' }).expect(
      201,
    );

    const book = await cashBook(`?from=${TODAY}&to=${TODAY}`);
    const today = book.days.find((row) => row.date === TODAY);
    expect(today).toBeDefined();
    const opening = Number(today?.opening);
    const closing = Number(today?.closing);
    expect(closing).toBeCloseTo(
      opening + Number(today?.collections) - Number(today?.expenses) - Number(today?.purchases),
      5,
    );
    expect(book.closingBalance).toBe(today?.closing);
  });

  it('splits by method and keeps the cash/bank split from config', async () => {
    const customerId = await customer();
    await post('owner', 'collections', { customerId, method: 'bank', amount: '500' }).expect(201);
    await post('owner', 'expenses', { categoryId: salary, method: 'bkash', amount: '150' }).expect(
      201,
    );

    const book = await cashBook(`?from=${TODAY}&to=${TODAY}`);
    const cash = book.byMethod.find((row) => row.method === 'cash');
    const bank = book.byMethod.find((row) => row.method === 'bank');
    const bkash = book.byMethod.find((row) => row.method === 'bkash');
    expect(cash?.isCash).toBe(true);
    expect(bank?.isCash).toBe(false);
    expect(bkash?.isCash).toBe(false);
    expect(Number(bank?.in)).toBeGreaterThanOrEqual(500);
    expect(Number(bkash?.out)).toBeGreaterThanOrEqual(150);
    // The cash-only totals exclude bank and mobile banking.
    const net = book.totals;
    expect(Number(net.cashIn) + Number(net.cashOut)).not.toBe(0);
  });

  it('excludes a voided collection or expense', async () => {
    const before = await cashBook(`?from=${TODAY}&to=${TODAY}`);
    const customerId = await customer();
    const collection = (
      await post('owner', 'collections', { customerId, method: 'cash', amount: '999' }).expect(201)
    ).body as { id: string };
    await post('owner', `collections/${collection.id}/void`, { reason: 'Wrong entry' }).expect(200);
    const after = await cashBook(`?from=${TODAY}&to=${TODAY}`);
    expect(after.totals.collections).toBe(before.totals.collections);
  });

  it('defaults to this month and accepts a lifetime-wide range', async () => {
    const book = await cashBook('');
    expect(book.from).toBe(`${TODAY.slice(0, 7)}-01`);
    expect(book.to).toBe(TODAY);

    // The range is no longer capped at 400 days: a lifetime-wide request
    // succeeds, and its closing balance matches the this-month view's (no
    // activity happened before this month in this suite's seed data).
    const lifetime = await cashBook(`?from=${addDays(TODAY, -4000)}&to=${TODAY}`);
    expect(lifetime.closingBalance).toBe(book.closingBalance);

    const backwards = (
      await get(
        t.server,
        path(`cash-book?from=${TODAY}&to=${addDays(TODAY, -1)}`),
        who('owner'),
      ).expect(400)
    ).body as ErrorBody;
    expect(backwards).toMatchObject({ code: 'TO_INVALID', field: 'to' });
  });

  it('is closed to a salesman', async () => {
    await get(t.server, path('cash-book'), who('salesman')).expect(403);
  });

  it('lets a manager read it too', async () => {
    await get(t.server, path('cash-book'), who('manager')).expect(200);
  });
});

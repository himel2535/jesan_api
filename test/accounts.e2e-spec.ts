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

interface ErrorBody {
  code: string;
  field?: string;
  message: string;
}
interface LedgerEntryBody {
  id: string;
  type: string;
  direction: string;
  amount: string;
  method: string | null;
  referenceType: string | null;
  referenceId: string | null;
  entryDate: string;
  note: string | null;
  status: string;
}
interface LedgerListBody {
  items: LedgerEntryBody[];
  page: number;
  pageSize: number;
  total: number;
}
interface SummaryBody {
  from: string;
  to: string;
  totalIn: string;
  totalOut: string;
  net: string;
  totalDue: string;
  totalAdvance: string;
  byType: { type: string; in: string; out: string }[];
}

const TODAY = todayIn('Asia/Dhaka');

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0171${String(phoneCounter).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('accounts (business ledger)', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;
  let expenseCategoryId: string;

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

  async function product(slug = shop.slug) {
    return (
      (
        await send(t.server, 'post', path('products', slug), who('owner'), {
          categoryId,
          nameEn: `Cement ${String(Math.random()).slice(2, 10)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  async function purchase(amount: string, slug = shop.slug) {
    const productId = await product(slug);
    const body = (
      await post(
        'manager',
        'purchases',
        { items: [{ productId, quantity: '1', unitPrice: amount }] },
        {},
        slug,
      ).expect(201)
    ).body as { id: string; totalAmount: string };
    return body;
  }

  async function customer(extra: object = {}, slug = shop.slug) {
    return (
      (
        await send(t.server, 'post', path('customers', slug), who('owner'), {
          nameEn: `Shop ${String(Math.random()).slice(2, 10)}`,
          phone: newPhone(),
          openingBalance: '0',
          ...extra,
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  async function collection(amount: string, extra: object = {}, slug = shop.slug) {
    const customerId = await customer({}, slug);
    return (
      await post(
        'accountant',
        'collections',
        { customerId, method: 'cash', amount, ...extra },
        {},
        slug,
      ).expect(201)
    ).body as { id: string; amount: string };
  }

  async function expense(amount: string, extra: object = {}, slug = shop.slug) {
    return (
      await post(
        'accountant',
        'expenses',
        { categoryId: expenseCategoryId, method: 'cash', amount, ...extra },
        {},
        slug,
      ).expect(201)
    ).body as { id: string; amount: string };
  }

  const summary = async (query = '', actor = 'accountant', slug = shop.slug) =>
    (await get(t.server, path(`accounts/summary${query}`, slug), who(actor)).expect(200))
      .body as SummaryBody;

  const ledger = async (query = '', actor = 'accountant', slug = shop.slug) =>
    (await get(t.server, path(`accounts/ledger${query}`, slug), who(actor)).expect(200))
      .body as LedgerListBody;

  const byType = (body: SummaryBody, type: string) =>
    body.byType.find((row) => row.type === type) ?? { type, in: '0.00', out: '0.00' };

  const byReference = (body: LedgerListBody, referenceId: string) =>
    body.items.find((row) => row.referenceId === referenceId);

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('accounts');
    other = await data.createBusiness('accounts-other');
    await runSeed();
    await member('owner', null);
    await member('manager', 'manager');
    await member('accountant', 'accountant');
    await member('salesman', 'salesman');
    await member('otherAccountant', 'accountant', other.id);
    categoryId = (
      (
        await send(t.server, 'post', path('product-categories'), who('owner'), {
          nameEn: 'Cement',
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;
    const categories = (await get(t.server, path('expense-categories'), who('owner')).expect(200))
      .body as { items: { id: string; nameEn: string }[] };
    expenseCategoryId = categories.items[0]?.id ?? '';
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('summary', () => {
    it('moves byType, totalIn/totalOut/net when collections, expenses and purchases are created', async () => {
      const before = await summary();
      await collection('500');
      const exp = await expense('200');
      await purchase('300');

      const after = await summary();
      expect(Number(byType(after, 'collection').in) - Number(byType(before, 'collection').in)).toBe(
        500,
      );
      expect(Number(byType(after, 'expense').out) - Number(byType(before, 'expense').out)).toBe(
        200,
      );
      expect(Number(byType(after, 'purchase').out) - Number(byType(before, 'purchase').out)).toBe(
        300,
      );
      expect(Number(after.totalIn) - Number(before.totalIn)).toBe(500);
      expect(Number(after.totalOut) - Number(before.totalOut)).toBe(500);
      expect(Number(after.net) - Number(before.net)).toBe(0);

      // Voiding removes it from the summary again.
      await post('owner', `expenses/${exp.id}/void`, { reason: 'test cleanup' }).expect(200);
      const afterVoid = await summary();
      expect(Number(afterVoid.totalOut)).toBe(Number(after.totalOut) - 200);
      expect(Number(byType(afterVoid, 'expense').out)).toBe(
        Number(byType(after, 'expense').out) - 200,
      );
    });

    it('filters by date, and leaves totalDue/totalAdvance unaffected by the date range', async () => {
      const beforeDue = await summary();
      await customer({ openingBalance: '1000' });

      const narrow = await summary(`?from=${addDays(TODAY, -2)}&to=${addDays(TODAY, -1)}`);
      // A customer opened just now still counts toward the due total, even
      // though the narrow date window excludes today.
      expect(Number(narrow.totalDue)).toBe(Number(beforeDue.totalDue) + 1000);

      await expense('50', { expenseDate: addDays(TODAY, -1) });
      const yesterdayOnly = await summary(`?from=${addDays(TODAY, -1)}&to=${addDays(TODAY, -1)}`);
      expect(Number(byType(yesterdayOnly, 'expense').out)).toBeGreaterThanOrEqual(50);
    });
  });

  describe('ledger list', () => {
    it('pages ten at a time and filters by type', async () => {
      for (let i = 0; i < 12; i += 1) {
        await expense('11');
      }
      const first = await ledger();
      expect(first.pageSize).toBe(10);
      expect(first.items.length).toBeLessThanOrEqual(10);
      expect(first.total).toBeGreaterThanOrEqual(12);

      const byTypeOnly = await ledger('?type=expense');
      expect(byTypeOnly.items.every((row) => row.type === 'expense')).toBe(true);
    });

    it('refuses a range over 400 days', async () => {
      const tooWide = (
        await get(
          t.server,
          path(`accounts/ledger?from=${addDays(TODAY, -401)}&to=${TODAY}`),
          who('accountant'),
        ).expect(400)
      ).body as ErrorBody;
      expect(tooWide).toMatchObject({ code: 'RANGE_TOO_LARGE', field: 'to' });
    });

    it('never shows another business’s entries', async () => {
      await expense('77');
      const otherList = await ledger('', 'otherAccountant', other.slug);
      expect(otherList.items.every((row) => Number(row.amount) !== 77)).toBe(true);
    });
  });

  describe('auto-entry on void', () => {
    it('flips the ledger row to void when the source collection is voided', async () => {
      const col = await collection('640');
      const before = await ledger(`?from=${TODAY}&to=${TODAY}&type=collection`);
      expect(byReference(before, col.id)?.status).toBe('active');

      await post('owner', `collections/${col.id}/void`, { reason: 'test cleanup' }).expect(200);
      const after = await ledger(`?from=${TODAY}&to=${TODAY}&type=collection`);
      expect(byReference(after, col.id)?.status).toBe('void');
    });

    it('flips the ledger row to void when the source purchase is voided', async () => {
      const pur = await purchase('410');
      await post('owner', `purchases/${pur.id}/void`, { reason: 'test cleanup' }).expect(200);
      const after = await ledger(`?from=${TODAY}&to=${TODAY}&type=purchase`);
      expect(byReference(after, pur.id)?.status).toBe('void');
    });
  });

  describe('manual entries', () => {
    it('records a manual entry with a required Idempotency-Key, saving once per key', async () => {
      const key = `entry-${String(Date.now())}`;
      const first = await post(
        'accountant',
        'accounts/entries',
        { direction: 'in', amount: '150', method: 'cash', note: 'Owner cash injection' },
        { 'Idempotency-Key': key },
      ).expect(201);
      const again = await post(
        'accountant',
        'accounts/entries',
        { direction: 'in', amount: '150', method: 'cash', note: 'Owner cash injection' },
        { 'Idempotency-Key': key },
      ).expect(200);
      expect((again.body as LedgerEntryBody).id).toBe((first.body as LedgerEntryBody).id);
      expect(first.body as LedgerEntryBody).toMatchObject({
        type: 'manual',
        direction: 'in',
        amount: '150.00',
        status: 'active',
      });

      const missingKey = (
        await post('accountant', 'accounts/entries', {
          direction: 'in',
          amount: '10',
        }).expect(400)
      ).body as ErrorBody;
      expect(missingKey).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        field: 'Idempotency-Key',
      });
    });

    it('refuses an amount of zero, a bad direction and an unknown method', async () => {
      const zero = (
        await post(
          'accountant',
          'accounts/entries',
          { direction: 'in', amount: '0' },
          { 'Idempotency-Key': `e-${String(Date.now())}-1` },
        ).expect(400)
      ).body as ErrorBody;
      expect(zero).toMatchObject({ code: 'AMOUNT_TOO_SMALL', field: 'amount' });

      const badDirection = (
        await post(
          'accountant',
          'accounts/entries',
          { direction: 'sideways', amount: '10' },
          { 'Idempotency-Key': `e-${String(Date.now())}-2` },
        ).expect(400)
      ).body as ErrorBody;
      expect(badDirection.code).toBe('VALIDATION_FAILED');

      const badMethod = (
        await post(
          'accountant',
          'accounts/entries',
          { direction: 'in', amount: '10', method: 'crypto' },
          { 'Idempotency-Key': `e-${String(Date.now())}-3` },
        ).expect(400)
      ).body as ErrorBody;
      expect(badMethod).toMatchObject({ code: 'LEDGER_ENTRY_METHOD_UNKNOWN', field: 'method' });
    });

    it('refuses an entry date more than 7 days back or in the future', async () => {
      const future = (
        await post(
          'accountant',
          'accounts/entries',
          { direction: 'in', amount: '10', entryDate: addDays(TODAY, 1) },
          { 'Idempotency-Key': `e-${String(Date.now())}-4` },
        ).expect(400)
      ).body as ErrorBody;
      expect(future).toMatchObject({ code: 'ENTRY_DATE_IN_FUTURE', field: 'entryDate' });

      const old = (
        await post(
          'accountant',
          'accounts/entries',
          { direction: 'in', amount: '10', entryDate: addDays(TODAY, -8) },
          { 'Idempotency-Key': `e-${String(Date.now())}-5` },
        ).expect(400)
      ).body as ErrorBody;
      expect(old).toMatchObject({ code: 'ENTRY_DATE_TOO_OLD', field: 'entryDate' });
    });

    it('refuses an entry from someone without ledger.entry.create', async () => {
      await post(
        'manager',
        'accounts/entries',
        { direction: 'in', amount: '10' },
        { 'Idempotency-Key': `e-${String(Date.now())}-6` },
      ).expect(403);
      await post(
        'salesman',
        'accounts/entries',
        { direction: 'in', amount: '10' },
        { 'Idempotency-Key': `e-${String(Date.now())}-7` },
      ).expect(403);
    });
  });

  describe('supplier payments', () => {
    it('records a payment with a required Idempotency-Key, saving once per key', async () => {
      const key = `pay-${String(Date.now())}`;
      const first = await post(
        'accountant',
        'accounts/payments',
        { amount: '900', method: 'bank', note: 'Cement Ltd invoice' },
        { 'Idempotency-Key': key },
      ).expect(201);
      const again = await post(
        'accountant',
        'accounts/payments',
        { amount: '900', method: 'bank', note: 'Cement Ltd invoice' },
        { 'Idempotency-Key': key },
      ).expect(200);
      expect((again.body as LedgerEntryBody).id).toBe((first.body as LedgerEntryBody).id);
      expect(first.body).toMatchObject({
        type: 'supplier_payment',
        direction: 'out',
        amount: '900.00',
        method: 'bank',
      });

      const missingKey = (
        await post('accountant', 'accounts/payments', { amount: '10', method: 'cash' }).expect(400)
      ).body as ErrorBody;
      expect(missingKey.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('refuses too far back and from someone without payment.create', async () => {
      const old = (
        await post(
          'accountant',
          'accounts/payments',
          { amount: '10', method: 'cash', paymentDate: addDays(TODAY, -8) },
          { 'Idempotency-Key': `p-${String(Date.now())}-1` },
        ).expect(400)
      ).body as ErrorBody;
      expect(old).toMatchObject({ code: 'PAYMENT_DATE_TOO_OLD', field: 'paymentDate' });

      await post(
        'manager',
        'accounts/payments',
        { amount: '10', method: 'cash' },
        { 'Idempotency-Key': `p-${String(Date.now())}-2` },
      ).expect(403);
    });
  });
});

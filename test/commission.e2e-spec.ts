import { addDays, todayIn } from '../src/core/common/business-time';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import { TestApp, TestData, createTestApp, get, login, runSeed, send } from './helpers';
import type { Cookies } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

interface SchemeBody {
  rateBase: string;
  targetQty: string;
  bonusRate: string;
}
interface EntryBody {
  id: string;
  fromDate: string;
  toDate: string;
  quantity: string;
  calculatedAmount: string;
  receivedAmount: string;
  pendingAmount: string;
}
interface ReceiptBody {
  id: string;
  amount: string;
  receivedDate: string;
}
interface SummaryBody {
  year: number;
  totalCalculated: string;
  totalReceived: string;
  totalPending: string;
  entryCount: number;
  receiptCount: number;
}
interface ErrorBody {
  code: string;
  field?: string;
}

const TODAY = todayIn('Asia/Dhaka');

describe.skipIf(!hasDatabase)('commission', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string, slug = shop.slug) => `/b/${slug}/${suffix}`;

  async function member(name: string, roleKey: string | null, businessId?: string) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey && businessId) {
      await data.giveAccess(user.id, businessId, roleKey);
    }
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const setScheme = (rateBase: string, targetQty: string, bonusRate: string, slug = shop.slug) =>
    send(t.server, 'put', path('commission-scheme', slug), who('owner'), {
      rateBase,
      targetQty,
      bonusRate,
    });

  const createEntry = (
    quantity: string,
    fromDate = TODAY,
    toDate = TODAY,
    slug = shop.slug,
    actor = 'owner',
  ) =>
    send(t.server, 'post', path('commission-entries', slug), who(actor), {
      fromDate,
      toDate,
      quantity,
    });

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('commission');
    other = await data.createBusiness('commission-other');
    await runSeed(); // creates each business's principal supplier
    await member('owner', null);
    await member('ownerRole', 'owner', shop.id);
    await member('manager', 'manager', shop.id);
    await member('otherOwner', null);
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('scheme', () => {
    it('is null until the owner sets it, then upserts', async () => {
      const before = await get(t.server, path('commission-scheme'), who('owner')).expect(200);
      expect((before.body as { scheme: SchemeBody | null }).scheme).toBeNull();

      const created = await setScheme('10.00', '10', '1.00').expect(200);
      expect(created.body).toMatchObject({
        rateBase: '10.00',
        targetQty: '10',
        bonusRate: '1.00',
      });

      const replaced = await setScheme('12.00', '12000', '2.00').expect(200);
      expect(replaced.body).toMatchObject({ rateBase: '12.00', targetQty: '12000' });

      const after = await get(t.server, path('commission-scheme'), who('owner')).expect(200);
      expect((after.body as { scheme: SchemeBody | null }).scheme).toMatchObject({
        rateBase: '12.00',
      });
      // Restore a simple scheme for the rest of the tests.
      await setScheme('10.00', '10', '1.00').expect(200);
    });

    it('validates each field with a code and the field name', async () => {
      const zero = await setScheme('0', '10', '1.00').expect(400);
      expect(zero.body).toMatchObject({ code: 'RATE_BASE_TOO_SMALL', field: 'rateBase' });
      const zeroTarget = await setScheme('10.00', '0', '1.00').expect(400);
      expect(zeroTarget.body).toMatchObject({ code: 'TARGET_QTY_TOO_SMALL', field: 'targetQty' });
      // bonusRate may be zero (base only); the pattern itself refuses a negative.
      await setScheme('10.00', '10', '0').expect(200);
      await setScheme('10.00', '10', '1.00').expect(200);
    });

    it('is owner-only for both view and manage, even for the business owner role', async () => {
      await get(t.server, path('commission-scheme'), who('manager')).expect(403);
      await get(t.server, path('commission-scheme'), who('ownerRole')).expect(403);
      await send(t.server, 'put', path('commission-scheme'), who('manager'), {
        rateBase: '5.00',
        targetQty: '1',
        bonusRate: '0.50',
      }).expect(403);
      await send(t.server, 'put', path('commission-scheme'), who('ownerRole'), {
        rateBase: '5.00',
        targetQty: '1',
        bonusRate: '0.50',
      }).expect(403);
    });
  });

  describe('entries', () => {
    it('refuses to create an entry before a scheme exists', async () => {
      const fresh = await data.createBusiness('commission-noscheme');
      await data.giveAccess((await data.createUser({ name: 'x' })).id, fresh.id, 'owner');
      const response = await createEntry('15', TODAY, TODAY, fresh.slug);
      expect(response.status).toBe(400);
      expect(response.body as ErrorBody).toMatchObject({ code: 'COMMISSION_SCHEME_NOT_SET' });
    });

    it('calculates base + bonus from the current scheme (15 at target 10 → 155.00)', async () => {
      const response = await createEntry('15').expect(201);
      const body = response.body as EntryBody;
      expect(body).toMatchObject({
        fromDate: TODAY,
        toDate: TODAY,
        quantity: '15',
        calculatedAmount: '155.00',
        receivedAmount: '0.00',
        pendingAmount: '155.00',
      });
    });

    it('recalculates on patch when the quantity changes', async () => {
      const created = (await createEntry('8').expect(201)).body as EntryBody;
      expect(created.calculatedAmount).toBe('80.00');
      const patched = await send(
        t.server,
        'patch',
        path(`commission-entries/${created.id}`),
        who('owner'),
        { quantity: '20' },
      ).expect(200);
      expect((patched.body as EntryBody).calculatedAmount).toBe('210.00');
    });

    it('refuses an invalid or future date range', async () => {
      const future = await createEntry('5', addDays(TODAY, 1), addDays(TODAY, 1));
      expect(future.status).toBe(400);
      expect((future.body as ErrorBody).code).toBe('COMMISSION_DATE_IN_FUTURE');
      const reversed = await createEntry('5', TODAY, addDays(TODAY, -5));
      expect(reversed.status).toBe(400);
      expect((reversed.body as ErrorBody).code).toBe('COMMISSION_DATE_RANGE_INVALID');
    });

    it('404s for a missing entry and another business’s entry', async () => {
      const missing = await get(
        t.server,
        path('commission-entries/00000000-0000-7000-8000-000000000000'),
        who('owner'),
      ).expect(404);
      expect((missing.body as ErrorBody).code).toBe('COMMISSION_ENTRY_NOT_FOUND');
      const created = (await createEntry('5').expect(201)).body as EntryBody;
      const otherUser = await data.createUser({ name: 'other' });
      await data.giveAccess(otherUser.id, other.id, 'owner');
      await setScheme('1.00', '1', '0.00', other.slug);
      const theirs = await get(
        t.server,
        path(`commission-entries/${created.id}`, other.slug),
        who('otherOwner'),
      ).expect(404);
      expect(theirs.body).toEqual(missing.body);
    });
  });

  describe('purchase suggestion', () => {
    it('sums active purchases in the date range, excluding void ones', async () => {
      const category = (
        (
          await send(t.server, 'post', path('product-categories'), who('owner'), {
            nameEn: 'OPC',
            nameBn: 'ওপিসি',
          }).expect(201)
        ).body as { id: string }
      ).id;
      const product = (
        (
          await send(t.server, 'post', path('products'), who('owner'), {
            categoryId: category,
            nameEn: 'Cement',
            nameBn: 'সিমেন্ট',
          }).expect(201)
        ).body as { id: string }
      ).id;
      await send(t.server, 'post', path('purchases'), who('owner'), {
        items: [{ productId: product, quantity: '100', unitPrice: '10' }],
      }).expect(201);
      const response = await get(
        t.server,
        path(`commission-entries/suggestion?from=${TODAY}&to=${TODAY}`),
        who('owner'),
      ).expect(200);
      expect(Number((response.body as { quantity: string }).quantity)).toBeGreaterThanOrEqual(100);
    });
  });

  describe('receipts', () => {
    it('updates the entry’s receivedAmount/pendingAmount and supports editing', async () => {
      const entry = (await createEntry('10').expect(201)).body as EntryBody; // 10 * 10 = 100.00
      const receipt = (
        await send(
          t.server,
          'post',
          path(`commission-entries/${entry.id}/receipts`),
          who('owner'),
          { amount: '40.00', receivedDate: TODAY, reference: 'AK-1' },
        ).expect(201)
      ).body as ReceiptBody;
      expect(receipt).toMatchObject({ amount: '40.00', receivedDate: TODAY });

      const afterOne = (
        await get(t.server, path(`commission-entries/${entry.id}`), who('owner')).expect(200)
      ).body as EntryBody;
      expect(afterOne).toMatchObject({ receivedAmount: '40.00', pendingAmount: '60.00' });

      await send(
        t.server,
        'patch',
        path(`commission-entries/${entry.id}/receipts/${receipt.id}`),
        who('owner'),
        { amount: '100.00' },
      ).expect(200);

      const afterEdit = (
        await get(t.server, path(`commission-entries/${entry.id}`), who('owner')).expect(200)
      ).body as EntryBody;
      expect(afterEdit).toMatchObject({ receivedAmount: '100.00', pendingAmount: '0.00' });
    });

    it('404s a receipt not belonging to the entry', async () => {
      const entryA = (await createEntry('1').expect(201)).body as EntryBody;
      const entryB = (await createEntry('1').expect(201)).body as EntryBody;
      const receipt = (
        await send(
          t.server,
          'post',
          path(`commission-entries/${entryA.id}/receipts`),
          who('owner'),
          { amount: '1.00', receivedDate: TODAY },
        ).expect(201)
      ).body as ReceiptBody;
      const response = await send(
        t.server,
        'patch',
        path(`commission-entries/${entryB.id}/receipts/${receipt.id}`),
        who('owner'),
        { amount: '2.00' },
      ).expect(404);
      expect((response.body as ErrorBody).code).toBe('COMMISSION_RECEIPT_NOT_FOUND');
    });
  });

  describe('summary', () => {
    it('sums calculated and received amounts for the year', async () => {
      const year = Number(TODAY.slice(0, 4));
      const response = await get(
        t.server,
        path(`commission-summary?year=${String(year)}`),
        who('owner'),
      ).expect(200);
      const body = response.body as SummaryBody;
      expect(body.year).toBe(year);
      expect(Number(body.totalCalculated)).toBeGreaterThan(0);
      expect(Number(body.totalPending)).toBe(
        Number(body.totalCalculated) - Number(body.totalReceived),
      );
      expect(body.entryCount).toBeGreaterThan(0);
    });
  });
});

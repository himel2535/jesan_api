import { addDays, todayIn } from '../src/core/common/business-time';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import { TestApp, TestData, createTestApp, get, login, runSeed, send } from './helpers';
import type { Cookies } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

interface EntryBody {
  id: string;
  amount: string;
  receivedDate: string;
  note: string | null;
}
interface SummaryBody {
  year: number;
  totalReceived: string;
  entryCount: number;
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

  const createEntry = (body: Record<string, unknown> = {}, slug = shop.slug, actor = 'owner') =>
    send(t.server, 'post', path('commission-entries', slug), who(actor), {
      amount: '1000',
      receivedDate: TODAY,
      note: 'Monthly target bonus',
      ...body,
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

  describe('entries', () => {
    it('records the amount, date and reason exactly as typed, with no calculation', async () => {
      const res = await createEntry({ amount: '2500.50', note: 'Festival bonus' }).expect(201);
      const body = res.body as EntryBody;
      expect(body).toMatchObject({
        amount: '2500.50',
        receivedDate: TODAY,
        note: 'Festival bonus',
      });
      expect(body).not.toHaveProperty('calculatedAmount');
      const read = await get(t.server, path(`commission-entries/${body.id}`), who('owner')).expect(
        200,
      );
      expect((read.body as EntryBody).amount).toBe('2500.50');
    });

    it('requires a reason and a positive amount, with the field name', async () => {
      const noNote = await createEntry({ note: '   ' }).expect(400);
      expect((noNote.body as ErrorBody).code).toBe('VALIDATION_FAILED');
      await createEntry({ note: undefined }).expect(400);
      const zero = await createEntry({ amount: '0' }).expect(400);
      expect(zero.body).toMatchObject({ code: 'AMOUNT_TOO_SMALL', field: 'amount' });
      await createEntry({ amount: 'abc' }).expect(400);
    });

    it('refuses a future or invalid date', async () => {
      const future = await createEntry({ receivedDate: addDays(TODAY, 2) }).expect(400);
      expect(future.body).toMatchObject({
        code: 'COMMISSION_DATE_IN_FUTURE',
        field: 'receivedDate',
      });
      const bad = await createEntry({ receivedDate: '2026-02-31' }).expect(400);
      expect(bad.body).toMatchObject({ code: 'COMMISSION_DATE_INVALID', field: 'receivedDate' });
    });

    it('patches only the changed fields and keeps the ledger in step (net profit follows)', async () => {
      const entry = (await createEntry({ amount: '400' }).expect(201)).body as EntryBody;
      const patched = await send(
        t.server,
        'patch',
        path(`commission-entries/${entry.id}`),
        who('owner'),
        { amount: '450', note: 'Corrected' },
      ).expect(200);
      expect(patched.body).toMatchObject({ amount: '450.00', note: 'Corrected' });
      const rows = await t.prisma.client.businessLedgerEntry.findMany({
        where: { businessId: shop.id, referenceType: 'commission_receipt', referenceId: entry.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.amount.toFixed(2)).toBe('450.00');
      expect(rows[0]?.direction).toBe('in');
      expect(rows[0]?.method).toBeNull();
    });

    it('posts an `in` / commission_receipt ledger row when created', async () => {
      const entry = (await createEntry({ amount: '120' }).expect(201)).body as EntryBody;
      const rows = await t.prisma.client.businessLedgerEntry.findMany({
        where: { businessId: shop.id, referenceId: entry.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'commission_receipt', direction: 'in' });
    });

    it('lists newest first, ten a page', async () => {
      const res = await get(t.server, path('commission-entries'), who('owner')).expect(200);
      const body = res.body as { items: EntryBody[]; pageSize: number; total: number };
      expect(body.pageSize).toBe(10);
      expect(body.total).toBeGreaterThan(0);
      const dates = body.items.map((item) => item.receivedDate);
      expect([...dates].sort().reverse()).toEqual(dates);
    });

    it('404s for a missing entry and another business’s entry', async () => {
      const theirs = (await createEntry({}, shop.slug).expect(201)).body as EntryBody;
      await get(t.server, path(`commission-entries/${theirs.id}`, other.slug), who('owner')).expect(
        404,
      );
      await send(
        t.server,
        'patch',
        path('commission-entries/00000000-0000-7000-8000-000000000999'),
        who('owner'),
        { note: 'x' },
      ).expect(404);
    });
  });

  describe('permissions', () => {
    it('is owner-only for both view and manage, even for the business owner role', async () => {
      for (const who_ of ['ownerRole', 'manager']) {
        await get(t.server, path('commission-entries'), who(who_)).expect(403);
        await createEntry({}, shop.slug, who_).expect(403);
        await get(t.server, path('commission-summary?year=2026'), who(who_)).expect(403);
      }
      await get(t.server, path('commission-entries'), who('owner')).expect(200);
    });

    it('no longer has a scheme, suggestion or receipts endpoint', async () => {
      await get(t.server, path('commission-scheme'), who('owner')).expect(404);
      await get(
        t.server,
        path(`commission-entries/suggestion?from=${TODAY}&to=${TODAY}`),
        who('owner'),
      ).expect(400); // "suggestion" is now read as an :id
    });
  });

  describe('summary', () => {
    it('sums the amounts received in the year', async () => {
      const year = Number(TODAY.slice(0, 4));
      const before = (
        await get(t.server, path(`commission-summary?year=${String(year)}`), who('owner')).expect(
          200,
        )
      ).body as SummaryBody;
      await createEntry({ amount: '300' }).expect(201);
      const after = (
        await get(t.server, path(`commission-summary?year=${String(year)}`), who('owner')).expect(
          200,
        )
      ).body as SummaryBody;
      expect(after.entryCount).toBe(before.entryCount + 1);
      expect(Number(after.totalReceived) - Number(before.totalReceived)).toBeCloseTo(300, 2);
      expect(after).not.toHaveProperty('totalCalculated');
    });
  });
});

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

interface ExpenseBody {
  id: string;
  code: string;
  expenseDate: string;
  method: string;
  amount: string;
  note: string | null;
  proofNote: string | null;
  status: string;
  version: number;
  voidReason: string | null;
  category: { id: string; nameEn: string };
}
interface CategoryBody {
  id: string;
  nameEn: string;
  isActive: boolean;
  version: number;
}
interface Impact {
  key: string;
  label: string;
  before?: unknown;
  after?: unknown;
  note?: string;
}
interface RequestBody {
  id: string;
  status: string;
  impact: Impact[];
}
interface ErrorBody {
  code: string;
  field?: string;
  message: string;
}

const TODAY = todayIn('Asia/Dhaka');

describe.skipIf(!hasDatabase)('voiding and correcting expenses', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let salary: string;
  let rent: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string) => `/b/${shop.slug}/${suffix}`;

  async function member(name: string, roleKey: string | null) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) await data.giveAccess(user.id, shop.id, roleKey);
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const post = (who_: string, suffix: string, body: object = {}) =>
    request(t.server)
      .post(`/api/v1${path(suffix)}`)
      .set('Cookie', cookieHeader(who(who_)))
      .send(body);

  async function expense(body: object = {}) {
    return (
      await post('accountant', 'expenses', {
        categoryId: salary,
        method: 'cash',
        amount: '5000',
        note: 'Salary',
        ...body,
      }).expect(201)
    ).body as ExpenseBody;
  }

  const expenseNow = async (id: string, who_ = 'manager') =>
    (await get(t.server, path(`expenses/${id}`), who(who_)).expect(200)).body as ExpenseBody;

  const approve = (who_: string, id: string) =>
    send(t.server, 'post', path(`change-requests/${id}/approve`), who(who_));

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('expense-changes');
    await runSeed();
    await member('owner', null);
    await member('ownerRole', 'owner');
    await member('manager', 'manager');
    await member('accountant', 'accountant');
    const seeded = (await get(t.server, path('expense-categories'), who('owner')).expect(200))
      .body as { items: CategoryBody[] };
    salary = seeded.items.find((row) => row.nameEn === 'Salary')?.id ?? '';
    rent = seeded.items.find((row) => row.nameEn === 'Rent')?.id ?? '';
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('directly, at owner level', () => {
    it('corrects the fields and bumps the version', async () => {
      const created = await expense();
      const fixed = (
        await send(t.server, 'patch', path(`expenses/${created.id}`), who('owner'), {
          amount: '5500.25',
          method: 'bank',
          categoryId: rent,
          note: 'Rent, not salary',
          proofNote: 'Receipt 88',
          expenseDate: addDays(TODAY, -1),
          reason: 'Booked against the wrong kind',
        }).expect(200)
      ).body as ExpenseBody;
      expect(fixed).toMatchObject({
        amount: '5500.25',
        method: 'bank',
        note: 'Rent, not salary',
        proofNote: 'Receipt 88',
        expenseDate: addDays(TODAY, -1),
        status: 'active',
        version: 2,
      });
      expect(fixed.category.nameEn).toBe('Rent');
    });

    it('voids with a reason and refuses a second void or a later correction', async () => {
      const created = await expense();
      const voided = (
        await post('owner', `expenses/${created.id}/void`, {
          reason: 'Paid twice by mistake',
        }).expect(200)
      ).body as ExpenseBody;
      expect(voided).toMatchObject({
        status: 'void',
        version: 2,
        voidReason: 'Paid twice by mistake',
      });

      const again = (
        await post('owner', `expenses/${created.id}/void`, { reason: 'again' }).expect(409)
      ).body as ErrorBody;
      expect(again.code).toBe('EXPENSE_ALREADY_VOID');

      const edit = (
        await send(t.server, 'patch', path(`expenses/${created.id}`), who('owner'), {
          amount: '1',
          reason: 'too late',
        }).expect(409)
      ).body as ErrorBody;
      expect(edit.code).toBe('EXPENSE_ALREADY_VOID');
    });

    it('refuses an unknown or inactive kind in a correction', async () => {
      const created = await expense();
      const kind = (
        await post('manager', 'expense-categories', {
          nameEn: 'Closing kind',
          nameBn: 'বন্ধ হবে',
        }).expect(201)
      ).body as CategoryBody;
      await send(t.server, 'patch', path(`expense-categories/${kind.id}`), who('manager'), {
        isActive: false,
        reason: 'Not needed',
      }).expect(200);

      const refused = (
        await send(t.server, 'patch', path(`expenses/${created.id}`), who('owner'), {
          categoryId: kind.id,
          reason: 'Move it there',
        }).expect(400)
      ).body as ErrorBody;
      expect(refused).toMatchObject({
        code: 'EXPENSE_CATEGORY_NOT_FOUND_OR_INACTIVE',
        field: 'categoryId',
      });
    });
  });

  describe('staff may only ask', () => {
    it('refuses a direct correction or void from a manager or an accountant', async () => {
      const created = await expense();
      await send(t.server, 'patch', path(`expenses/${created.id}`), who('manager'), {
        amount: '1',
        reason: 'no',
      }).expect(403);
      await post('manager', `expenses/${created.id}/void`, { reason: 'no' }).expect(403);
      await send(t.server, 'patch', path(`expenses/${created.id}`), who('accountant'), {
        amount: '1',
        reason: 'no',
      }).expect(403);
      // Nothing moved.
      expect(await expenseNow(created.id)).toMatchObject({ amount: '5000.00', version: 1 });
    });

    it('shows the impact of a correction and applies it once approved', async () => {
      const created = await expense({ amount: '7000' });
      const asked = (
        await post('manager', 'change-requests', {
          entityType: 'expense',
          entityId: created.id,
          kind: 'edit',
          reason: 'The bill was 6500, not 7000',
          proposedChange: { amount: '6500' },
        }).expect(201)
      ).body as RequestBody;
      expect(asked.impact.find((line) => line.key === 'expense.amount')).toMatchObject({
        before: '7000.00',
        after: '6500.00',
      });

      await approve('owner', asked.id).expect(200);
      expect(await expenseNow(created.id)).toMatchObject({ amount: '6500.00', version: 2 });
    });

    it('shows the impact of a void and applies it once approved', async () => {
      const created = await expense({ amount: '3000' });
      const asked = (
        await post('manager', 'change-requests', {
          entityType: 'expense',
          entityId: created.id,
          kind: 'void',
          reason: 'This expense never happened',
        }).expect(201)
      ).body as RequestBody;
      const line = asked.impact.find((row) => row.key === 'expense.amount');
      expect(line).toMatchObject({ before: '3000.00', after: '0.00' });
      expect(line?.note).toContain('cash book');

      await approve('owner', asked.id).expect(200);
      expect(await expenseNow(created.id)).toMatchObject({ status: 'void', version: 2 });
    });

    it('refuses an amount of zero or less, and a date in the future, in a request', async () => {
      const created = await expense();
      const zero = (
        await post('manager', 'change-requests', {
          entityType: 'expense',
          entityId: created.id,
          kind: 'edit',
          reason: 'Trying zero',
          proposedChange: { amount: '0' },
        }).expect(400)
      ).body as ErrorBody;
      expect(zero).toMatchObject({ code: 'AMOUNT_INVALID', field: 'proposedChange.amount' });

      const future = (
        await post('manager', 'change-requests', {
          entityType: 'expense',
          entityId: created.id,
          kind: 'edit',
          reason: 'Trying tomorrow',
          proposedChange: { expenseDate: addDays(TODAY, 1) },
        }).expect(400)
      ).body as ErrorBody;
      expect(future).toMatchObject({
        code: 'EXPENSE_DATE_IN_FUTURE',
        field: 'proposedChange.expenseDate',
      });

      const method = (
        await post('manager', 'change-requests', {
          entityType: 'expense',
          entityId: created.id,
          kind: 'edit',
          reason: 'Trying barter',
          proposedChange: { method: 'barter' },
        }).expect(400)
      ).body as ErrorBody;
      expect(method).toMatchObject({
        code: 'EXPENSE_METHOD_UNKNOWN',
        field: 'proposedChange.method',
      });
    });

    it('lets nobody approve their own request, not even at owner level', async () => {
      const created = await expense();
      const asked = (
        await post('ownerRole', 'change-requests', {
          entityType: 'expense',
          entityId: created.id,
          kind: 'edit',
          reason: 'My own correction',
          proposedChange: { amount: '4000' },
        }).expect(201)
      ).body as RequestBody;
      const refused = (await approve('ownerRole', asked.id).expect(403)).body as ErrorBody;
      expect(refused.code).toBe('SELF_DECISION_FORBIDDEN');
      expect(await expenseNow(created.id)).toMatchObject({ amount: '5000.00', version: 1 });
    });

    it('turns a request stale when the expense changed in the meantime', async () => {
      const created = await expense();
      const asked = (
        await post('manager', 'change-requests', {
          entityType: 'expense',
          entityId: created.id,
          kind: 'edit',
          reason: 'Make it 4000',
          proposedChange: { amount: '4000' },
        }).expect(201)
      ).body as RequestBody;
      await send(t.server, 'patch', path(`expenses/${created.id}`), who('owner'), {
        amount: '4500',
        reason: 'Owner got there first',
      }).expect(200);

      const stale = (await approve('owner', asked.id).expect(409)).body as ErrorBody;
      expect(stale.code).toBe('STALE_REQUEST');
      // The old value was never forced on.
      expect(await expenseNow(created.id)).toMatchObject({ amount: '4500.00' });
    });

    it('lets a staff member ask for an expense kind to be deactivated', async () => {
      const kind = (
        await post('manager', 'expense-categories', {
          nameEn: 'Asked to close',
          nameBn: 'বন্ধের অনুরোধ',
        }).expect(201)
      ).body as CategoryBody;
      const asked = (
        await post('accountant', 'change-requests', {
          entityType: 'expense_category',
          entityId: kind.id,
          kind: 'edit',
          reason: 'We never use this kind',
          proposedChange: { isActive: false },
        }).expect(201)
      ).body as RequestBody;
      expect(asked.impact.find((line) => line.key === 'expense_category.isActive')).toMatchObject({
        before: true,
        after: false,
      });

      await approve('owner', asked.id).expect(200);
      const after = (
        await get(t.server, path('expense-categories?active=false'), who('manager')).expect(200)
      ).body as { items: CategoryBody[] };
      expect(after.items).toContainEqual(
        expect.objectContaining({ id: kind.id, isActive: false, version: 2 }),
      );
    });
  });
});

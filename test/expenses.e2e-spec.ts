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
  category: { id: string; nameEn: string; nameBn: string };
}
interface CategoryBody {
  id: string;
  nameEn: string;
  nameBn: string;
  sortOrder: number;
  isActive: boolean;
  version: number;
}
interface ListBody<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
interface ErrorBody {
  code: string;
  field?: string;
  message: string;
}

const TODAY = todayIn('Asia/Dhaka');

describe.skipIf(!hasDatabase)('expenses and expense kinds', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  let rods: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let salary: string;
  let rent: string;

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

  const categories = async (who_ = 'owner', slug = shop.slug, query = '') =>
    (await get(t.server, path(`expense-categories${query}`, slug), who(who_)).expect(200)).body as {
      items: CategoryBody[];
    };

  async function expense(who_: string, body: object = {}, slug = shop.slug) {
    return (
      await post(
        who_,
        'expenses',
        { categoryId: salary, method: 'cash', amount: '5000', ...body },
        {},
        slug,
      ).expect(201)
    ).body as ExpenseBody;
  }

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('expenses');
    other = await data.createBusiness('expenses-other');
    // A second config, so nothing about bags, prefixes or methods is assumed.
    rods = await data.createBusiness('expenses-rods', {
      units: [
        { key: 'kg', nameEn: 'Kilogram', nameBn: 'কেজি', decimals: 3 },
        { key: 'ton', nameEn: 'Ton', nameBn: 'টন', decimals: 3 },
      ],
      defaultUnit: 'ton',
      codePrefixes: { product: 'RD', customer: 'RC', supplier: 'RS', expense: 'RE' },
      expenseMethods: ['cash', 'bank'],
      cashMethodKeys: ['cash'],
      defaultExpenseCategories: [
        { nameEn: 'Wages', nameBn: 'মজুরি' },
        { nameEn: 'Freight', nameBn: 'পরিবহন' },
      ],
    });
    // The seed gives every dealership its starting expense kinds.
    await runSeed();
    await member('owner', null);
    await member('manager', 'manager');
    await member('accountant', 'accountant');
    await member('salesman', 'salesman');
    await member('otherManager', 'manager', other.id);
    await member('rodManager', 'manager', rods.id);
    const seeded = (await categories()).items;
    salary = seeded.find((row) => row.nameEn === 'Salary')?.id ?? '';
    rent = seeded.find((row) => row.nameEn === 'Rent')?.id ?? '';
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('expense kinds', () => {
    it('gives every business the starting kinds from its config', async () => {
      const seeded = (await categories()).items;
      expect(seeded.map((row) => row.nameEn)).toEqual([
        'Salary',
        'Rent',
        'Electricity',
        'Vehicle and fuel',
        'Hospitality',
        'Other',
      ]);
      expect(seeded[0]).toMatchObject({ nameBn: 'বেতন', isActive: true, version: 1 });
      // The rod business asked for its own list: no code knows either list.
      const rodKinds = (await categories('rodManager', rods.slug)).items;
      expect(rodKinds.map((row) => row.nameEn)).toEqual(['Wages', 'Freight']);
      expect(rodKinds.map((row) => row.nameBn)).toEqual(['মজুরি', 'পরিবহন']);
    });

    it('lets a manager add a kind and refuses a duplicate name', async () => {
      const created = (
        await post('manager', 'expense-categories', {
          nameEn: 'Office supplies',
          nameBn: 'অফিস সরঞ্জাম',
          sortOrder: 7,
        }).expect(201)
      ).body as CategoryBody;
      expect(created).toMatchObject({ nameEn: 'Office supplies', isActive: true, version: 1 });

      const clash = (
        await post('manager', 'expense-categories', {
          nameEn: 'Office supplies',
          nameBn: 'অন্য নাম',
        }).expect(409)
      ).body as ErrorBody;
      expect(clash).toMatchObject({ code: 'NAME_EN_DUPLICATE', field: 'nameEn' });
    });

    it('needs a reason to deactivate a kind, and then refuses new expenses on it', async () => {
      const kind = (
        await post('manager', 'expense-categories', {
          nameEn: 'Temporary kind',
          nameBn: 'অস্থায়ী',
        }).expect(201)
      ).body as CategoryBody;

      const noReason = (
        await send(t.server, 'patch', path(`expense-categories/${kind.id}`), who('manager'), {
          isActive: false,
        }).expect(400)
      ).body as ErrorBody;
      expect(noReason).toMatchObject({ code: 'REASON_REQUIRED', field: 'reason' });

      const off = (
        await send(t.server, 'patch', path(`expense-categories/${kind.id}`), who('manager'), {
          isActive: false,
          reason: 'Not used any more',
        }).expect(200)
      ).body as CategoryBody;
      expect(off).toMatchObject({ isActive: false, version: 2 });

      const refused = (
        await post('manager', 'expenses', {
          categoryId: kind.id,
          method: 'cash',
          amount: '100',
        }).expect(400)
      ).body as ErrorBody;
      expect(refused).toMatchObject({
        code: 'EXPENSE_CATEGORY_NOT_FOUND_OR_INACTIVE',
        field: 'categoryId',
      });

      // Inactive kinds are still listed when asked for.
      expect((await categories('owner', shop.slug, '?active=false')).items).toContainEqual(
        expect.objectContaining({ id: kind.id }),
      );
    });

    it('refuses a change that changes nothing, and an unknown id', async () => {
      const nothing = (
        await send(t.server, 'patch', path(`expense-categories/${salary}`), who('manager'), {
          nameEn: 'Salary',
        }).expect(400)
      ).body as ErrorBody;
      expect(nothing.code).toBe('NOTHING_TO_CHANGE');

      const missing = (
        await send(
          t.server,
          'patch',
          path(`expense-categories/0196b1f0-0000-7000-8000-000000000000`),
          who('manager'),
          { nameEn: 'Nope' },
        ).expect(404)
      ).body as ErrorBody;
      expect(missing.code).toBe('EXPENSE_CATEGORY_NOT_FOUND');
    });

    it('hides the kinds from a salesman and the buttons from an accountant', async () => {
      await get(t.server, path('expense-categories'), who('salesman')).expect(403);
      await post('accountant', 'expense-categories', {
        nameEn: 'Nope',
        nameBn: 'না',
      }).expect(403);
    });
  });

  describe('creating an expense', () => {
    it('numbers it from the business config and keeps money a string', async () => {
      const created = await expense('accountant', {
        amount: '5450.50',
        note: 'November salary',
        proofNote: 'Voucher 12, file A',
      });
      expect(created.code).toMatch(/^EXP-\d{4}$/);
      expect(created).toMatchObject({
        amount: '5450.50',
        method: 'cash',
        expenseDate: TODAY,
        status: 'active',
        version: 1,
        note: 'November salary',
        proofNote: 'Voucher 12, file A',
      });
      expect(created.category).toMatchObject({ nameEn: 'Salary', nameBn: 'বেতন' });

      // The rod business uses its own prefix and its own methods.
      const rodKinds = (await categories('rodManager', rods.slug)).items;
      const rodExpense = (
        await post(
          'rodManager',
          'expenses',
          { categoryId: rodKinds[0]?.id, method: 'bank', amount: '12.3' },
          {},
          rods.slug,
        ).expect(201)
      ).body as ExpenseBody;
      expect(rodExpense.code).toMatch(/^RE-\d{4}$/);
      // Money always has two places, whatever decimals the units allow.
      expect(rodExpense.amount).toBe('12.30');
      const tooPrecise = (
        await post(
          'rodManager',
          'expenses',
          { categoryId: rodKinds[0]?.id, method: 'bank', amount: '12.345' },
          {},
          rods.slug,
        ).expect(400)
      ).body as ErrorBody;
      expect(tooPrecise.code).toBe('VALIDATION_FAILED');
    });

    it('saves once for the same Idempotency-Key', async () => {
      const key = `expense-${String(Date.now())}`;
      const first = await post(
        'manager',
        'expenses',
        {
          categoryId: rent,
          method: 'cash',
          amount: '9000',
        },
        { 'Idempotency-Key': key },
      ).expect(201);
      const again = await post(
        'manager',
        'expenses',
        {
          categoryId: rent,
          method: 'cash',
          amount: '9000',
        },
        { 'Idempotency-Key': key },
      ).expect(200);
      expect((again.body as ExpenseBody).id).toBe((first.body as ExpenseBody).id);

      const bad = (
        await post(
          'manager',
          'expenses',
          { categoryId: rent, method: 'cash', amount: '1' },
          { 'Idempotency-Key': 'short' },
        ).expect(400)
      ).body as ErrorBody;
      expect(bad).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID', field: 'Idempotency-Key' });
    });

    it('refuses an amount of zero or less, and an unknown method', async () => {
      const zero = (
        await post('manager', 'expenses', {
          categoryId: salary,
          method: 'cash',
          amount: '0',
        }).expect(400)
      ).body as ErrorBody;
      expect(zero).toMatchObject({ code: 'AMOUNT_TOO_SMALL', field: 'amount' });

      // A negative amount never reaches the service: the money pattern rejects it.
      const negative = (
        await post('manager', 'expenses', {
          categoryId: salary,
          method: 'cash',
          amount: '-5',
        }).expect(400)
      ).body as ErrorBody;
      expect(negative.code).toBe('VALIDATION_FAILED');

      const method = (
        await post('manager', 'expenses', {
          categoryId: salary,
          method: 'barter',
          amount: '10',
        }).expect(400)
      ).body as ErrorBody;
      expect(method).toMatchObject({ code: 'EXPENSE_METHOD_UNKNOWN', field: 'method' });

      // bkash is a method here but not in the rod business.
      await post('manager', 'expenses', {
        categoryId: salary,
        method: 'bkash',
        amount: '10',
      }).expect(201);
      const rodKinds = (await categories('rodManager', rods.slug)).items;
      const rodMethod = (
        await post(
          'rodManager',
          'expenses',
          { categoryId: rodKinds[0]?.id, method: 'bkash', amount: '10' },
          {},
          rods.slug,
        ).expect(400)
      ).body as ErrorBody;
      expect(rodMethod.code).toBe('EXPENSE_METHOD_UNKNOWN');
    });

    it('refuses a date in the future and too far back for staff', async () => {
      const future = (
        await post('manager', 'expenses', {
          categoryId: salary,
          method: 'cash',
          amount: '10',
          expenseDate: addDays(TODAY, 1),
        }).expect(400)
      ).body as ErrorBody;
      expect(future).toMatchObject({ code: 'EXPENSE_DATE_IN_FUTURE', field: 'expenseDate' });

      const old = (
        await post('manager', 'expenses', {
          categoryId: salary,
          method: 'cash',
          amount: '10',
          expenseDate: addDays(TODAY, -30),
        }).expect(400)
      ).body as ErrorBody;
      expect(old).toMatchObject({ code: 'EXPENSE_DATE_TOO_OLD', field: 'expenseDate' });

      // Whoever may correct an expense may also date it further back.
      const backdated = await expense('owner', { expenseDate: addDays(TODAY, -30) });
      expect(backdated.expenseDate).toBe(addDays(TODAY, -30));

      const nonsense = (
        await post('manager', 'expenses', {
          categoryId: salary,
          method: 'cash',
          amount: '10',
          expenseDate: '2026-02-30',
        }).expect(400)
      ).body as ErrorBody;
      expect(nonsense).toMatchObject({ code: 'EXPENSE_DATE_INVALID', field: 'expenseDate' });
    });

    it('lets no salesman record or read expenses', async () => {
      await post('salesman', 'expenses', {
        categoryId: salary,
        method: 'cash',
        amount: '10',
      }).expect(403);
      await get(t.server, path('expenses'), who('salesman')).expect(403);
    });
  });

  describe('reading expenses', () => {
    it('pages the list ten at a time, newest first, and filters', async () => {
      const list = (await get(t.server, path('expenses'), who('manager')).expect(200))
        .body as ListBody<ExpenseBody>;
      expect(list.pageSize).toBe(10);
      expect(list.items.length).toBeLessThanOrEqual(10);
      expect(list.total).toBeGreaterThan(0);

      const byKind = (
        await get(t.server, path(`expenses?categoryId=${rent}`), who('manager')).expect(200)
      ).body as ListBody<ExpenseBody>;
      expect(byKind.items.every((row) => row.category.id === rent)).toBe(true);

      const byMethod = (
        await get(t.server, path('expenses?method=bkash'), who('manager')).expect(200)
      ).body as ListBody<ExpenseBody>;
      expect(byMethod.items.every((row) => row.method === 'bkash')).toBe(true);

      const byDate = (
        await get(
          t.server,
          path(`expenses?from=${addDays(TODAY, -30)}&to=${addDays(TODAY, -30)}`),
          who('manager'),
        ).expect(200)
      ).body as ListBody<ExpenseBody>;
      expect(byDate.items.every((row) => row.expenseDate === addDays(TODAY, -30))).toBe(true);
    });

    it('answers the same for another business’s id and one that does not exist', async () => {
      const mine = await expense('manager');
      const fromOther = (
        await get(t.server, path(`expenses/${mine.id}`, other.slug), who('otherManager')).expect(
          404,
        )
      ).body as ErrorBody;
      const missing = (
        await get(
          t.server,
          path('expenses/0196b1f0-0000-7000-8000-000000000000'),
          who('manager'),
        ).expect(404)
      ).body as ErrorBody;
      expect(fromOther.code).toBe('EXPENSE_NOT_FOUND');
      expect(fromOther.code).toBe(missing.code);
      expect(fromOther.message).toBe(missing.message);
    });

    it('offers only the methods of this business', async () => {
      const mine = (await get(t.server, path('expense-methods'), who('manager')).expect(200))
        .body as { items: string[] };
      expect(mine.items).toEqual(['cash', 'bkash', 'nagad', 'bank', 'cheque']);
      const rodMethods = (
        await get(t.server, path('expense-methods', rods.slug), who('rodManager')).expect(200)
      ).body as { items: string[] };
      expect(rodMethods.items).toEqual(['cash', 'bank']);
    });
  });
});

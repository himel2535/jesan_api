import { describe, expect, it } from 'vitest';
import {
  TenantScopeError,
  assertTenantScoped,
  isTenantModel,
  registerTenantModels,
  scopeTenantArgs,
} from './tenant-scope';

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';

describe('registerTenantModels', () => {
  it('marks only the registered models as business data', () => {
    registerTenantModels(['UnitTestWidget']);
    expect(isTenantModel('UnitTestWidget')).toBe(true);
    expect(isTenantModel('User')).toBe(false);
    expect(isTenantModel(undefined)).toBe(false);
  });
});

describe('assertTenantScoped (the default client)', () => {
  const ok = (operation: string, args: unknown) => {
    expect(() => {
      assertTenantScoped('Widget', operation, args);
    }).not.toThrow();
  };
  const refused = (operation: string, args: unknown) => {
    expect(() => {
      assertTenantScoped('Widget', operation, args);
    }).toThrow(TenantScopeError);
  };

  it('refuses reads, counts, updates and deletes without a businessId', () => {
    for (const operation of [
      'findMany',
      'findFirst',
      'findUnique',
      'count',
      'aggregate',
      'groupBy',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
    ]) {
      refused(operation, {});
      refused(operation, undefined);
      refused(operation, { where: { id: 'x' } });
      refused(operation, { where: { businessId: { in: [A, B] } } }); // must be exactly one business
      ok(operation, { where: { id: 'x', businessId: A } });
    }
  });

  it('refuses creates without a businessId on every row', () => {
    refused('create', { data: { name: 'x' } });
    refused('createMany', { data: [{ businessId: A }, { name: 'x' }] });
    ok('create', { data: { businessId: A } });
    ok('createMany', { data: [{ businessId: A }, { businessId: A }] });
  });

  it('refuses moving a row to another business', () => {
    refused('update', { where: { businessId: A }, data: { businessId: B } });
    refused('upsert', { where: { businessId: A }, create: { businessId: B }, update: {} });
    refused('upsert', {
      where: { businessId: A },
      create: { businessId: A },
      update: { businessId: B },
    });
    ok('upsert', { where: { businessId: A }, create: { businessId: A }, update: {} });
  });
});

describe('scopeTenantArgs (the client for one business)', () => {
  it('adds the business to where clauses, keeping the other filters', () => {
    expect(scopeTenantArgs(A, 'Widget', 'findMany', { where: { isActive: true } })).toEqual({
      where: { isActive: true, businessId: A },
    });
    expect(scopeTenantArgs(A, 'Widget', 'count', undefined)).toEqual({ where: { businessId: A } });
    expect(
      scopeTenantArgs(A, 'Widget', 'update', { where: { id: 'x' }, data: { name: 'y' } }),
    ).toEqual({ where: { id: 'x', businessId: A }, data: { name: 'y' } });
  });

  it('adds the business to created rows, one or many', () => {
    expect(scopeTenantArgs(A, 'Widget', 'create', { data: { name: 'x' } })).toEqual({
      data: { name: 'x', businessId: A },
    });
    expect(scopeTenantArgs(A, 'Widget', 'createMany', { data: [{ n: 1 }, { n: 2 }] })).toEqual({
      data: [
        { n: 1, businessId: A },
        { n: 2, businessId: A },
      ],
    });
    expect(
      scopeTenantArgs(A, 'Widget', 'upsert', { where: { id: 'x' }, create: { n: 1 }, update: {} }),
    ).toEqual({ where: { id: 'x', businessId: A }, create: { n: 1, businessId: A }, update: {} });
  });

  it('refuses any mention of another business', () => {
    expect(() => scopeTenantArgs(A, 'Widget', 'findMany', { where: { businessId: B } })).toThrow(
      TenantScopeError,
    );
    expect(() => scopeTenantArgs(A, 'Widget', 'create', { data: { businessId: B } })).toThrow(
      TenantScopeError,
    );
    expect(() =>
      scopeTenantArgs(A, 'Widget', 'update', { where: { id: 'x' }, data: { businessId: B } }),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeTenantArgs(A, 'Widget', 'upsert', {
        where: {},
        create: {},
        update: { businessId: B },
      }),
    ).toThrow(TenantScopeError);
  });

  it('accepts the same business stated explicitly', () => {
    expect(scopeTenantArgs(A, 'Widget', 'findMany', { where: { businessId: A } })).toEqual({
      where: { businessId: A },
    });
  });
});

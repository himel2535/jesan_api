import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import { TestApp, TestData, createTestApp, runSeed } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

describe.skipIf(!hasDatabase)('business data isolation in the Prisma client', () => {
  let t: TestApp;
  let data: TestData;
  let shopA: { id: string; slug: string };
  let shopB: { id: string; slug: string };
  let categoryA: string;
  let categoryB: string;
  let productB: string;

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shopA = await data.createBusiness('iso-a');
    shopB = await data.createBusiness('iso-b');

    const a = t.prisma.forBusiness(shopA.id);
    const b = t.prisma.forBusiness(shopB.id);
    categoryA = (
      await a.productCategory.create({ data: { businessId: shopA.id, nameEn: 'Cat', nameBn: 'ক' } })
    ).id;
    categoryB = (
      await b.productCategory.create({ data: { businessId: shopB.id, nameEn: 'Cat', nameBn: 'ক' } })
    ).id;
    for (const [client, shop, category, name] of [
      [a, shopA.id, categoryA, 'Same Name'],
      [b, shopB.id, categoryB, 'Same Name'],
      [b, shopB.id, categoryB, 'Only In B'],
    ] as const) {
      await client.product.create({
        data: {
          businessId: shop,
          code: `T-${name}`,
          categoryId: category,
          nameEn: name,
          nameBn: name,
          unitKey: 'bag',
        },
      });
    }
    productB = (await b.product.findFirstOrThrow({ where: { nameEn: 'Only In B' } })).id;
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  it('never returns another business’s rows from a scoped client', async () => {
    const a = t.prisma.forBusiness(shopA.id);
    const rows = await a.product.findMany({ select: { nameEn: true } });
    expect(rows.map((row) => row.nameEn)).toEqual(['Same Name']);
    expect(await a.product.count()).toBe(1);
    expect(await a.product.findUnique({ where: { id: productB } })).toBeNull();
    expect(await a.product.findFirst({ where: { nameEn: 'Only In B' } })).toBeNull();
  });

  it('cannot update another business’s row by id', async () => {
    const a = t.prisma.forBusiness(shopA.id);
    await expect(
      a.product.update({ where: { id: productB }, data: { nameEn: 'hijacked' } }),
    ).rejects.toThrow();
    const result = await a.product.updateMany({
      where: { id: productB },
      data: { nameEn: 'hijacked' },
    });
    expect(result.count).toBe(0);
    const untouched = await t.prisma.forBusiness(shopB.id).product.findUniqueOrThrow({
      where: { id: productB },
    });
    expect(untouched.nameEn).toBe('Only In B');
  });

  it('refuses a query that names another business', async () => {
    const a = t.prisma.forBusiness(shopA.id);
    await expect(a.product.findMany({ where: { businessId: shopB.id } })).rejects.toThrow(
      /Business data isolation/,
    );
    await expect(
      a.productCategory.create({ data: { businessId: shopB.id, nameEn: 'X', nameBn: 'X' } }),
    ).rejects.toThrow(/Business data isolation/);
  });

  it('refuses business-data queries on the default client when the businessId is forgotten', async () => {
    const db = t.prisma.client;
    await expect(db.product.findMany()).rejects.toThrow(/without where.businessId/);
    await expect(db.customer.count()).rejects.toThrow(/without where.businessId/);
    await expect(db.product.findUnique({ where: { id: productB } })).rejects.toThrow(
      /without where.businessId/,
    );
    await expect(
      db.productCategory.create({ data: { nameEn: 'X', nameBn: 'X' } as never }),
    ).rejects.toThrow(/without data.businessId/);
    await expect(db.supplier.updateMany({ data: { isActive: false } })).rejects.toThrow(
      /without where.businessId/,
    );
    // Step 6 tables.
    await expect(db.expense.findMany()).rejects.toThrow(/without where.businessId/);
    await expect(db.expenseCategory.count()).rejects.toThrow(/without where.businessId/);
    await expect(
      db.expenseCategory.create({ data: { nameEn: 'X', nameBn: 'X' } as never }),
    ).rejects.toThrow(/without data.businessId/);
  });

  it('still lets the default client query platform tables and a stated business', async () => {
    expect(await t.prisma.client.role.count()).toBeGreaterThan(0);
    expect(await t.prisma.client.product.count({ where: { businessId: shopB.id } })).toBe(2);
  });

  it('keeps the scope inside transactions', async () => {
    const counted = await t.prisma
      .forBusiness(shopA.id)
      .$transaction(async (tx) => tx.product.count());
    expect(counted).toBe(1);
  });

  it('refuses a product whose category belongs to another business (database foreign key)', async () => {
    const a = t.prisma.forBusiness(shopA.id);
    await expect(
      a.product.create({
        data: {
          businessId: shopA.id,
          code: 'T-cross',
          categoryId: categoryB,
          nameEn: 'Cross',
          nameBn: 'Cross',
          unitKey: 'bag',
        },
      }),
    ).rejects.toThrow();
  });
});

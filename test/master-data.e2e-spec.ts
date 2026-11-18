import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import { TestApp, TestData, createTestApp, get, login, runSeed, send } from './helpers';
import type { Cookies } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

interface ProductBody {
  id: string;
  code: string;
  nameEn: string;
  lastPurchasePrice?: string | null;
  lastPurchasedAt?: string | null;
  isActive: boolean;
  category: { id: string; nameEn: string };
}
interface CustomerBody {
  id: string;
  code: string;
  phone: string;
  openingBalance?: string;
  currentBalance?: string;
  creditLimit?: string | null;
  isActive: boolean;
}
interface PageBody<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0171${String(phoneCounter).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('dealership master data API', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;
  let otherCategoryId: string;

  async function member(name: string, roleKey: string | null, businessIds: string[]) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    for (const businessId of roleKey ? businessIds : []) {
      await data.giveAccess(user.id, businessId, roleKey as string);
    }
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const path = (suffix: string, slug = shop.slug) => `/b/${slug}/${suffix}`;
  const who = (name: string) => as[name] ?? {};

  function createProduct(name: string, overrides: object = {}, as_ = 'manager') {
    const response = send(t.server, 'post', path('products'), who(as_), {
      categoryId,
      nameEn: name,
      nameBn: `${name} বাংলা`,
      ...overrides,
    });
    return response;
  }

  function createCustomer(name: string, overrides: object = {}, as_ = 'manager') {
    return send(t.server, 'post', path('customers'), who(as_), {
      nameEn: name,
      phone: newPhone(),
      ...overrides,
    });
  }

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('md');
    other = await data.createBusiness('md-other');

    await member('owner', null, []);
    await member('ownerRole', 'owner', [shop.id]);
    await member('manager', 'manager', [shop.id]);
    await member('accountant', 'accountant', [shop.id]);
    await member('salesman', 'salesman', [shop.id]);
    await member('otherManager', 'manager', [other.id]);

    categoryId = (
      (
        await send(t.server, 'post', path('product-categories'), who('manager'), {
          nameEn: 'OPC',
          nameBn: 'ওপিসি',
        }).expect(201)
      ).body as { id: string }
    ).id;
    otherCategoryId = (
      (
        await send(t.server, 'post', path('product-categories', other.slug), who('otherManager'), {
          nameEn: 'OPC',
          nameBn: 'ওপিসি',
        }).expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('units and categories', () => {
    it('lists the business’s units from its settings', async () => {
      const response = await get(t.server, path('product-units'), who('salesman')).expect(200);
      expect(response.body).toEqual({
        defaultUnitKey: 'bag',
        items: [{ key: 'bag', nameEn: 'Bag', nameBn: 'বস্তা', decimals: 0 }],
      });
    });

    it('creates categories, refuses a duplicate name in any letter case, and lists them', async () => {
      await send(t.server, 'post', path('product-categories'), who('manager'), {
        nameEn: 'opc',
        nameBn: 'x',
      }).expect(409);
      await send(t.server, 'post', path('product-categories'), who('manager'), {
        nameEn: 'PCC',
        nameBn: 'পিসিসি',
        sortOrder: 2,
      }).expect(201);
      const list = await get(t.server, path('product-categories'), who('salesman')).expect(200);
      expect(
        (list.body as { items: { nameEn: string }[] }).items.map((item) => item.nameEn),
      ).toEqual(['OPC', 'PCC']);
      await send(t.server, 'post', path('product-categories'), who('salesman'), {
        nameEn: 'Z',
        nameBn: 'Z',
      }).expect(403);
    });

    it('lets only the owner level deactivate a category, with a reason', async () => {
      const created = await send(t.server, 'post', path('product-categories'), who('manager'), {
        nameEn: 'Old',
        nameBn: 'পুরনো',
      }).expect(201);
      const id = (created.body as { id: string }).id;
      await send(t.server, 'patch', path(`product-categories/${id}`), who('manager'), {
        isActive: false,
        reason: 'not sold',
      }).expect(403);
      await send(t.server, 'patch', path(`product-categories/${id}`), who('ownerRole'), {
        isActive: false,
      }).expect(400);
      const done = await send(
        t.server,
        'patch',
        path(`product-categories/${id}`),
        who('ownerRole'),
        { isActive: false, reason: 'not sold any more' },
      ).expect(200);
      expect((done.body as { isActive: boolean }).isActive).toBe(false);
      await send(t.server, 'patch', path(`product-categories/${id}`), who('manager'), {
        nameEn: 'Older',
      }).expect(200);
    });
  });

  describe('products', () => {
    it('creates a product with a generated code and the default unit', async () => {
      const response = await createProduct('Sample OPC 50kg').expect(201);
      const body = response.body as ProductBody & { unitKey: string };
      expect(body.code).toMatch(/^P-\d{4}$/);
      expect(body.unitKey).toBe('bag');
      // No purchase yet: no last purchase price.
      expect(body).toMatchObject({ lastPurchasePrice: null, lastPurchasedAt: null });
      expect(body).not.toHaveProperty('purchasePrice');
      expect(body).not.toHaveProperty('defaultSalePrice');
      expect(body.category.nameEn).toBe('OPC');
    });

    it('hides the cost price from anyone without product.cost.view, in lists and details', async () => {
      const created = (await createProduct('Hidden Cost').expect(201)).body as ProductBody;
      const detail = await get(t.server, path(`products/${created.id}`), who('salesman')).expect(
        200,
      );
      expect(detail.body).not.toHaveProperty('lastPurchasePrice');
      expect(detail.body).not.toHaveProperty('lastPurchasedAt');
      expect((detail.body as ProductBody).nameEn).toBe('Hidden Cost');

      // As a confirmed purchase will set it (Step 5a): straight in the database.
      const purchasedAt = new Date('2026-11-18T09:30:00.000Z');
      await t.prisma.forBusiness(shop.id).product.update({
        where: { id: created.id },
        data: { lastPurchasePrice: '545.5', lastPurchasedAt: purchasedAt },
      });
      const list = await get(t.server, path('products?search=Hidden'), who('salesman')).expect(200);
      const item = (list.body as PageBody<ProductBody>).items[0];
      expect(item).not.toHaveProperty('lastPurchasePrice');
      expect(item).not.toHaveProperty('lastPurchasedAt');
      expect(JSON.stringify(list.body)).not.toContain('545.50');
      const forManager = await get(t.server, path(`products/${created.id}`), who('manager')).expect(
        200,
      );
      expect(forManager.body).toMatchObject({
        lastPurchasePrice: '545.50',
        lastPurchasedAt: purchasedAt.toISOString(),
      });
    });

    it('no longer has a permission to edit product prices', async () => {
      const matrix = await get(t.server, path('roles/permissions'), who('owner')).expect(200);
      const keys = (matrix.body as { permissions: { key: string }[] }).permissions.map(
        (permission) => permission.key,
      );
      expect(keys).toContain('product.cost.view');
      expect(keys).not.toContain('product.price.edit');
      const grants = await t.prisma.client.rolePermission.count({
        where: { permissionKey: 'product.price.edit' },
      });
      expect(grants).toBe(0);
    });

    it('validates the input', async () => {
      // The last purchase price is set by purchases only, never typed in.
      await createProduct('Typed Cost', { purchasePrice: '540' }).expect(400);
      await createProduct('Typed Cost 2', { lastPurchasePrice: '540' }).expect(400);
      // Products have no sale price: it is set on each invoice.
      await createProduct('Sale Price', { defaultSalePrice: '560' }).expect(400);
      await createProduct('Bad Unit', { unitKey: 'ton' }).expect(400);
      await createProduct('Other Category', { categoryId: otherCategoryId }).expect(400);
      await createProduct('sample opc 50KG').expect(409); // same name in another case
    });

    it('lets plain edits through for the manager but keeps deactivation for the owner level', async () => {
      const product = (await createProduct('Editable').expect(201)).body as ProductBody;
      const patch = (who_: string, body: object) =>
        send(t.server, 'patch', path(`products/${product.id}`), who(who_), body);

      await patch('manager', { nameEn: 'Editable Renamed' }).expect(200);
      await patch('manager', { isActive: false, reason: 'gone' }).expect(403);
      await patch('ownerRole', { isActive: false }).expect(400); // reason missing
      await patch('owner', { purchasePrice: '545', reason: 'new cost' }).expect(400); // no price here
      await patch('salesman', { nameEn: 'Nope' }).expect(403);

      const deactivated = await patch('owner', { isActive: false, reason: 'not sold' }).expect(200);
      expect((deactivated.body as ProductBody).isActive).toBe(false);
      // Sending the same value again is not a change and needs no permission.
      await patch('manager', { isActive: false, nameEn: 'Editable Again' }).expect(200);
      await patch('manager', {}).expect(400);

      const audit = await t.prisma.client.auditLog.findFirstOrThrow({
        where: { entityId: product.id, action: 'product.updated', actorUserId: { not: null } },
        orderBy: { createdAt: 'desc' },
        skip: 1,
      });
      expect(audit.changes).toMatchObject({
        isActive: { before: true, after: false },
        reason: 'not sold',
      });
    });

    it('searches by English name, Bangla name and code, ten per page', async () => {
      for (let index = 0; index < 12; index += 1) {
        await createProduct(`Paged Item ${String(index).padStart(2, '0')}`).expect(201);
      }
      const first = await get(
        t.server,
        path('products?search=paged%20item'),
        who('salesman'),
      ).expect(200);
      const page = first.body as PageBody<ProductBody>;
      expect(page.items).toHaveLength(10);
      expect(page.total).toBe(12);
      expect(page.items[0]?.nameEn).toBe('Paged Item 00');
      const second = await get(
        t.server,
        path('products?search=paged%20item&page=2'),
        who('salesman'),
      ).expect(200);
      expect((second.body as PageBody<ProductBody>).items).toHaveLength(2);

      const bangla = await get(
        t.server,
        path(`products?search=${encodeURIComponent('Paged Item 05 বাংলা')}`),
        who('salesman'),
      ).expect(200);
      expect((bangla.body as PageBody<ProductBody>).items.map((item) => item.nameEn)).toEqual([
        'Paged Item 05',
      ]);
      const code = (page.items[0] as ProductBody).code;
      const byCode = await get(t.server, path(`products?search=${code}`), who('salesman')).expect(
        200,
      );
      expect((byCode.body as PageBody<ProductBody>).items.map((item) => item.code)).toContain(code);
      await get(t.server, path('products?page=0'), who('salesman')).expect(400);
    });
  });

  describe('customers', () => {
    it('lets a salesman add a customer with name and phone only, and normalizes the phone', async () => {
      const phone = newPhone();
      const response = await createCustomer('Walk-in Shop', { phone }, 'salesman').expect(201);
      const body = response.body as CustomerBody;
      expect(body.code).toMatch(/^C-\d{5}$/);
      expect(body.phone).toBe(`+880${phone.slice(1)}`);
      expect(body).not.toHaveProperty('currentBalance');
      await createCustomer('With Balance', { openingBalance: '100' }, 'salesman').expect(403);
      await createCustomer('Duplicate Phone', { phone: `+880${phone.slice(1)}` }).expect(409);
      await createCustomer('Bad Phone', { phone: '12345' }).expect(400);
    });

    it('stores opening balance (advance allowed) and shows money only with customer.due.view', async () => {
      const created = (
        await createCustomer('Due Shop', {
          openingBalance: '12500.5',
          creditLimit: '50000',
        }).expect(201)
      ).body as CustomerBody;
      expect(created.openingBalance).toBe('12500.50');
      expect(created.currentBalance).toBe('12500.50');
      expect(created.creditLimit).toBe('50000.00');

      const advance = (
        await createCustomer('Advance Shop', { openingBalance: '-2000' }).expect(201)
      ).body as CustomerBody;
      expect(advance.currentBalance).toBe('-2000.00');
      expect(advance.creditLimit).toBeNull();

      const asSalesman = await get(
        t.server,
        path(`customers/${created.id}`),
        who('salesman'),
      ).expect(200);
      for (const field of ['openingBalance', 'currentBalance', 'creditLimit']) {
        expect(asSalesman.body).not.toHaveProperty(field);
      }
      const asAccountant = await get(
        t.server,
        path(`customers/${created.id}`),
        who('accountant'),
      ).expect(200);
      expect((asAccountant.body as CustomerBody).currentBalance).toBe('12500.50');
    });

    it('keeps balance changes and deactivation for the owner level, and moves the current balance with the opening', async () => {
      const customer = (
        await createCustomer('Balance Shop', { openingBalance: '1000' }).expect(201)
      ).body as CustomerBody;
      const patch = (who_: string, body: object) =>
        send(t.server, 'patch', path(`customers/${customer.id}`), who(who_), body);

      await patch('manager', { address: 'Station Road' }).expect(200);
      await patch('manager', { openingBalance: '1500', reason: 'typo' }).expect(403);
      await patch('manager', { creditLimit: '9000', reason: 'trusted' }).expect(403);
      await patch('manager', { isActive: false, reason: 'closed' }).expect(403);
      await patch('ownerRole', { openingBalance: '1500' }).expect(400);

      const fixed = await patch('ownerRole', {
        openingBalance: '1500',
        creditLimit: '9000',
        reason: 'opening balance was mistyped',
      }).expect(200);
      expect((fixed.body as CustomerBody).openingBalance).toBe('1500.00');
      expect((fixed.body as CustomerBody).currentBalance).toBe('1500.00');
      expect((fixed.body as CustomerBody).creditLimit).toBe('9000.00');

      const unlimited = await patch('owner', {
        creditLimit: null,
        reason: 'no limit for this shop',
      }).expect(200);
      expect((unlimited.body as CustomerBody).creditLimit).toBeNull();
      const closed = await patch('owner', { isActive: false, reason: 'shop closed' }).expect(200);
      expect((closed.body as CustomerBody).isActive).toBe(false);

      const active = await get(
        t.server,
        path('customers?search=Balance%20Shop'),
        who('manager'),
      ).expect(200);
      expect((active.body as PageBody<CustomerBody>).total).toBe(0);
      const all = await get(
        t.server,
        path('customers?search=Balance%20Shop&active=all'),
        who('manager'),
      ).expect(200);
      expect((all.body as PageBody<CustomerBody>).total).toBe(1);
    });

    it('finds customers by name, Bangla name, phone (any format) and code', async () => {
      const phone = newPhone();
      const customer = (
        await createCustomer('Rahim Traders', { nameBn: 'রহিম ট্রেডার্স', phone }).expect(201)
      ).body as CustomerBody;
      const search = async (term: string) =>
        (
          (
            await get(
              t.server,
              path(`customers?search=${encodeURIComponent(term)}`),
              who('salesman'),
            ).expect(200)
          ).body as PageBody<CustomerBody>
        ).items.map((item) => item.id);

      expect(await search('rahim')).toContain(customer.id);
      expect(await search('রহিম')).toContain(customer.id);
      expect(await search(phone)).toEqual([customer.id]);
      expect(await search(phone.slice(-6))).toContain(customer.id);
      expect(await search(customer.code)).toEqual([customer.id]);
    });

    it('never repeats a code, even when twenty are created at the same moment', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) => createCustomer(`Parallel ${String(index)}`)),
      );
      const codes = responses.map((response) => (response.body as CustomerBody).code);
      expect(responses.every((response) => response.status === 201)).toBe(true);
      expect(new Set(codes).size).toBe(20);
    });
  });

  describe('suppliers', () => {
    it('lists the principal supplier first, read-only', async () => {
      await t.prisma.forBusiness(shop.id).supplier.create({
        data: {
          businessId: shop.id,
          code: 'S-001',
          nameEn: 'Principal Co',
          nameBn: 'প্রধান কোম্পানি',
          isPrincipal: true,
        },
      });
      const list = await get(t.server, path('suppliers'), who('manager')).expect(200);
      const items = (list.body as PageBody<{ nameEn: string; isPrincipal: boolean; id: string }>)
        .items;
      expect(items[0]).toMatchObject({ nameEn: 'Principal Co', isPrincipal: true });
      await get(t.server, path(`suppliers/${items[0]?.id ?? ''}`), who('manager')).expect(200);
      await get(t.server, path('suppliers'), who('salesman')).expect(403);
    });

    it('allows only one principal supplier per business (database rule)', async () => {
      await expect(
        t.prisma.forBusiness(shop.id).supplier.create({
          data: {
            businessId: shop.id,
            code: 'S-002',
            nameEn: 'Second',
            nameBn: 'দ্বিতীয়',
            isPrincipal: true,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('business isolation through the API', () => {
    it('never shows or changes another business’s master data', async () => {
      const mine = (await createProduct('Mine Only').expect(201)).body as ProductBody;
      const customer = (await createCustomer('Mine Customer').expect(201)).body as CustomerBody;

      // The other business's manager cannot enter this business at all.
      await get(t.server, path('products'), who('otherManager')).expect(403);
      // Through their own business, this business's ids simply do not exist.
      await get(t.server, path(`products/${mine.id}`, other.slug), who('otherManager')).expect(404);
      await get(t.server, path(`customers/${customer.id}`, other.slug), who('otherManager')).expect(
        404,
      );
      await send(t.server, 'patch', path(`products/${mine.id}`, other.slug), who('otherManager'), {
        nameEn: 'Stolen',
      }).expect(404);
      const theirList = await get(
        t.server,
        path('products?search=Mine', other.slug),
        who('otherManager'),
      ).expect(200);
      expect((theirList.body as PageBody<ProductBody>).total).toBe(0);

      // The same names and phone numbers may exist in another business.
      await send(t.server, 'post', path('products', other.slug), who('otherManager'), {
        categoryId: otherCategoryId,
        nameEn: 'Mine Only',
        nameBn: 'x',
      }).expect(201);
      await send(t.server, 'post', path('customers', other.slug), who('otherManager'), {
        nameEn: 'Same Phone',
        phone: customer.phone,
      }).expect(201);
    });

    it('works for a second dealership with other units and prefixes, with no core change', async () => {
      const rods = await data.createBusiness('rods', {
        units: [
          { key: 'kg', nameEn: 'Kilogram', nameBn: 'কেজি', decimals: 3 },
          { key: 'ton', nameEn: 'Ton', nameBn: 'টন', decimals: 3 },
        ],
        defaultUnit: 'ton',
        codePrefixes: { product: 'R', customer: 'RC', supplier: 'RS' },
      });
      const category = (
        (
          await send(t.server, 'post', path('product-categories', rods.slug), who('owner'), {
            nameEn: '10mm',
            nameBn: '১০ মিমি',
          }).expect(201)
        ).body as { id: string }
      ).id;
      const rod = await send(t.server, 'post', path('products', rods.slug), who('owner'), {
        categoryId: category,
        nameEn: 'Rod 10mm',
        nameBn: 'রড ১০ মিমি',
      }).expect(201);
      expect(rod.body).toMatchObject({ code: 'R-0001', unitKey: 'ton' });
      await send(t.server, 'post', path('products', rods.slug), who('owner'), {
        categoryId: category,
        nameEn: 'Rod by bag',
        nameBn: 'x',
        unitKey: 'bag',
      }).expect(400);
      const buyer = await send(t.server, 'post', path('customers', rods.slug), who('owner'), {
        nameEn: 'Rod Buyer',
        phone: newPhone(),
      }).expect(201);
      expect((buyer.body as CustomerBody).code).toBe('RC-00001');
    });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import { SampleController } from './sample.controller';
import { TestApp, TestData, createTestApp, get, login, runSeed, send } from './helpers';
import type { Cookies } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

const OWNER_ONLY = [
  'commission.view',
  'commission.manage',
  'profit.view',
  'settings.manage',
  'users.manage',
  'roles.manage',
  'audit.view',
];

interface MeBody {
  businesses: { slug: string; role: { key: string }; permissions: string[] }[];
}

describe.skipIf(!hasDatabase)('business access and permissions', () => {
  let t: TestApp;
  let data: TestData;
  let shopA: { id: string; slug: string };
  let shopB: { id: string; slug: string };
  const sessions: Record<string, Cookies> = {};

  async function signInAs(name: string, roleKey: string | null, businesses: string[]) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) {
      for (const businessId of businesses) {
        await data.giveAccess(user.id, businessId, roleKey);
      }
    }
    const session = await login(t.server, user.email ?? '', user.password);
    sessions[name] = session.cookies;
    return user;
  }

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp([SampleController]);
    data = new TestData(t);
    shopA = await data.createBusiness('a');
    shopB = await data.createBusiness('b');

    await signInAs('managerA', 'manager', [shopA.id]);
    await signInAs('managerB', 'manager', [shopB.id]);
    await signInAs('salesmanA', 'salesman', [shopA.id]);
    await signInAs('accountantA', 'accountant', [shopA.id]);
    await signInAs('ownerRoleA', 'owner', [shopA.id]);
    await signInAs('platformOwner', null, []);
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  const as = (who: string) => sessions[who] ?? {};
  const permissionsOf = async (who: string, slug: string): Promise<string[]> => {
    const response = await get(t.server, '/auth/me', as(who)).expect(200);
    const business = (response.body as MeBody).businesses.find((entry) => entry.slug === slug);
    return business?.permissions ?? [];
  };

  describe('business isolation', () => {
    it('lets a manager into their own business only', async () => {
      await get(t.server, `/b/${shopA.slug}/sample/stock`, as('managerA')).expect(200);
      await get(t.server, `/b/${shopB.slug}/sample/stock`, as('managerA')).expect(403);
      await get(t.server, `/b/${shopB.slug}/sample/stock`, as('managerB')).expect(200);
      await get(t.server, `/b/${shopA.slug}/sample/stock`, as('managerB')).expect(403);
    });

    it('answers an unknown business exactly like a business the user may not enter', async () => {
      const forbidden = await get(t.server, `/b/${shopB.slug}/sample/stock`, as('managerA'));
      const unknown = await get(t.server, '/b/no-such-shop/sample/stock', as('managerA'));
      expect(unknown.status).toBe(403);
      expect(unknown.body).toEqual(forbidden.body);
    });

    it('lets the platform owner into every business without any membership row', async () => {
      await get(t.server, `/b/${shopA.slug}/sample/stock`, as('platformOwner')).expect(200);
      await get(t.server, `/b/${shopB.slug}/sample/stock`, as('platformOwner')).expect(200);
      const me = await get(t.server, '/auth/me', as('platformOwner')).expect(200);
      const slugs = (me.body as MeBody).businesses.map((entry) => entry.slug);
      expect(slugs).toEqual(expect.arrayContaining([shopA.slug, shopB.slug, 'akij-cement']));
    });

    it('lists only the businesses a user belongs to in /auth/me', async () => {
      const me = await get(t.server, '/auth/me', as('managerA')).expect(200);
      expect((me.body as MeBody).businesses.map((entry) => entry.slug)).toEqual([shopA.slug]);
    });

    it('closes a deactivated business to everyone but still lists it for no one', async () => {
      const shop = await data.createBusiness('closing');
      const user = await signInAs('closingManager', 'manager', [shop.id]);
      await get(t.server, `/b/${shop.slug}/sample/stock`, as('closingManager')).expect(200);

      await t.prisma.client.business.update({ where: { id: shop.id }, data: { isActive: false } });
      t.resolver.clear();
      await get(t.server, `/b/${shop.slug}/sample/stock`, as('closingManager')).expect(403);
      await get(t.server, `/b/${shop.slug}/sample/stock`, as('platformOwner')).expect(403);
      expect(user.id).toBeTruthy();
    });
  });

  describe('permissions are checked on the server', () => {
    it('refuses a business route that states no permission, for everybody', async () => {
      for (const who of ['managerA', 'ownerRoleA', 'platformOwner']) {
        await get(t.server, `/b/${shopA.slug}/sample/forgotten`, as(who)).expect(403);
      }
    });

    it('lets any member through a route marked for any member, and nobody else', async () => {
      await get(t.server, `/b/${shopA.slug}/sample/members`, as('salesmanA')).expect(200);
      await get(t.server, `/b/${shopA.slug}/sample/members`, as('managerB')).expect(403);
    });

    it('gives each role its default permissions', async () => {
      const manager = await permissionsOf('managerA', shopA.slug);
      expect(manager).toEqual(
        expect.arrayContaining([
          'stock.view',
          'purchase.create',
          'sale.create',
          'customer.due.view',
          'collection.create',
          'product.cost.view',
        ]),
      );
      expect(manager).not.toContain('summary.finance.view');
      expect(manager).not.toContain('reports.finance.view');

      const salesman = await permissionsOf('salesmanA', shopA.slug);
      expect(salesman).toEqual(
        expect.arrayContaining(['sale.create', 'customer.view', 'stock.view', 'sale.view.own']),
      );
      // A salesman sees stock quantities but never cost prices or money summaries.
      for (const key of [
        'product.cost.view',
        'purchase.create',
        'summary.finance.view',
        'ledger.view',
      ]) {
        expect(salesman).not.toContain(key);
      }

      const accountant = await permissionsOf('accountantA', shopA.slug);
      expect(accountant).toEqual(
        expect.arrayContaining([
          'ledger.view',
          'ledger.entry.create',
          'payment.create',
          'expense.create',
        ]),
      );
      expect(accountant).not.toContain('stock.view');
      expect(accountant).not.toContain('reports.finance.view');
    });

    it('keeps every owner-only permission away from manager, accountant and salesman', async () => {
      for (const who of ['managerA', 'accountantA', 'salesmanA']) {
        const held = await permissionsOf(who, shopA.slug);
        for (const key of OWNER_ONLY) {
          expect(held, `${who} must not hold ${key}`).not.toContain(key);
        }
      }
    });
  });

  describe('platform owner versus the owner role of a business', () => {
    it('gives the platform owner every permission, owner-only ones included', async () => {
      const held = await permissionsOf('platformOwner', shopA.slug);
      for (const key of OWNER_ONLY) {
        expect(held).toContain(key);
      }
      const applicable = t.registry.applicableTo('dealership').map((permission) => permission.key);
      expect([...held].sort()).toEqual([...applicable].sort());
    });

    it('gives the owner role every permission except the owner-only ones', async () => {
      const held = await permissionsOf('ownerRoleA', shopA.slug);
      for (const key of OWNER_ONLY) {
        expect(held, `the owner role must not hold ${key}`).not.toContain(key);
      }
      expect(held).toEqual(
        expect.arrayContaining([
          'sale.void',
          'purchase.void',
          'summary.finance.view',
          'reports.finance.view',
        ]),
      );
      const expected = t.registry
        .applicableTo('dealership')
        .filter((permission) => !permission.ownerOnly)
        .map((permission) => permission.key);
      expect([...held].sort()).toEqual([...expected].sort());
    });

    it('lets only the platform owner reach commission, and only it manage settings and users', async () => {
      const commission = `/b/${shopA.slug}/sample/commission`;
      await get(t.server, commission, as('platformOwner')).expect(200);
      for (const who of ['ownerRoleA', 'managerA', 'accountantA', 'salesmanA']) {
        await get(t.server, commission, as(who)).expect(403);
      }

      // The owner role is shut out of the management API too.
      await get(t.server, `/b/${shopA.slug}/roles/permissions`, as('ownerRoleA')).expect(403);
      await send(t.server, 'post', `/b/${shopA.slug}/users`, as('ownerRoleA'), {
        name: 'X',
        email: 'x@example.test',
        password: 'a-long-enough-password',
        roleKey: 'manager',
      }).expect(403);
      await get(t.server, `/b/${shopA.slug}/roles/permissions`, as('platformOwner')).expect(200);
    });
  });

  describe('hiding money fields on the server', () => {
    const stockOf = async (who: string) => {
      const response = await get(t.server, `/b/${shopA.slug}/sample/stock`, as(who)).expect(200);
      return response.body as {
        items: Record<string, unknown>[];
        totalMargin?: number;
      } & Record<string, unknown>;
    };

    it('sends a salesman the quantity and nothing about cost or margin', async () => {
      const body = await stockOf('salesmanA');
      expect(body).toEqual({
        items: [
          { productName: 'OPC', quantity: 120 },
          { productName: 'PCC', quantity: 80 },
        ],
      });
    });

    it('sends a manager the cost but not the margin', async () => {
      const body = await stockOf('managerA');
      expect(body.items[0]).toEqual({ productName: 'OPC', quantity: 120, unitCost: 570 });
      expect(body).not.toHaveProperty('totalMargin');
    });

    it('sends the platform owner everything declared, and still nothing undeclared', async () => {
      const body = await stockOf('platformOwner');
      expect(body.items[0]).toEqual({
        productName: 'OPC',
        quantity: 120,
        unitCost: 570,
        margin: 30,
      });
      expect(body.totalMargin).toBe(5000);
      expect(JSON.stringify(body)).not.toContain('hidden');
      expect(body).not.toHaveProperty('supplierSecret');
    });
  });

  describe('owner-only permissions cannot be granted, even directly in the database', () => {
    it('rejects an owner-only grant written as owner-only', async () => {
      const role = await t.prisma.client.role.findUniqueOrThrow({ where: { key: 'manager' } });
      await expect(
        t.prisma.client.$executeRaw`
          INSERT INTO role_permissions (business_id, role_id, permission_key, permission_owner_only)
          VALUES (${shopA.id}::uuid, ${role.id}::uuid, 'commission.view', true)`,
      ).rejects.toThrow(/role_permissions_not_owner_only_check/);
    });

    it('rejects an owner-only grant that pretends not to be owner-only', async () => {
      const role = await t.prisma.client.role.findUniqueOrThrow({ where: { key: 'manager' } });
      await expect(
        t.prisma.client.$executeRaw`
          INSERT INTO role_permissions (business_id, role_id, permission_key, permission_owner_only)
          VALUES (${shopA.id}::uuid, ${role.id}::uuid, 'profit.view', false)`,
      ).rejects.toThrow(/foreign key/i);
    });

    it('refuses it through the API as well', async () => {
      for (const key of OWNER_ONLY) {
        const response = await send(
          t.server,
          'put',
          `/b/${shopA.slug}/roles/manager/permissions`,
          as('platformOwner'),
          { permissions: ['stock.view', key] },
        );
        expect(response.status, key).toBe(400);
      }
      const held = await permissionsOf('managerA', shopA.slug);
      expect(held).not.toContain('commission.view');
    });
  });

  describe('permission declarations and defaults', () => {
    it('mirrors every declared permission into the database with the right owner-only flag', async () => {
      const rows = await t.prisma.client.permission.findMany();
      const byKey = new Map(rows.map((row) => [row.key, row]));
      for (const declared of t.registry.all()) {
        const row = byKey.get(declared.key);
        expect(row, declared.key).toBeDefined();
        expect(row?.ownerOnly).toBe(declared.ownerOnly);
        expect(row?.isActive).toBe(true);
      }
      expect(
        rows
          .filter((row) => row.ownerOnly)
          .map((row) => row.key)
          .sort(),
      ).toEqual([...OWNER_ONLY].sort());
    });

    it('never overwrites the owner’s changes when it syncs again', async () => {
      const shop = await data.createBusiness('sync');
      await send(
        t.server,
        'put',
        `/b/${shop.slug}/roles/manager/permissions`,
        as('platformOwner'),
        { permissions: ['stock.view'] },
      ).expect(200);

      await t.sync.sync();
      await t.sync.sync();

      const rows = await t.prisma.client.rolePermission.findMany({
        where: { businessId: shop.id, role: { key: 'manager' } },
        select: { permissionKey: true },
      });
      expect(rows.map((row) => row.permissionKey)).toEqual(['stock.view']);
    });

    it('gives a business with no grants at all the default grants on the next sync', async () => {
      const shop = await data.createBusiness('fresh');
      await t.prisma.client.rolePermission.deleteMany({ where: { businessId: shop.id } });
      await t.sync.sync();
      const count = await t.prisma.client.rolePermission.count({ where: { businessId: shop.id } });
      expect(count).toBeGreaterThan(10);
    });
  });
});

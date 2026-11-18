import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from './database';
import { SampleController } from './sample.controller';
import {
  TEST_PASSWORD,
  TestApp,
  TestData,
  createTestApp,
  get,
  login,
  runSeed,
  send,
  uniqueTag,
} from './helpers';
import type { Cookies } from './helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

interface Matrix {
  permissions: { key: string; ownerOnly: boolean }[];
  roles: { key: string; locked: boolean; permissions: string[] }[];
}

describe.skipIf(!hasDatabase)('Settings: users, roles and permissions', () => {
  let t: TestApp;
  let data: TestData;
  let shopA: { id: string; slug: string };
  let shopB: { id: string; slug: string };
  let owner: Cookies;
  let manager: Cookies;
  let ownerId: string;

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp([SampleController]);
    data = new TestData(t);
    shopA = await data.createBusiness('a');
    shopB = await data.createBusiness('b');

    const platformOwner = await data.createUser({ name: 'Boss', isPlatformOwner: true });
    ownerId = platformOwner.id;
    owner = (await login(t.server, platformOwner.email ?? '', platformOwner.password)).cookies;

    const managerUser = await data.createUser({ name: 'Manager' });
    await data.giveAccess(managerUser.id, shopA.id, 'manager');
    manager = (await login(t.server, managerUser.email ?? '', managerUser.password)).cookies;
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  const newEmail = () => `staff-${uniqueTag()}@example.test`;
  const createStaff = async (roleKey: string, slug = shopA.slug) => {
    const email = newEmail();
    const response = await send(t.server, 'post', `/b/${slug}/users`, owner, {
      name: 'Staff',
      email,
      password: TEST_PASSWORD,
      roleKey,
    }).expect(201);
    const id = (response.body as { id: string }).id;
    data.userIds.push(id);
    return { id, email };
  };

  describe('role permissions', () => {
    it('shows the platform owner the full table, with the owner role locked', async () => {
      const response = await get(t.server, `/b/${shopA.slug}/roles/permissions`, owner).expect(200);
      const matrix = response.body as Matrix;
      expect(matrix.roles.map((role) => role.key)).toEqual([
        'owner',
        'manager',
        'accountant',
        'salesman',
      ]);
      const ownerRole = matrix.roles.find((role) => role.key === 'owner');
      expect(ownerRole?.locked).toBe(true);
      expect(ownerRole?.permissions).not.toContain('commission.view');
      expect(ownerRole?.permissions).toContain('sale.void');
      expect(matrix.permissions.filter((entry) => entry.ownerOnly)).toHaveLength(7);
    });

    it('keeps it from everyone else', async () => {
      await get(t.server, `/b/${shopA.slug}/roles/permissions`, manager).expect(403);
      await send(t.server, 'put', `/b/${shopA.slug}/roles/manager/permissions`, manager, {
        permissions: [],
      }).expect(403);
      await request401(`/b/${shopA.slug}/roles/permissions`);
    });

    const request401 = async (path: string) => {
      const { default: supertest } = await import('supertest');
      await supertest(t.server).get(`/api/v1${path}`).expect(401);
    };

    it('changes a role’s permissions, records the change, and takes effect immediately', async () => {
      const salesmanUser = await data.createUser({ name: 'Salesman' });
      await data.giveAccess(salesmanUser.id, shopA.id, 'salesman');
      const salesman = (await login(t.server, salesmanUser.email ?? '', salesmanUser.password))
        .cookies;
      const stockLine = async () => {
        const response = await get(t.server, `/b/${shopA.slug}/sample/stock`, salesman).expect(200);
        return (response.body as { items: Record<string, unknown>[] }).items[0];
      };

      // Priming the cache first proves the change does not wait for it to expire.
      expect(await stockLine()).not.toHaveProperty('unitCost');

      const response = await send(
        t.server,
        'put',
        `/b/${shopA.slug}/roles/salesman/permissions`,
        owner,
        { permissions: ['stock.view', 'sale.create', 'product.cost.view'] },
      ).expect(200);
      const diff = response.body as { added: string[]; removed: string[] };
      expect(diff.added).toEqual(['product.cost.view']);
      expect(diff.removed).toEqual(expect.arrayContaining(['customer.view', 'product.view']));

      expect(await stockLine()).toHaveProperty('unitCost', 570);

      const logged = await t.prisma.client.auditLog.findFirstOrThrow({
        where: { businessId: shopA.id, action: 'role_permissions.updated' },
        orderBy: { createdAt: 'desc' },
      });
      expect(logged.actorUserId).toBe(ownerId);
      expect(logged.changes).toMatchObject({ role: 'salesman', added: ['product.cost.view'] });
    });

    it('does not touch another business', async () => {
      const response = await get(t.server, `/b/${shopB.slug}/roles/permissions`, owner).expect(200);
      const salesman = (response.body as Matrix).roles.find((role) => role.key === 'salesman');
      expect(salesman?.permissions).toContain('product.view');
      expect(salesman?.permissions).not.toContain('product.cost.view');
    });

    it('rejects the owner role, unknown roles, unknown permissions and owner-only permissions', async () => {
      const put = (roleKey: string, permissions: string[]) =>
        send(t.server, 'put', `/b/${shopA.slug}/roles/${roleKey}/permissions`, owner, {
          permissions,
        });
      await put('owner', ['stock.view']).expect(400);
      await put('no_such_role', ['stock.view']).expect(404);
      await put('manager', ['no.such.permission']).expect(400);
      await put('manager', ['commission.view']).expect(400);
      await put('manager', ['profit.view']).expect(400);
      await put('manager', ['settings.manage']).expect(400);
      await send(t.server, 'put', `/b/${shopA.slug}/roles/manager/permissions`, owner, {
        permissions: 'stock.view',
      }).expect(400);
    });
  });

  describe('users', () => {
    it('creates a user who can then sign in with the role and permissions given', async () => {
      const staff = await createStaff('accountant');
      const session = await login(t.server, staff.email, TEST_PASSWORD);
      expect(session.status).toBe(200);
      const me = await get(t.server, '/auth/me', session.cookies).expect(200);
      const business = (
        me.body as { businesses: { slug: string; role: { key: string }; permissions: string[] }[] }
      ).businesses[0];
      expect(business?.slug).toBe(shopA.slug);
      expect(business?.role.key).toBe('accountant');
      expect(business?.permissions).toContain('ledger.view');

      const logged = await t.prisma.client.auditLog.findFirstOrThrow({
        where: { entityId: staff.id, action: 'user.created' },
      });
      expect(JSON.stringify(logged)).not.toContain(TEST_PASSWORD);
    });

    it('stores a phone number in its international form', async () => {
      const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
      const response = await send(t.server, 'post', `/b/${shopA.slug}/users`, owner, {
        name: 'Phone Staff',
        phone: `01${digits}`,
        password: TEST_PASSWORD,
        roleKey: 'salesman',
      }).expect(201);
      data.userIds.push((response.body as { id: string }).id);
      expect((await login(t.server, `+8801${digits}`, TEST_PASSWORD)).status).toBe(200);
    });

    it('validates what it is given', async () => {
      const post = (body: object) => send(t.server, 'post', `/b/${shopA.slug}/users`, owner, body);
      const valid = {
        name: 'Staff',
        email: newEmail(),
        password: TEST_PASSWORD,
        roleKey: 'manager',
      };

      await post({ ...valid, password: 'short' }).expect(400);
      await post({ ...valid, roleKey: 'nobody' }).expect(400);
      await post({ ...valid, email: undefined }).expect(400); // neither email nor phone
      await post({ ...valid, email: 'not-an-email' }).expect(400);
      await post({ ...valid, phone: '12', email: undefined }).expect(400);
      await post({ ...valid, password: valid.email }).expect(400);
      await post({ ...valid, isPlatformOwner: true }).expect(400); // cannot be set through the API
    });

    it('refuses a duplicate email', async () => {
      const staff = await createStaff('manager');
      await send(t.server, 'post', `/b/${shopA.slug}/users`, owner, {
        name: 'Copy',
        email: staff.email.toUpperCase(),
        password: TEST_PASSWORD,
        roleKey: 'manager',
      }).expect(409);
    });

    it('lets a manager see the list but not change anything', async () => {
      await get(t.server, `/b/${shopA.slug}/users`, manager).expect(200);
      await send(t.server, 'post', `/b/${shopA.slug}/users`, manager, {
        name: 'X',
        email: newEmail(),
        password: TEST_PASSWORD,
        roleKey: 'manager',
      }).expect(403);
    });

    it('lists ten per page with a total, never showing password data', async () => {
      const shop = await data.createBusiness('paged');
      for (let index = 0; index < 12; index += 1) {
        await createStaff('salesman', shop.slug);
      }
      const first = await get(t.server, `/b/${shop.slug}/users`, owner).expect(200);
      const second = await get(t.server, `/b/${shop.slug}/users?page=2`, owner).expect(200);
      const body = first.body as { items: { id: string }[]; total: number; pageSize: number };

      expect(body.items).toHaveLength(10);
      expect(body.pageSize).toBe(10);
      expect(body.total).toBe(12);
      expect((second.body as { items: unknown[] }).items).toHaveLength(2);
      expect(JSON.stringify(first.body)).not.toMatch(/password/i);
      await get(t.server, `/b/${shop.slug}/users?page=0`, owner).expect(400);
    });

    it('shows every listed user with isPlatformOwner, leaves platform owners out, and allows the owner role', async () => {
      const shop = await data.createBusiness('listing');
      const staff = await createStaff('owner', shop.slug);
      const response = await get(t.server, `/b/${shop.slug}/users`, owner).expect(200);
      const items = (response.body as { items: Record<string, unknown>[] }).items;

      expect(items).toHaveLength(1);
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        [
          'email',
          'id',
          'isActive',
          'isPlatformOwner',
          'lastLoginAt',
          'name',
          'phone',
          'role',
        ].sort(),
      );
      expect(items[0]).toMatchObject({
        id: staff.id,
        role: 'owner',
        isPlatformOwner: false,
        lastLoginAt: null,
      });
      // The platform owner enters every business without a membership row, so is not listed.
      expect(items.map((item) => item.id)).not.toContain(ownerId);
    });

    it('does not reveal the existing user id in a duplicate (409) answer', async () => {
      const staff = await createStaff('manager');
      const duplicate = await send(t.server, 'post', `/b/${shopA.slug}/users`, owner, {
        name: 'Copy',
        email: staff.email,
        password: TEST_PASSWORD,
        roleKey: 'manager',
      }).expect(409);
      expect(JSON.stringify(duplicate.body)).not.toContain(staff.id);
      expect(Object.keys(duplicate.body as object).sort()).toEqual([
        'code',
        'error',
        'message',
        'statusCode',
      ]);
      expect((duplicate.body as { code: string }).code).toBe('USER_ALREADY_EXISTS');
    });

    it('grants an existing user access to another business, and changes or removes it at once', async () => {
      const staff = await createStaff('manager');
      const session = (await login(t.server, staff.email, TEST_PASSWORD)).cookies;
      const stock = (slug: string) => get(t.server, `/b/${slug}/sample/stock`, session);

      await stock(shopA.slug).expect(200);
      await stock(shopB.slug).expect(403);

      await send(t.server, 'post', `/b/${shopB.slug}/users/${staff.id}/access`, owner, {
        roleKey: 'salesman',
      }).expect(200);
      await stock(shopB.slug).expect(200);

      await send(t.server, 'patch', `/b/${shopB.slug}/users/${staff.id}/role`, owner, {
        roleKey: 'accountant',
      }).expect(200);
      await stock(shopB.slug).expect(403); // accountants have no stock.view

      await send(t.server, 'delete', `/b/${shopA.slug}/users/${staff.id}/access`, owner).expect(
        204,
      );
      await stock(shopA.slug).expect(403);
      expect(await t.prisma.client.user.count({ where: { id: staff.id } })).toBe(1);
    });

    it('rejects a malformed user id, an unknown user and a user of another business', async () => {
      const staff = await createStaff('manager');
      await send(t.server, 'delete', `/b/${shopA.slug}/users/not-a-uuid/access`, owner).expect(400);
      await send(
        t.server,
        'delete',
        `/b/${shopA.slug}/users/00000000-0000-7000-8000-000000000000/access`,
        owner,
      ).expect(404);
      await send(t.server, 'patch', `/b/${shopB.slug}/users/${staff.id}/status`, owner, {
        isActive: false,
      }).expect(404);
    });

    it('leaves platform owner accounts alone', async () => {
      await send(t.server, 'patch', `/b/${shopA.slug}/users/${ownerId}/status`, owner, {
        isActive: false,
      }).expect(400);
      await send(t.server, 'post', `/b/${shopA.slug}/users/${ownerId}/reset-password`, owner, {
        newPassword: 'another-long-password',
      }).expect(400);
      await send(t.server, 'post', `/b/${shopA.slug}/users/${ownerId}/access`, owner, {
        roleKey: 'manager',
      }).expect(400);
    });
  });

  describe('looking up an existing user', () => {
    const lookup = (cookies: Cookies, identifier: string, slug = shopA.slug) =>
      send(t.server, 'post', `/b/${slug}/users/lookup`, cookies, { identifier });

    it('finds a user by email in any case, and says whether they already work here', async () => {
      const staff = await createStaff('accountant');
      const here = await lookup(owner, staff.email.toUpperCase()).expect(200);
      expect(here.body).toEqual({
        id: staff.id,
        name: 'Staff',
        isActive: true,
        isPlatformOwner: false,
        hasAccess: true,
        role: 'accountant',
      });
      // Nothing beyond what adding them needs: no email, phone or other businesses.
      expect(JSON.stringify(here.body)).not.toContain(staff.email);

      const elsewhere = await lookup(owner, staff.email, shopB.slug).expect(200);
      expect(elsewhere.body).toMatchObject({ id: staff.id, hasAccess: false, role: null });
    });

    it('finds a user by phone written either way', async () => {
      const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
      const created = await send(t.server, 'post', `/b/${shopA.slug}/users`, owner, {
        name: 'Phone Person',
        phone: `+8801${digits}`,
        password: TEST_PASSWORD,
        roleKey: 'salesman',
      }).expect(201);
      const id = (created.body as { id: string }).id;
      data.userIds.push(id);

      const found = await lookup(owner, `01${digits}`).expect(200);
      expect(found.body).toMatchObject({ id, hasAccess: true, role: 'salesman' });
      expect(JSON.stringify(found.body)).not.toContain(digits);
    });

    it('marks a platform owner as having access everywhere', async () => {
      const boss = await data.createUser({ isPlatformOwner: true });
      const found = await lookup(owner, boss.email ?? '').expect(200);
      expect(found.body).toMatchObject({
        id: boss.id,
        isPlatformOwner: true,
        hasAccess: true,
        role: null,
      });
    });

    it('answers 404 for an unknown email or phone, or something that is neither', async () => {
      for (const identifier of [newEmail(), '01999999999', 'not an identifier']) {
        const response = await lookup(owner, identifier).expect(404);
        expect(response.body).toMatchObject({ message: 'User not found' });
      }
      await lookup(owner, '').expect(400);
    });

    it('is only for the platform owner', async () => {
      const staff = await createStaff('manager');
      const ownerRoleUser = await data.createUser();
      await data.giveAccess(ownerRoleUser.id, shopA.id, 'owner');
      const ownerRole = (await login(t.server, ownerRoleUser.email ?? '', ownerRoleUser.password))
        .cookies;

      await lookup(manager, staff.email).expect(403);
      await lookup(ownerRole, staff.email).expect(403);
    });

    it('audits every lookup without storing the searched email', async () => {
      const staff = await createStaff('manager');
      const unknown = newEmail();
      await lookup(owner, staff.email).expect(200);
      await lookup(owner, unknown).expect(404);

      const rows = await t.prisma.client.auditLog.findMany({
        where: { actorUserId: ownerId, action: 'user.lookup', businessId: shopA.id },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      expect(rows.map((row) => row.changes)).toEqual([
        { by: 'email', found: false },
        { by: 'email', found: true },
      ]);
      expect(rows[1]?.entityId).toBe(staff.id);
      expect(JSON.stringify(rows)).not.toContain(unknown);
      expect(JSON.stringify(rows)).not.toContain(staff.email);
    });

    it('stops a user after 20 lookups a minute (429), counted per user', async () => {
      const boss = await data.createUser({ isPlatformOwner: true });
      const cookies = (await login(t.server, boss.email ?? '', boss.password)).cookies;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 21; attempt += 1) {
        statuses.push((await lookup(cookies, newEmail())).status);
      }
      expect(statuses.slice(0, 20).every((status) => status === 404)).toBe(true);
      expect(statuses[20]).toBe(429);
      // Another user is not affected.
      await lookup(owner, newEmail()).expect(404);
    });
  });

  describe('deactivating and resetting passwords', () => {
    it('signs a deactivated user out at once and keeps them out until reactivated', async () => {
      const staff = await createStaff('manager');
      const session = (await login(t.server, staff.email, TEST_PASSWORD)).cookies;
      await get(t.server, `/b/${shopA.slug}/sample/stock`, session).expect(200);

      await send(t.server, 'patch', `/b/${shopA.slug}/users/${staff.id}/status`, owner, {
        isActive: false,
      }).expect(204);
      await get(t.server, '/auth/me', session).expect(401);
      await get(t.server, `/b/${shopA.slug}/sample/stock`, session).expect(401);
      expect((await login(t.server, staff.email, TEST_PASSWORD)).status).toBe(401);

      await send(t.server, 'patch', `/b/${shopA.slug}/users/${staff.id}/status`, owner, {
        isActive: true,
      }).expect(204);
      expect((await login(t.server, staff.email, TEST_PASSWORD)).status).toBe(200);
    });

    it('refuses to let anyone deactivate themselves', async () => {
      await send(t.server, 'patch', `/b/${shopA.slug}/users/${ownerId}/status`, owner, {
        isActive: false,
      }).expect(400);
    });

    it('resets a password: signs the user out everywhere and lifts a lock', async () => {
      const staff = await createStaff('manager');
      const session = (await login(t.server, staff.email, TEST_PASSWORD)).cookies;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(t.server, staff.email, 'wrong-password-123');
      }
      expect((await login(t.server, staff.email, TEST_PASSWORD)).status).toBe(401); // locked

      const newPassword = `${TEST_PASSWORD}-reset`;
      await send(t.server, 'post', `/b/${shopA.slug}/users/${staff.id}/reset-password`, owner, {
        newPassword,
      }).expect(204);

      await get(t.server, '/auth/me', session).expect(401);
      expect((await login(t.server, staff.email, TEST_PASSWORD)).status).toBe(401);
      expect((await login(t.server, staff.email, newPassword)).status).toBe(200);

      const logged = await t.prisma.client.auditLog.findMany({ where: { entityId: staff.id } });
      expect(logged.map((entry) => entry.action)).toContain('user.password_reset');
      expect(JSON.stringify(logged)).not.toContain(newPassword);
      expect(JSON.stringify(logged)).not.toMatch(/\$argon2/);
    });

    it('applies the password rules to a reset too', async () => {
      const staff = await createStaff('manager');
      await send(t.server, 'post', `/b/${shopA.slug}/users/${staff.id}/reset-password`, owner, {
        newPassword: 'short',
      }).expect(400);
      await send(t.server, 'post', `/b/${shopA.slug}/users/${staff.id}/reset-password`, owner, {
        newPassword: staff.email,
      }).expect(400);
    });
  });
});

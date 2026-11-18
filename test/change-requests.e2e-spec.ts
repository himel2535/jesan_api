import { InternalServerErrorException } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChangeHandler, ChangeValues } from '../src/core/approvals/change-handler';
import { ChangeHandlerRegistry } from '../src/core/approvals/change-handler.registry';
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

interface RequestBody {
  id: string;
  status: string;
  summary: string;
  entityLabel: string;
  snapshot?: ChangeValues;
  proposedChange?: ChangeValues | null;
  impact?:
    { key: string; before?: unknown; after?: unknown; delta?: string; note?: string }[] | null;
  isStale?: boolean;
  decisionNote?: string | null;
}

let phone = Math.floor(Math.random() * 1e6);
const nextPhone = () => {
  phone += 1;
  return `0172${String(phone).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('change requests (maker-checker)', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;

  async function member(name: string, roleKey: string | null, businessId?: string) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey && businessId) {
      await data.giveAccess(user.id, businessId, roleKey);
    }
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
    return user.id;
  }
  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string, slug = shop.slug) => `/b/${slug}/${suffix}`;

  const newProduct = async () => {
    const response = await send(t.server, 'post', path('products'), who('owner'), {
      categoryId,
      nameEn: `Product ${String(Math.random()).slice(2, 10)}`,
      nameBn: 'পণ্য',
    }).expect(201);
    return response.body as { id: string; code: string };
  };
  const newCustomer = async (openingBalance = '1000', creditLimit = '560') => {
    const response = await send(t.server, 'post', path('customers'), who('owner'), {
      nameEn: `Customer ${String(Math.random()).slice(2, 10)}`,
      phone: nextPhone(),
      openingBalance,
      creditLimit,
    }).expect(201);
    return response.body as { id: string; code: string };
  };
  const requestChange = (
    who_: string,
    body: object,
    headers: Record<string, string> = {},
    slug = shop.slug,
  ) => {
    let call = request(t.server)
      .post(`/api/v1/b/${slug}/change-requests`)
      .set('Cookie', cookieHeader(who(who_)));
    for (const [name, value] of Object.entries(headers)) {
      call = call.set(name, value);
    }
    return call.send(body);
  };
  // A money change staff may ask for: a customer's credit limit.
  const limitRequest = (customerId: string, creditLimit: string, extra: object = {}) => ({
    entityType: 'customer',
    entityId: customerId,
    kind: 'edit',
    reason: 'The shop asked for more credit',
    proposedChange: { creditLimit, ...extra },
  });
  // Staff without the cost-price permission can still ask to deactivate.
  // Staff who cannot see dues can still ask to deactivate a customer.
  const deactivateRequest = (customerId: string) => ({
    entityType: 'customer',
    entityId: customerId,
    kind: 'edit',
    reason: 'Shop closed',
    proposedChange: { isActive: false },
  });
  const decide = (
    who_: string,
    id: string,
    action: 'approve' | 'reject' | 'cancel',
    body: object = {},
  ) => send(t.server, 'post', path(`change-requests/${id}/${action}`), who(who_), body);

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('cr');
    other = await data.createBusiness('cr-other');
    await member('owner', null);
    await member('owner2', null);
    await member('ownerRole', 'owner', shop.id);
    await member('manager', 'manager', shop.id);
    await member('accountant', 'accountant', shop.id);
    await member('salesman', 'salesman', shop.id);
    await member('otherManager', 'manager', other.id);
    categoryId = (
      (
        await send(t.server, 'post', path('product-categories'), who('owner'), {
          nameEn: 'OPC',
          nameBn: 'ওপিসি',
        }).expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    t.app.get(ChangeHandlerRegistry).unregister('test_widget');
    t.app.get(ChangeHandlerRegistry).unregister('test_rollback');
    await data.cleanup();
    await t.app.close();
  });

  describe('the full flow', () => {
    it('lets a manager request a price change that the owner approves, applied in one go', async () => {
      const product = await newCustomer();
      const created = await requestChange('manager', limitRequest(product.id, '565')).expect(201);
      const body = created.body as RequestBody;
      expect(body).toMatchObject({
        status: 'pending',
        entityLabel: expect.stringContaining(product.code) as string,
        summary: 'Credit limit: 560.00 → 565.00',
        snapshot: { creditLimit: '560.00' },
        proposedChange: { creditLimit: '565.00' },
        isStale: false,
      });
      expect(body.impact).toEqual([
        {
          key: 'customer.creditLimit',
          label: 'Credit limit',
          before: '560.00',
          after: '565.00',
        },
      ]);

      // Not applied yet.
      const before = await get(t.server, path(`customers/${product.id}`), who('manager')).expect(
        200,
      );
      expect((before.body as { creditLimit: string }).creditLimit).toBe('560.00');

      const approved = await decide('owner', body.id, 'approve', { note: 'ok' }).expect(200);
      expect((approved.body as RequestBody).status).toBe('approved');
      const after = await get(t.server, path(`customers/${product.id}`), who('manager')).expect(
        200,
      );
      expect((after.body as { creditLimit: string }).creditLimit).toBe('565.00');

      const audit = await t.prisma.client.auditLog.findMany({
        where: {
          businessId: shop.id,
          OR: [{ entityId: body.id }, { entityId: product.id, action: 'change_request.applied' }],
        },
        select: { action: true, changes: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual([
        'change_request.created',
        'change_request.approved',
        'change_request.applied',
      ]);
      expect(audit[2]?.changes).toMatchObject({
        before: { creditLimit: '560.00' },
        after: { creditLimit: '565.00' },
      });
    });

    it('moves the customer’s current balance with an approved opening balance change', async () => {
      const customer = await newCustomer('1000');
      const preview = await send(
        t.server,
        'post',
        path('change-requests/preview'),
        who('accountant'),
        {
          entityType: 'customer',
          entityId: customer.id,
          kind: 'edit',
          proposedChange: { openingBalance: '1500' },
        },
      ).expect(200);
      expect((preview.body as { impact: unknown[] }).impact).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'customer.currentBalance',
            before: '1000.00',
            after: '1500.00',
            delta: '+500.00',
          }),
        ]),
      );

      const created = await requestChange('accountant', {
        entityType: 'customer',
        entityId: customer.id,
        kind: 'edit',
        reason: 'Opening balance was mistyped',
        proposedChange: { openingBalance: '1500', creditLimit: '20000' },
      }).expect(201);
      await decide('ownerRole', (created.body as RequestBody).id, 'approve').expect(200);

      const after = await get(t.server, path(`customers/${customer.id}`), who('manager')).expect(
        200,
      );
      expect(after.body).toMatchObject({
        openingBalance: '1500.00',
        currentBalance: '1500.00',
        creditLimit: '20000.00',
      });
    });

    it('leaves the record untouched on rejection, which needs a note', async () => {
      const product = await newCustomer();
      const id = (
        (await requestChange('manager', limitRequest(product.id, '600')).expect(201))
          .body as RequestBody
      ).id;
      await decide('owner', id, 'reject').expect(400);
      await decide('owner', id, 'reject', { note: '' }).expect(400);
      const rejected = await decide('owner', id, 'reject', { note: 'Rate not confirmed' }).expect(
        200,
      );
      expect(rejected.body).toMatchObject({
        status: 'rejected',
        decisionNote: 'Rate not confirmed',
      });
      const after = await get(t.server, path(`customers/${product.id}`), who('manager')).expect(
        200,
      );
      expect((after.body as { creditLimit: string }).creditLimit).toBe('560.00');
      await decide('owner', id, 'approve').expect(409); // decided already
    });

    it('lets the requester cancel their own pending request, and nobody else', async () => {
      const product = await newCustomer();
      const id = (
        (await requestChange('manager', limitRequest(product.id, '570')).expect(201))
          .body as RequestBody
      ).id;
      await decide('salesman', id, 'cancel').expect(404);
      await decide('manager', id, 'cancel').expect(200);
      await decide('manager', id, 'cancel').expect(409);
      // A new request is possible again.
      await requestChange('manager', limitRequest(product.id, '570')).expect(201);
    });
  });

  describe('rules', () => {
    it('never lets anyone decide their own request, the owner included', async () => {
      const product = await newCustomer();
      const own = (
        (await requestChange('owner', limitRequest(product.id, '575')).expect(201))
          .body as RequestBody
      ).id;
      await decide('owner', own, 'approve').expect(403);
      await decide('owner', own, 'reject', { note: 'not ok' }).expect(403);
      await decide('owner2', own, 'approve').expect(200);
    });

    it('allows only one pending request per record, naming it only to those who may open it', async () => {
      const customer = await newCustomer();
      const first = (await requestChange('manager', limitRequest(customer.id, '561')).expect(201))
        .body as RequestBody;

      // Someone else's request, without change.view.all: no id.
      const second = await requestChange('salesman', deactivateRequest(customer.id)).expect(409);
      expect(second.body).toMatchObject({
        code: 'CHANGE_REQUEST_PENDING_EXISTS',
        message: 'This record already has a pending change request',
      });
      expect(second.body).not.toHaveProperty('changeRequestId');
      expect(JSON.stringify(second.body)).not.toContain(first.id);

      // Their own request: the id, so the app can open it.
      const own = await requestChange('manager', limitRequest(customer.id, '562')).expect(409);
      expect(own.body).toMatchObject({
        code: 'CHANGE_REQUEST_PENDING_EXISTS',
        changeRequestId: first.id,
      });

      // change.view.all sees everyone's requests, so gets the id too.
      const owner = await requestChange('owner', limitRequest(customer.id, '563')).expect(409);
      expect((owner.body as { changeRequestId?: string }).changeRequestId).toBe(first.id);
    });

    it('refuses an empty, unknown, unchanged or invalid change, and a void of master data', async () => {
      const product = await newCustomer();
      await requestChange('manager', { ...limitRequest(product.id, '560') }).expect(400); // nothing changes
      await requestChange('manager', { ...limitRequest(product.id, '5.555') }).expect(400);
      await requestChange('manager', { ...limitRequest(product.id, '565'), reason: 'no' }).expect(
        400,
      );
      const realProduct = await newProduct();
      await requestChange('manager', {
        entityType: 'product',
        entityId: realProduct.id,
        kind: 'edit',
        reason: 'rename',
        proposedChange: { nameEn: 'X' },
      }).expect(400); // plain fields are edited directly, not by request
      await requestChange('manager', {
        entityType: 'product',
        entityId: realProduct.id,
        kind: 'void',
        reason: 'gone',
      }).expect(400);
      await requestChange('manager', {
        entityType: 'spaceship',
        entityId: product.id,
        kind: 'edit',
        reason: 'why',
        proposedChange: { x: 1 },
      }).expect(400);
      await requestChange('manager', {
        ...limitRequest('00000000-0000-7000-8000-000000000000', '565'),
      }).expect(404);
    });

    it('marks a request stale when the record changed before approval, and applies nothing', async () => {
      const product = await newCustomer();
      const id = (
        (await requestChange('manager', limitRequest(product.id, '565')).expect(201))
          .body as RequestBody
      ).id;
      // The owner changes the price directly in the meantime (with a reason).
      await send(t.server, 'patch', path(`customers/${product.id}`), who('owner'), {
        creditLimit: '580',
      }).expect(400);
      await send(t.server, 'patch', path(`customers/${product.id}`), who('owner'), {
        creditLimit: '580',
        reason: 'New rate list',
      }).expect(200);

      const detail = await get(t.server, path(`change-requests/${id}`), who('manager')).expect(200);
      expect((detail.body as RequestBody).isStale).toBe(true);

      const attempt = await decide('ownerRole', id, 'approve').expect(409);
      expect(attempt.body).toMatchObject({ message: expect.stringContaining('stale') as string });
      const after = await get(t.server, path(`change-requests/${id}`), who('manager')).expect(200);
      expect((after.body as RequestBody).status).toBe('stale');
      const productNow = await get(
        t.server,
        path(`customers/${product.id}`),
        who('manager'),
      ).expect(200);
      expect((productNow.body as { creditLimit: string }).creditLimit).toBe('580.00');
    });

    it('refuses to apply a pending request for a field that no longer exists', async () => {
      const product = await newCustomer();
      const id = (
        (await requestChange('manager', limitRequest(product.id, '541')).expect(201))
          .body as RequestBody
      ).id;
      // As if the request had been made before a field was removed from the record.
      await t.prisma.forBusiness(shop.id).changeRequest.update({
        where: { id },
        data: { proposedChange: { defaultSalePrice: '600.00' } },
      });
      await decide('owner', id, 'approve').expect(409);
      const after = await get(t.server, path(`change-requests/${id}`), who('owner')).expect(200);
      expect((after.body as RequestBody).status).toBe('pending');
    });

    it('applies only once when two approvers approve at the same moment', async () => {
      const customer = await newCustomer('1000');
      const id = (
        (
          await requestChange('manager', {
            entityType: 'customer',
            entityId: customer.id,
            kind: 'edit',
            reason: 'Typo',
            proposedChange: { openingBalance: '1500' },
          }).expect(201)
        ).body as RequestBody
      ).id;
      const results = await Promise.all([
        decide('owner', id, 'approve'),
        decide('ownerRole', id, 'approve'),
        decide('owner2', id, 'approve'),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409, 409]);
      const after = await get(t.server, path(`customers/${customer.id}`), who('manager')).expect(
        200,
      );
      expect(after.body).toMatchObject({ openingBalance: '1500.00', currentBalance: '1500.00' });
      const version = await t.prisma
        .forBusiness(shop.id)
        .customer.findUniqueOrThrow({ where: { id: customer.id }, select: { version: true } });
      expect(version.version).toBe(2);
    });

    it('rolls everything back when applying fails half way', async () => {
      const registry = t.app.get(ChangeHandlerRegistry);
      const product = await newProduct();
      const failing: ChangeHandler = {
        entityType: 'test_rollback',
        viewPermission: 'product.view',
        fields: { creditLimit: { label: 'Limit', directPermission: 'customer.balance.edit' } },
        load: (tx, ctx, id, options) =>
          registry.find('product', 'dealership')?.load(tx, ctx, id, options) ??
          Promise.resolve(null),
        validateEdit: (_ctx, _current, proposed) => proposed,
        preview: () => Promise.resolve([]),
        async applyEdit(tx, _ctx, id) {
          await tx.product.update({
            where: { id },
            data: { nameEn: 'Half applied', version: { increment: 1 } },
          });
          throw new InternalServerErrorException('Simulated failure after a partial write');
        },
      };
      registry.register(failing);
      const id = (
        (
          await requestChange('manager', {
            ...limitRequest(product.id, '565.00'),
            entityType: 'test_rollback',
          }).expect(201)
        ).body as RequestBody
      ).id;
      await decide('owner', id, 'approve').expect(500);

      const row = await t.prisma
        .forBusiness(shop.id)
        .product.findUniqueOrThrow({ where: { id: product.id } });
      expect(row.nameEn).not.toBe('Half applied');
      expect(row.version).toBe(1);
      const after = await get(t.server, path(`change-requests/${id}`), who('owner')).expect(200);
      expect((after.body as RequestBody).status).toBe('pending');
    });

    it('returns the same request for the same Idempotency-Key', async () => {
      const product = await newCustomer();
      const key = `key-${String(Math.random()).slice(2, 14)}`;
      const first = await requestChange('manager', limitRequest(product.id, '566'), {
        'Idempotency-Key': key,
      }).expect(201);
      const again = await requestChange('manager', limitRequest(product.id, '566'), {
        'Idempotency-Key': key,
      }).expect(200);
      expect((again.body as RequestBody).id).toBe((first.body as RequestBody).id);
      await requestChange('manager', limitRequest(product.id, '566'), {
        'Idempotency-Key': 'bad key!',
      }).expect(400);
      const total = await t.prisma
        .forBusiness(shop.id)
        .changeRequest.count({ where: { entityId: product.id } });
      expect(total).toBe(1);
    });
  });

  describe('permissions', () => {
    it('lets staff request but not decide, list everything or see the badge', async () => {
      const product = await newCustomer();
      const id = (
        (await requestChange('salesman', deactivateRequest(product.id)).expect(201))
          .body as RequestBody
      ).id;
      for (const staff of ['manager', 'accountant', 'salesman']) {
        await decide(staff, id, 'approve').expect(403);
        await get(t.server, path('change-requests'), who(staff)).expect(403);
        await get(t.server, path('change-requests/pending-count'), who(staff)).expect(403);
      }
      // A manager cannot read someone else's request either.
      await get(t.server, path(`change-requests/${id}`), who('manager')).expect(404);
      await get(t.server, path(`change-requests/${id}`), who('salesman')).expect(200);
    });

    it('lets each role request only fields it may see', async () => {
      const product = await newProduct();
      const customer = await newCustomer();
      await requestChange('salesman', limitRequest(customer.id, '1')).expect(403); // no due view
      await requestChange('salesman', {
        entityType: 'customer',
        entityId: customer.id,
        kind: 'edit',
        reason: 'typo',
        proposedChange: { openingBalance: '1' },
      }).expect(403); // no due view
      await requestChange('accountant', {
        entityType: 'product',
        entityId: product.id,
        kind: 'edit',
        reason: 'gone',
        proposedChange: { isActive: false },
      }).expect(403); // cannot see products
    });

    it('requires the approver to be allowed to make the same change directly', async () => {
      // Give the manager change.approve, but not product.deactivate.
      const matrix = await get(t.server, path('roles/permissions'), who('owner')).expect(200);
      const managerPermissions =
        (matrix.body as { roles: { key: string; permissions: string[] }[] }).roles.find(
          (role) => role.key === 'manager',
        )?.permissions ?? [];
      await send(t.server, 'put', path('roles/manager/permissions'), who('owner'), {
        permissions: [...managerPermissions, 'change.approve', 'change.view.all'],
      }).expect(200);

      const product = await newCustomer();
      const id = (
        (await requestChange('salesman', deactivateRequest(product.id)).expect(201))
          .body as RequestBody
      ).id;
      await decide('manager', id, 'approve').expect(403);
      await decide('manager', id, 'reject', { note: 'Not now' }).expect(200);

      await send(t.server, 'put', path('roles/manager/permissions'), who('owner'), {
        permissions: managerPermissions,
      }).expect(200);
    });

    it('hides values the viewer may not see in the summary, snapshot and impact', async () => {
      const product = await newCustomer();
      const id = (
        (
          await requestChange(
            'manager',
            limitRequest(product.id, '545', { isActive: false }),
          ).expect(201)
        ).body as RequestBody
      ).id;

      // Let the salesman list all requests, still without the cost-price permission.
      const matrix = await get(t.server, path('roles/permissions'), who('owner')).expect(200);
      const salesmanPermissions =
        (matrix.body as { roles: { key: string; permissions: string[] }[] }).roles.find(
          (role) => role.key === 'salesman',
        )?.permissions ?? [];
      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: [...salesmanPermissions, 'change.view.all'],
      }).expect(200);

      const list = await get(
        t.server,
        path(`change-requests?entityId=${product.id}`),
        who('salesman'),
      ).expect(200);
      const item = (list.body as { items: RequestBody[] }).items[0];
      expect(item?.summary).toContain('Credit limit changed');
      expect(item?.summary).toContain('Active: true → false');
      expect(JSON.stringify(list.body)).not.toContain('545.00');
      expect(JSON.stringify(list.body)).not.toContain('560.00');
      expect(item).not.toHaveProperty('snapshot');

      const detail = await get(t.server, path(`change-requests/${id}`), who('salesman')).expect(
        200,
      );
      const body = detail.body as RequestBody;
      expect(body.snapshot).toEqual({ isActive: true });
      expect(body.proposedChange).toEqual({ isActive: false });
      expect(body.impact?.map((line) => line.key)).toEqual(['customer.isActive']);

      const forOwner = await get(t.server, path(`change-requests/${id}`), who('owner')).expect(200);
      expect((forOwner.body as RequestBody).snapshot).toEqual({
        creditLimit: '560.00',
        isActive: true,
      });

      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: salesmanPermissions,
      }).expect(200);
    });

    it('keeps one business’s requests away from another', async () => {
      const product = await newCustomer();
      const id = (
        (await requestChange('manager', limitRequest(product.id, '571')).expect(201))
          .body as RequestBody
      ).id;
      await get(t.server, path(`change-requests/${id}`, other.slug), who('owner')).expect(404);
      await decide('owner', id, 'approve').expect(200);
      await send(
        t.server,
        'post',
        path(`change-requests/${id}/approve`, other.slug),
        who('owner'),
      ).expect(404);
      await get(t.server, path('change-requests', shop.slug), who('otherManager')).expect(403);
      await requestChange('otherManager', limitRequest(product.id, '572'), {}, other.slug).expect(
        404,
      );
    });
  });

  describe('lists and badge', () => {
    it('lists my requests and all requests ten per page, with filters, and counts pending', async () => {
      const shopList = await data.createBusiness('cr-list');
      const manager = await data.createUser({ name: 'List Manager' });
      await data.giveAccess(manager.id, shopList.id, 'manager');
      const managerCookies = (await login(t.server, manager.email ?? '', manager.password)).cookies;
      const category = (
        (
          await send(t.server, 'post', `/b/${shopList.slug}/product-categories`, who('owner'), {
            nameEn: 'C',
            nameBn: 'C',
          }).expect(201)
        ).body as { id: string }
      ).id;
      for (let index = 0; index < 12; index += 1) {
        const product = (
          await send(t.server, 'post', `/b/${shopList.slug}/products`, who('owner'), {
            categoryId: category,
            nameEn: `Item ${String(index)}`,
            nameBn: 'x',
          }).expect(201)
        ).body as { id: string };
        await send(t.server, 'post', `/b/${shopList.slug}/change-requests`, managerCookies, {
          entityType: 'product',
          entityId: product.id,
          kind: 'edit',
          reason: 'rate',
          proposedChange: { isActive: false },
        }).expect(201);
      }

      const mine = await get(
        t.server,
        `/b/${shopList.slug}/change-requests/mine`,
        managerCookies,
      ).expect(200);
      expect(mine.body).toMatchObject({ page: 1, pageSize: 10, total: 12 });
      expect((mine.body as { items: unknown[] }).items).toHaveLength(10);
      const page2 = await get(
        t.server,
        `/b/${shopList.slug}/change-requests/mine?page=2`,
        managerCookies,
      ).expect(200);
      expect((page2.body as { items: unknown[] }).items).toHaveLength(2);

      const badge = await get(
        t.server,
        `/b/${shopList.slug}/change-requests/pending-count`,
        who('owner'),
      ).expect(200);
      expect(badge.body).toEqual({ count: 12 });

      const firstId = (mine.body as { items: RequestBody[] }).items[0]?.id ?? '';
      await decide('owner', firstId, 'reject', { note: 'not ok' }).expect(404); // wrong business path
      await send(
        t.server,
        'post',
        `/b/${shopList.slug}/change-requests/${firstId}/reject`,
        who('owner'),
        { note: 'not ok' },
      ).expect(200);
      const rejected = await get(
        t.server,
        `/b/${shopList.slug}/change-requests?status=rejected`,
        who('owner'),
      ).expect(200);
      expect((rejected.body as { total: number }).total).toBe(1);
      const pending = await get(
        t.server,
        `/b/${shopList.slug}/change-requests?status=pending&entityType=product`,
        who('owner'),
      ).expect(200);
      expect((pending.body as { total: number }).total).toBe(11);
      const future = await get(
        t.server,
        `/b/${shopList.slug}/change-requests?from=2999-01-01`,
        who('owner'),
      ).expect(200);
      expect((future.body as { total: number }).total).toBe(0);
      expect(
        (
          await get(
            t.server,
            `/b/${shopList.slug}/change-requests/pending-count`,
            who('owner'),
          ).expect(200)
        ).body,
      ).toEqual({ count: 11 });
    });
  });

  describe('a new record type plugs in without changing the framework', () => {
    it('handles edits and voids (with reversal) of a test-only type', async () => {
      // An in-memory "widget" with a stock counter, standing in for a future module.
      const widgets = new Map([
        [
          '00000000-0000-7000-8000-0000000000aa',
          { version: 1, price: '10.00', voided: false, quantity: 5 },
        ],
      ]);
      const stock = { quantity: 100 };
      const widgetId = '00000000-0000-7000-8000-0000000000aa';
      const handler: ChangeHandler = {
        entityType: 'test_widget',
        viewPermission: 'product.view',
        fields: { price: { label: 'Price', directPermission: 'product.deactivate' } },
        void: { label: 'Void widget sale', directPermission: 'product.deactivate' },
        load: (_tx, _ctx, id) => {
          const widget = widgets.get(id);
          return Promise.resolve(
            widget && !widget.voided
              ? {
                  version: widget.version,
                  label: `Widget ${id.slice(-2)}`,
                  values: { price: widget.price },
                }
              : null,
          );
        },
        validateEdit: (_ctx, _current, proposed) => ({ price: String(proposed['price']) }),
        validateVoid: () => Promise.resolve(),
        preview: (_tx, _ctx, current, change) =>
          Promise.resolve(
            change.kind === 'void'
              ? [
                  {
                    key: 'stock',
                    label: 'Stock',
                    before: stock.quantity,
                    after: stock.quantity + 5,
                    delta: '+5',
                    unit: 'bag',
                  },
                ]
              : [
                  {
                    key: 'price',
                    label: 'Price',
                    before: current.values['price'] ?? null,
                    after: change.values['price'] ?? null,
                  },
                ],
          ),
        applyEdit: (_tx, _ctx, id, _current, values) => {
          const widget = widgets.get(id);
          if (widget) {
            widget.price = String(values['price']);
            widget.version += 1;
          }
          return Promise.resolve();
        },
        applyVoid: (_tx, _ctx, id) => {
          const widget = widgets.get(id);
          if (widget) {
            widget.voided = true;
            widget.version += 1;
            stock.quantity += widget.quantity; // the reversal
          }
          return Promise.resolve();
        },
      };
      t.app.get(ChangeHandlerRegistry).register(handler);

      const edit = await requestChange('manager', {
        entityType: 'test_widget',
        entityId: widgetId,
        kind: 'edit',
        reason: 'typo',
        proposedChange: { price: '12.00' },
      }).expect(201);
      expect((edit.body as RequestBody).summary).toBe('Price: 10.00 → 12.00');
      await decide('owner', (edit.body as RequestBody).id, 'approve').expect(200);
      expect(widgets.get(widgetId)?.price).toBe('12.00');

      const voidRequest = await requestChange('manager', {
        entityType: 'test_widget',
        entityId: widgetId,
        kind: 'void',
        reason: 'Entered twice',
      }).expect(201);
      const voidBody = voidRequest.body as RequestBody;
      expect(voidBody).toMatchObject({ summary: 'Void widget sale', proposedChange: null });
      expect(voidBody.impact).toEqual([
        { key: 'stock', label: 'Stock', before: 100, after: 105, delta: '+5', unit: 'bag' },
      ]);
      await decide('owner', voidBody.id, 'approve').expect(200);
      expect(widgets.get(widgetId)?.voided).toBe(true);
      expect(stock.quantity).toBe(105);
    });
  });
});

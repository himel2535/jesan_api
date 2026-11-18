import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  code: string;
  field?: string;
  errors?: { field: string; code: string; message: string }[];
}

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0172${String(phoneCounter).padStart(7, '0')}`;
};

/** The parts of an error the frontend relies on. */
function shape(response: request.Response) {
  const body = response.body as ErrorBody;
  return {
    status: response.status,
    code: body.code,
    field: body.field,
    fields: body.errors?.map((error) => `${error.field}:${error.code}`),
  };
}

describe.skipIf(!hasDatabase)('error codes and fields', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  let other: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  const users: Record<string, { id: string; email: string | null; password: string }> = {};
  let categoryId: string;
  let otherProductId: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string, slug = shop.slug) => `/b/${slug}/${suffix}`;

  async function member(name: string, roleKey: string | null, businessId?: string) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey && businessId) {
      await data.giveAccess(user.id, businessId, roleKey);
    }
    users[name] = user;
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const newProduct = async (nameEn: string) =>
    (
      (
        await send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameEn,
          nameBn: 'x',
        }).expect(201)
      ).body as { id: string }
    ).id;

  const newCustomer = async (nameEn: string) =>
    (
      (
        await send(t.server, 'post', path('customers'), who('owner'), {
          nameEn,
          phone: newPhone(),
          creditLimit: '0',
        }).expect(201)
      ).body as { id: string }
    ).id;

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('codes');
    other = await data.createBusiness('codes-other');
    await member('owner', null);
    await member('manager', 'manager', shop.id);
    await member('salesman', 'salesman', shop.id);
    categoryId = (
      (
        await send(t.server, 'post', path('product-categories'), who('owner'), {
          nameEn: 'OPC',
          nameBn: 'x',
        }).expect(201)
      ).body as { id: string }
    ).id;
    const otherCategory = (
      (
        await send(t.server, 'post', path('product-categories', other.slug), who('owner'), {
          nameEn: 'Other',
          nameBn: 'x',
        }).expect(201)
      ).body as { id: string }
    ).id;
    otherProductId = (
      (
        await send(t.server, 'post', path('products', other.slug), who('owner'), {
          categoryId: otherCategory,
          nameEn: 'Secret Other Product',
          nameBn: 'x',
        }).expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await data.cleanup();
    await t.app.close();
  });

  describe('validation', () => {
    it('keeps the message list and adds a code per field', async () => {
      const response = await send(t.server, 'post', path('customers'), who('manager'), {
        nameEn: '',
        phone: 17,
        defaultDiscount: '5',
      }).expect(400);
      const body = response.body as ErrorBody;
      expect(Array.isArray(body.message)).toBe(true);
      expect(body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VALIDATION_FAILED',
      });
      expect(body).not.toHaveProperty('field');
      expect(body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'nameEn', code: 'NAME_EN_REQUIRED' }),
          expect.objectContaining({ field: 'phone', code: 'PHONE_INVALID' }),
          expect.objectContaining({
            field: 'defaultDiscount',
            code: 'DEFAULT_DISCOUNT_NOT_ALLOWED',
          }),
        ]),
      );
    });

    it('refuses a sale price on a product as an unknown field', async () => {
      const response = await send(t.server, 'post', path('products'), who('owner'), {
        categoryId,
        nameEn: 'With Sale Price',
        nameBn: 'x',
        defaultSalePrice: '560',
      }).expect(400);
      expect(shape(response).fields).toEqual(['defaultSalePrice:DEFAULT_SALE_PRICE_NOT_ALLOWED']);
    });

    it('codes a bad id in the path', async () => {
      const response = await get(t.server, path('products/not-a-uuid'), who('manager')).expect(400);
      expect(shape(response)).toMatchObject({ code: 'ID_INVALID', field: undefined });
    });
  });

  describe('master data rules', () => {
    it('names the field of a duplicate or invalid phone, without the other customer', async () => {
      const phone = newPhone();
      await send(t.server, 'post', path('customers'), who('manager'), {
        nameEn: 'First Customer',
        phone,
      }).expect(201);
      const duplicate = await send(t.server, 'post', path('customers'), who('manager'), {
        nameEn: 'Second Customer',
        phone,
      }).expect(409);
      expect(shape(duplicate)).toEqual({
        status: 409,
        code: 'PHONE_DUPLICATE',
        field: 'phone',
        fields: ['phone:PHONE_DUPLICATE'],
      });
      const text = JSON.stringify(duplicate.body);
      expect(text).not.toContain('First Customer');
      expect(text).not.toContain(phone.slice(-7));

      const invalid = await send(t.server, 'post', path('customers'), who('manager'), {
        nameEn: 'Bad Phone',
        phone: '12345',
      }).expect(400);
      expect(shape(invalid)).toMatchObject({ code: 'PHONE_INVALID', field: 'phone' });
    });

    it('codes product rules: name, category, unit, reason, nothing to change, not found', async () => {
      const id = await newProduct('Coded Product');
      const product = (body: object) =>
        send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameBn: 'x',
          ...body,
        });
      expect(shape(await product({ nameEn: 'coded product' }).expect(409))).toMatchObject({
        code: 'NAME_EN_DUPLICATE',
        field: 'nameEn',
      });
      expect(shape(await product({ nameEn: 'P2', unitKey: 'ton' }).expect(400))).toMatchObject({
        code: 'UNIT_UNKNOWN',
        field: 'unitKey',
      });

      const inactive = (
        (
          await send(t.server, 'post', path('product-categories'), who('owner'), {
            nameEn: 'Retired',
            nameBn: 'x',
          }).expect(201)
        ).body as { id: string }
      ).id;
      await send(t.server, 'patch', path(`product-categories/${inactive}`), who('owner'), {
        isActive: false,
        reason: 'not sold any more',
      }).expect(200);
      expect(
        shape(await product({ nameEn: 'P3', categoryId: inactive }).expect(400)),
      ).toMatchObject({ code: 'CATEGORY_NOT_FOUND_OR_INACTIVE', field: 'categoryId' });

      const patch = (body: object) =>
        send(t.server, 'patch', path(`products/${id}`), who('owner'), body);
      expect(shape(await patch({ isActive: false }).expect(400))).toMatchObject({
        code: 'REASON_REQUIRED',
        field: 'reason',
      });
      // The last purchase price is set by purchases only.
      expect(
        shape(await patch({ purchasePrice: '1', reason: 'new cost' }).expect(400)),
      ).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: ['purchasePrice:PURCHASE_PRICE_NOT_ALLOWED'],
      });
      expect(
        shape(await product({ nameEn: 'Typed Cost', lastPurchasePrice: '1' }).expect(400)),
      ).toMatchObject({ fields: ['lastPurchasePrice:LAST_PURCHASE_PRICE_NOT_ALLOWED'] });
      expect(shape(await patch({}).expect(400))).toMatchObject({
        code: 'NOTHING_TO_CHANGE',
        field: undefined,
      });
    });

    it('answers another business’s id exactly like a missing one', async () => {
      const theirs = await get(t.server, path(`products/${otherProductId}`), who('owner')).expect(
        404,
      );
      const missing = await get(
        t.server,
        path('products/00000000-0000-7000-8000-000000000000'),
        who('owner'),
      ).expect(404);
      expect(theirs.body).toEqual(missing.body);
      expect(shape(theirs)).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
      expect(JSON.stringify(theirs.body)).not.toContain('Secret');
    });
  });

  describe('change requests', () => {
    const ask = (who_: string, body: object, headers: Record<string, string> = {}) => {
      let call = request(t.server)
        .post(`/api/v1${path('change-requests')}`)
        .set('Cookie', cookieHeader(who(who_)));
      for (const [name, value] of Object.entries(headers)) {
        call = call.set(name, value);
      }
      return call.send(body);
    };
    const decide = (who_: string, id: string, action: string, body?: object) =>
      send(t.server, 'post', path(`change-requests/${id}/${action}`), who(who_), body);

    it('codes every way a request can be wrong', async () => {
      const id = await newCustomer('Requested Customer');
      const base = { entityType: 'customer', entityId: id, kind: 'edit', reason: 'new limit' };
      const cases: [object, number, string, string | undefined][] = [
        [
          { ...base, entityType: 'spaceship', proposedChange: { x: 1 } },
          400,
          'ENTITY_TYPE_UNKNOWN',
          'entityType',
        ],
        [{ ...base, kind: 'void' }, 400, 'VOID_NOT_SUPPORTED', 'kind'],
        [{ ...base, proposedChange: {} }, 400, 'PROPOSED_CHANGE_EMPTY', 'proposedChange'],
        [
          { ...base, proposedChange: { nameEn: 'X' } },
          400,
          'FIELD_NOT_CHANGEABLE',
          'proposedChange.nameEn',
        ],
        [
          { ...base, proposedChange: { creditLimit: 5 } },
          400,
          'CREDIT_LIMIT_INVALID',
          'proposedChange.creditLimit',
        ],
        [
          { ...base, proposedChange: { isActive: 'no' } },
          400,
          'IS_ACTIVE_INVALID',
          'proposedChange.isActive',
        ],
        [{ ...base, proposedChange: { creditLimit: '0' } }, 400, 'NOTHING_TO_CHANGE', undefined],
        [
          { ...base, entityId: otherProductId, proposedChange: { creditLimit: '1' } },
          404,
          'RECORD_NOT_FOUND',
          'entityId',
        ],
      ];
      for (const [body, status, code, field] of cases) {
        const response = await ask('manager', body);
        expect(shape(response)).toMatchObject({
          status,
          code,
          field,
        });
      }
      const badKey = await ask(
        'manager',
        { ...base, proposedChange: { creditLimit: '1' } },
        { 'Idempotency-Key': 'bad key!' },
      ).expect(400);
      expect(shape(badKey)).toMatchObject({
        code: 'IDEMPOTENCY_KEY_INVALID',
        field: 'Idempotency-Key',
      });
      const hidden = await ask('salesman', {
        ...base,
        proposedChange: { creditLimit: '1' },
      }).expect(403);
      expect(shape(hidden)).toMatchObject({ code: 'ACCESS_DENIED' });
    });

    it('codes pending, self decision, decided, stale and missing requests', async () => {
      const id = await newProduct('Decided Product');
      const body = {
        entityType: 'product',
        entityId: id,
        kind: 'edit',
        reason: 'not sold',
        proposedChange: { isActive: false },
      };
      const first = (await ask('manager', body).expect(201)).body as { id: string };
      expect(shape(await ask('manager', body).expect(409))).toMatchObject({
        code: 'CHANGE_REQUEST_PENDING_EXISTS',
      });
      expect(
        shape(await decide('owner', first.id, 'reject', { note: 'x' }).expect(400)),
      ).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: ['note:NOTE_TOO_SHORT'],
      });
      await decide('manager', first.id, 'cancel').expect(200);
      expect(shape(await decide('manager', first.id, 'cancel').expect(409))).toMatchObject({
        code: 'CHANGE_REQUEST_ALREADY_DECIDED',
      });

      const own = (await ask('owner', body).expect(201)).body as { id: string };
      expect(shape(await decide('owner', own.id, 'approve').expect(403))).toMatchObject({
        code: 'SELF_DECISION_FORBIDDEN',
      });
      await decide('owner', own.id, 'cancel').expect(200);

      const staleOne = (await ask('manager', body).expect(201)).body as { id: string };
      await send(t.server, 'patch', path(`products/${id}`), who('owner'), {
        nameEn: 'Decided Product Renamed',
      }).expect(200);
      expect(shape(await decide('owner', staleOne.id, 'approve').expect(409))).toMatchObject({
        code: 'STALE_REQUEST',
      });

      expect(
        shape(
          await get(
            t.server,
            path('change-requests/00000000-0000-7000-8000-000000000000'),
            who('owner'),
          ).expect(404),
        ),
      ).toMatchObject({ code: 'CHANGE_REQUEST_NOT_FOUND' });
    });
  });

  describe('auth, settings and the rest', () => {
    it('gives every failed sign-in the same code', async () => {
      const wrongPassword = await request(t.server)
        .post('/api/v1/auth/login')
        .send({ identifier: users['manager']?.email, password: 'wrong-password-123' })
        .expect(401);
      const unknownUser = await request(t.server)
        .post('/api/v1/auth/login')
        .send({ identifier: 'nobody@example.test', password: 'wrong-password-123' })
        .expect(401);
      expect(wrongPassword.body).toEqual(unknownUser.body);
      expect(shape(wrongPassword)).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    it('codes password rules with the field they came in', async () => {
      const response = await send(t.server, 'post', '/auth/change-password', who('salesman'), {
        currentPassword: 'not-the-password-1',
        newPassword: 'another-password-123',
      }).expect(400);
      expect(shape(response)).toMatchObject({
        code: 'CURRENT_PASSWORD_INCORRECT',
        field: 'currentPassword',
      });
      const short = await send(t.server, 'post', '/auth/change-password', who('salesman'), {
        currentPassword: users['salesman']?.password,
        newPassword: 'short',
      }).expect(400);
      expect(shape(short)).toMatchObject({ code: 'PASSWORD_TOO_SHORT', field: 'newPassword' });
    });

    it('codes settings rules', async () => {
      const put = (roleKey: string, permissions: string[]) =>
        send(t.server, 'put', path(`roles/${roleKey}/permissions`), who('owner'), { permissions });
      expect(shape(await put('owner', []).expect(400))).toMatchObject({ code: 'OWNER_ROLE_FIXED' });
      expect(shape(await put('manager', ['made.up']).expect(400))).toMatchObject({
        code: 'PERMISSION_UNKNOWN',
        field: 'permissions',
      });
      expect(shape(await put('manager', ['profit.view']).expect(400))).toMatchObject({
        code: 'PERMISSION_OWNER_ONLY',
        field: 'permissions',
      });
      expect(shape(await put('nobody', []).expect(404))).toMatchObject({ code: 'ROLE_NOT_FOUND' });

      const create = (body: object) =>
        send(t.server, 'post', path('users'), who('owner'), {
          name: 'New Staff',
          password: 'a-long-enough-password',
          roleKey: 'salesman',
          ...body,
        });
      expect(shape(await create({}).expect(400))).toMatchObject({
        code: 'EMAIL_OR_PHONE_REQUIRED',
      });
      expect(shape(await create({ email: users['manager']?.email }).expect(409))).toMatchObject({
        code: 'USER_ALREADY_EXISTS',
      });
      expect(
        shape(await create({ email: 'x@example.test', roleKey: 'chief' }).expect(400)),
      ).toMatchObject({
        code: 'ROLE_NOT_FOUND',
        field: 'roleKey',
      });
      expect(
        shape(
          await send(
            t.server,
            'patch',
            path(`users/${users['owner']?.id ?? ''}/status`),
            who('owner'),
            {
              isActive: false,
            },
          ).expect(400),
        ),
      ).toMatchObject({ code: 'OWN_STATUS_CHANGE_FORBIDDEN' });
    });

    it('adds a default code to guard, routing and sign-in errors', async () => {
      expect(shape(await get(t.server, '/auth/me', {}).expect(401))).toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(
        shape(await get(t.server, path('roles/permissions'), who('manager')).expect(403)),
      ).toMatchObject({ code: 'ACCESS_DENIED' });
      expect(shape(await get(t.server, '/nowhere', who('manager')).expect(404))).toMatchObject({
        code: 'ROUTE_NOT_FOUND',
      });
    });
  });
});

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { todayIn } from '../src/core/common/business-time';
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
import { expectSalesConsistent } from './sales-helpers';

vi.hoisted(() => {
  process.env['LOGIN_RATE_LIMIT'] = '100000';
});

interface OrderBody {
  id: string;
  code: string;
  status: string;
  deliveryStatus: string;
  totalAmount: string;
  deliveredQuantity: string;
  remainingQuantity: string;
  items: { id: string; quantity: string; unitPrice: string }[];
}
interface DeliveryBody {
  id: string;
  status: string;
  totalQuantity: string;
  totalAmount: string;
  items: { id: string; quantity: string; unitPrice: string; lineTotal: string }[];
}
interface Impact {
  key: string;
  before?: unknown;
  after?: unknown;
  delta?: string;
}

const TODAY = todayIn('Asia/Dhaka');

let phoneCounter = Math.floor(Math.random() * 1e6);
const newPhone = () => {
  phoneCounter += 1;
  return `0174${String(phoneCounter).padStart(7, '0')}`;
};

describe.skipIf(!hasDatabase)('voiding and correcting orders, deliveries and collections', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string) => `/b/${shop.slug}/${suffix}`;

  async function member(name: string, roleKey: string | null) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) await data.giveAccess(user.id, shop.id, roleKey);
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const post = (who_: string, suffix: string, body: object) =>
    request(t.server)
      .post(`/api/v1${path(suffix)}`)
      .set('Cookie', cookieHeader(who(who_)))
      .send(body);

  async function setup(stock = '500', opening = '0') {
    const productId = (
      (
        await send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameEn: `Cement ${String(Math.random()).slice(2, 10)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;
    await post('owner', 'purchases', {
      items: [{ productId, quantity: stock, unitPrice: '540' }],
    }).expect(201);
    const customerId = (
      (
        await send(t.server, 'post', path('customers'), who('owner'), {
          nameEn: `Shop ${String(Math.random()).slice(2, 10)}`,
          phone: newPhone(),
          openingBalance: opening,
        }).expect(201)
      ).body as { id: string }
    ).id;
    return { productId, customerId };
  }

  async function placeOrder(
    customerId: string,
    productId: string,
    quantity = '100',
    unitPrice = '560',
  ) {
    return (
      await post('manager', 'orders', {
        customerId,
        deliveryWindow: 'two_days',
        items: [{ productId, quantity, unitPrice }],
      }).expect(201)
    ).body as OrderBody;
  }

  async function deliver(order: OrderBody, quantity: string) {
    return (
      await post('manager', 'deliveries', {
        orderId: order.id,
        items: [{ orderItemId: order.items[0]?.id, quantity }],
      }).expect(201)
    ).body as DeliveryBody;
  }

  const customer = async (id: string) =>
    (await get(t.server, path(`customers/${id}`), who('owner')).expect(200)).body as {
      currentBalance: string;
      deliveredAmount: string;
      collectedAmount: string;
      pendingDeliveryQuantity: string;
    };

  const stockOf = async (productId: string) =>
    (await get(t.server, path(`stock/${productId}/movements`), who('owner')).expect(200)).body as {
      product: { currentStock: string };
      items: { kind: string; quantity: string; movementDate: string; reason: string | null }[];
    };

  const ledgerOf = async (customerId: string) =>
    (
      (await get(t.server, path(`customers/${customerId}/ledger`), who('owner')).expect(200))
        .body as {
        items: { kind: string; amount: string; entryDate: string; reason: string | null }[];
      }
    ).items;

  beforeAll(async () => {
    await runSeed();
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('sales-changes');
    await runSeed();
    await member('owner', null);
    await member('ownerRole', 'owner');
    await member('manager', 'manager');
    await member('salesman', 'salesman');
    await member('accountant', 'accountant');
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
    await expectSalesConsistent(t, shop.id);
    await data.cleanup();
    await t.app.close();
  });

  describe('delivery', () => {
    it('void returns stock and reverses the balance on the void date; the order gets its bags back', async () => {
      const { productId, customerId } = await setup();
      const order = await placeOrder(customerId, productId);
      const delivery = await deliver(order, '40');
      await post('manager', `deliveries/${delivery.id}/void`, { reason: 'mine' }).expect(403);
      const voided = await post('ownerRole', `deliveries/${delivery.id}/void`, {
        reason: 'Truck turned back',
      }).expect(200);
      expect((voided.body as DeliveryBody).status).toBe('void');
      expect(await customer(customerId)).toMatchObject({
        currentBalance: '0.00',
        deliveredAmount: '0.00',
        pendingDeliveryQuantity: '100',
      });
      const stock = await stockOf(productId);
      expect(stock.product.currentStock).toBe('500');
      expect(stock.items[0]).toMatchObject({
        kind: 'delivery_void',
        quantity: '40',
        movementDate: TODAY,
        reason: 'Truck turned back',
      });
      const ledger = await ledgerOf(customerId);
      expect(ledger[0]).toMatchObject({
        kind: 'delivery_void',
        amount: '-22400.00',
        entryDate: TODAY,
      });
      const orderNow = (await get(t.server, path(`orders/${order.id}`), who('manager')).expect(200))
        .body as OrderBody;
      expect(orderNow).toMatchObject({ deliveredQuantity: '0', deliveryStatus: 'pending' });
      const again = await post('ownerRole', `deliveries/${delivery.id}/void`, {
        reason: 'again',
      }).expect(409);
      expect(again.body).toMatchObject({ code: 'DELIVERY_ALREADY_VOID' });
    });

    it('a quantity correction moves stock, balance, ledger and the order by the difference', async () => {
      const { productId, customerId } = await setup();
      const order = await placeOrder(customerId, productId);
      const delivery = await deliver(order, '40');
      const item = delivery.items[0]?.id ?? '';
      const asked = await post('manager', 'change-requests', {
        entityType: 'delivery',
        entityId: delivery.id,
        kind: 'edit',
        reason: 'Only 35 bags were unloaded',
        proposedChange: { [`items.${item}.quantity`]: '35' },
      }).expect(201);
      const impact = (asked.body as { id: string; impact: Impact[] }).impact;
      expect(impact.find((line) => line.key === `stock.${productId}`)).toMatchObject({
        before: '460',
        after: '465',
        delta: '+5',
      });
      expect(impact.find((line) => line.key === 'order.remainingQuantity')).toMatchObject({
        delta: '+5',
      });
      expect(impact.find((line) => line.key === 'customer.currentBalance')).toMatchObject({
        before: '22400.00',
        after: '19600.00',
        delta: '-2800.00',
      });
      await send(
        t.server,
        'post',
        path(`change-requests/${(asked.body as { id: string }).id}/approve`),
        who('owner'),
      ).expect(200);
      const after = (
        await get(t.server, path(`deliveries/${delivery.id}`), who('manager')).expect(200)
      ).body as DeliveryBody;
      expect(after).toMatchObject({ totalQuantity: '35', totalAmount: '19600.00' });
      expect(await customer(customerId)).toMatchObject({
        currentBalance: '19600.00',
        pendingDeliveryQuantity: '65',
      });
      expect((await stockOf(productId)).items[0]).toMatchObject({
        kind: 'delivery_edit',
        quantity: '5',
      });
      expect((await ledgerOf(customerId))[0]).toMatchObject({
        kind: 'delivery_edit',
        amount: '-2800.00',
      });
      // More than the order allows is refused.
      const tooMuch = await send(
        t.server,
        'patch',
        path(`deliveries/${delivery.id}`),
        who('ownerRole'),
        {
          items: [{ id: item, quantity: '101' }],
          reason: 'typo',
        },
      ).expect(400);
      expect(tooMuch.body).toMatchObject({
        code: 'DELIVERY_QUANTITY_TOO_LARGE',
        details: { remaining: '65' },
      });
      // Raising it within the order works and takes stock out.
      await send(t.server, 'patch', path(`deliveries/${delivery.id}`), who('ownerRole'), {
        items: [{ id: item, quantity: '50' }],
        reason: 'Fifteen more bags went on the same truck',
      }).expect(200);
      expect(await customer(customerId)).toMatchObject({
        currentBalance: '28000.00',
        pendingDeliveryQuantity: '50',
      });
      expect((await stockOf(productId)).product.currentStock).toBe('450');
    });
  });

  describe('order', () => {
    it('cannot be voided while it has an active delivery; then voids and drops the bags still to deliver', async () => {
      const { productId, customerId } = await setup();
      const order = await placeOrder(customerId, productId);
      const delivery = await deliver(order, '10');
      const blocked = await post('ownerRole', `orders/${order.id}/void`, {
        reason: 'Customer cancelled',
      }).expect(409);
      expect(blocked.body).toMatchObject({ code: 'DELIVERY_EXISTS' });
      await post('ownerRole', `deliveries/${delivery.id}/void`, {
        reason: 'Customer cancelled',
      }).expect(200);
      const voided = await post('ownerRole', `orders/${order.id}/void`, {
        reason: 'Customer cancelled',
      }).expect(200);
      expect(voided.body).toMatchObject({ status: 'void', remainingQuantity: '0' });
      expect(await customer(customerId)).toMatchObject({
        pendingDeliveryQuantity: '0',
        currentBalance: '0.00',
      });
      await post('manager', 'deliveries', {
        orderId: order.id,
        items: [{ orderItemId: order.items[0]?.id, quantity: '1' }],
      }).expect(409);
      await post('salesman', `orders/${order.id}/void`, { reason: 'x' }).expect(403);
    });

    it('a price correction re-prices what was delivered: delivery, balance and ledger', async () => {
      const { productId, customerId } = await setup();
      const order = await placeOrder(customerId, productId, '100', '560');
      const delivery = await deliver(order, '40');
      const item = order.items[0]?.id ?? '';
      const asked = await post('manager', 'change-requests', {
        entityType: 'sales_order',
        entityId: order.id,
        kind: 'edit',
        reason: 'Agreed rate was 555',
        proposedChange: { [`items.${item}.unitPrice`]: '555' },
      }).expect(201);
      const impact = (asked.body as { id: string; impact: Impact[] }).impact;
      expect(impact.find((line) => line.key === 'order.totalAmount')).toMatchObject({
        before: '56000.00',
        after: '55500.00',
      });
      expect(impact.find((line) => line.key === 'customer.currentBalance')).toMatchObject({
        before: '22400.00',
        after: '22200.00',
        delta: '-200.00',
      });
      await send(
        t.server,
        'post',
        path(`change-requests/${(asked.body as { id: string }).id}/approve`),
        who('owner'),
      ).expect(200);
      const repriced = (
        await get(t.server, path(`deliveries/${delivery.id}`), who('manager')).expect(200)
      ).body as DeliveryBody;
      expect(repriced).toMatchObject({ totalAmount: '22200.00' });
      expect(repriced.items[0]).toMatchObject({ unitPrice: '555.00', lineTotal: '22200.00' });
      expect((await customer(customerId)).currentBalance).toBe('22200.00');
      expect((await ledgerOf(customerId))[0]).toMatchObject({
        kind: 'delivery_edit',
        amount: '-200.00',
        reason: 'Agreed rate was 555',
      });
      // New deliveries use the corrected price.
      const next = await deliver(order, '10');
      expect(next.totalAmount).toBe('5550.00');
    });

    it('quantity cannot go below what was delivered', async () => {
      const { productId, customerId } = await setup();
      const order = await placeOrder(customerId, productId);
      await deliver(order, '30');
      const refused = await send(t.server, 'patch', path(`orders/${order.id}`), who('ownerRole'), {
        items: [{ id: order.items[0]?.id, quantity: '20' }],
        reason: 'Customer reduced the order',
      }).expect(400);
      expect(refused.body).toMatchObject({
        code: 'ORDER_QUANTITY_TOO_SMALL',
        field: `items.${order.items[0]?.id ?? ''}.quantity`,
      });
      await send(t.server, 'patch', path(`orders/${order.id}`), who('ownerRole'), {
        items: [{ id: order.items[0]?.id, quantity: '30' }],
        reason: 'Customer reduced the order',
      }).expect(200);
      const after = (await get(t.server, path(`orders/${order.id}`), who('manager')).expect(200))
        .body as OrderBody;
      expect(after).toMatchObject({ deliveryStatus: 'delivered', remainingQuantity: '0' });
      expect((await customer(customerId)).pendingDeliveryQuantity).toBe('0');
      await send(t.server, 'patch', path(`orders/${order.id}`), who('manager'), {
        note: 'x',
        reason: 'note',
      }).expect(403);
      const reasonless = await send(
        t.server,
        'patch',
        path(`orders/${order.id}`),
        who('ownerRole'),
        { note: 'x' },
      ).expect(400);
      expect((reasonless.body as { errors: { field: string }[] }).errors[0]?.field).toBe('reason');
    });
  });

  describe('collection', () => {
    it('void reverses the money on the void date; an advance refund is a void', async () => {
      const { customerId } = await setup('1', '0');
      const created = (
        await post('accountant', 'collections', {
          customerId,
          method: 'cash',
          amount: '5000',
        }).expect(201)
      ).body as { id: string };
      expect((await customer(customerId)).currentBalance).toBe('-5000.00');
      await post('accountant', `collections/${created.id}/void`, { reason: 'x' }).expect(403);
      await post('ownerRole', `collections/${created.id}/void`, {
        reason: 'Advance returned in cash',
      }).expect(200);
      expect(await customer(customerId)).toMatchObject({
        currentBalance: '0.00',
        collectedAmount: '0.00',
      });
      expect((await ledgerOf(customerId))[0]).toMatchObject({
        kind: 'collection_void',
        amount: '5000.00',
        entryDate: TODAY,
      });
      const again = await post('ownerRole', `collections/${created.id}/void`, {
        reason: 'again',
      }).expect(409);
      expect(again.body).toMatchObject({ code: 'COLLECTION_ALREADY_VOID' });
    });

    it('an amount correction by request moves the balance by the difference', async () => {
      const { customerId } = await setup('1', '10000');
      const created = (
        await post('accountant', 'collections', {
          customerId,
          method: 'nagad',
          amount: '4000',
        }).expect(201)
      ).body as { id: string };
      const asked = await post('manager', 'change-requests', {
        entityType: 'collection',
        entityId: created.id,
        kind: 'edit',
        reason: 'Nagad statement says 4500',
        proposedChange: { amount: '4500', method: 'bkash' },
      }).expect(201);
      expect((asked.body as { impact: Impact[] }).impact[0]).toMatchObject({
        key: 'customer.currentBalance',
        before: '6000.00',
        after: '5500.00',
      });
      await send(
        t.server,
        'post',
        path(`change-requests/${(asked.body as { id: string }).id}/approve`),
        who('owner'),
      ).expect(200);
      expect(await customer(customerId)).toMatchObject({
        currentBalance: '5500.00',
        collectedAmount: '4500.00',
      });
      const detail = await get(
        t.server,
        path(`collections/${created.id}`),
        who('accountant'),
      ).expect(200);
      expect(detail.body).toMatchObject({ amount: '4500.00', method: 'bkash', version: 2 });
      const unknown = await send(
        t.server,
        'patch',
        path(`collections/${created.id}`),
        who('ownerRole'),
        {
          method: 'crypto',
          reason: 'typo',
        },
      ).expect(400);
      expect(unknown.body).toMatchObject({ code: 'COLLECTION_METHOD_UNKNOWN', field: 'method' });
    });
  });
});

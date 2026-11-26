import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../src/generated/prisma/client';
import { addDays, todayIn } from '../src/core/common/business-time';
import { StockLedger } from '../src/modules/dealership/stock/stock-ledger';
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

interface PurchaseBody {
  id: string;
  code: string;
  purchaseDate: string;
  status: string;
  totalQuantity: string;
  totalAmount?: string;
  version: number;
  note: string | null;
  voidReason: string | null;
  items: { id: string; quantity: string; unitPrice?: string; lineTotal?: string }[];
}
interface Impact {
  key: string;
  before?: unknown;
  after?: unknown;
  delta?: string;
}
interface RequestBody {
  id: string;
  status: string;
  impact: Impact[] | null;
  isStale: boolean;
}

const TODAY = todayIn('Asia/Dhaka');
const periodOf = (date: string) => Number(date.slice(0, 4) + date.slice(5, 7));
const LAST_MONTH_END = addDays(`${TODAY.slice(0, 8)}01`, -1);

describe.skipIf(!hasDatabase)('voiding and correcting purchases', () => {
  let t: TestApp;
  let data: TestData;
  let shop: { id: string; slug: string };
  const as: Record<string, Cookies> = {};
  let categoryId: string;

  const who = (name: string) => as[name] ?? {};
  const path = (suffix: string) => `/b/${shop.slug}/${suffix}`;

  async function member(name: string, roleKey: string | null) {
    const user = await data.createUser({ name, isPlatformOwner: roleKey === null });
    if (roleKey) {
      await data.giveAccess(user.id, shop.id, roleKey);
    }
    as[name] = (await login(t.server, user.email ?? '', user.password)).cookies;
  }

  const newProduct = async () =>
    (
      (
        await send(t.server, 'post', path('products'), who('owner'), {
          categoryId,
          nameEn: `Cement ${String(Math.random()).slice(2, 10)}`,
          nameBn: 'সিমেন্ট',
        }).expect(201)
      ).body as { id: string }
    ).id;

  const buy = async (
    items: { productId: string; quantity: string; unitPrice: string }[],
    extra: object = {},
  ) =>
    (
      await send(t.server, 'post', path('purchases'), who('ownerRole'), { items, ...extra }).expect(
        201,
      )
    ).body as PurchaseBody;

  const requestChange = (who_: string, body: object) =>
    request(t.server)
      .post(`/api/v1${path('change-requests')}`)
      .set('Cookie', cookieHeader(who(who_)))
      .send(body);

  const decide = (who_: string, id: string, action: string, body?: object) =>
    send(t.server, 'post', path(`change-requests/${id}/${action}`), who(who_), body);

  async function product(productId: string) {
    const row = await t.prisma.forBusiness(shop.id).product.findUniqueOrThrow({
      where: { id: productId },
      select: { currentStock: true, lastPurchasePrice: true },
    });
    return {
      stock: row.currentStock.toString(),
      lastPrice: row.lastPurchasePrice?.toFixed(2) ?? null,
    };
  }

  async function counter(period: number) {
    const row = await t.prisma
      .forBusiness(shop.id)
      .monthlyPurchaseCounter.findFirst({ where: { period }, select: { quantity: true } });
    return Number(row?.quantity.toString() ?? '0');
  }

  /** The general-ledger entries mirroring one purchase, oldest first. */
  async function ledgerEntries(purchaseId: string) {
    return t.prisma.forBusiness(shop.id).businessLedgerEntry.findMany({
      where: { referenceType: 'purchase', referenceId: purchaseId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { amount: true, entryDate: true, status: true, type: true, direction: true },
    });
  }

  async function movements(sourceId: string) {
    return t.prisma.forBusiness(shop.id).stockMovement.findMany({
      where: { sourceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { kind: true, quantity: true, movementDate: true, reason: true },
    });
  }

  /** Take stock out (as a delivery will in Step 5b), through the ledger itself. */
  async function takeOut(productId: string, quantity: string) {
    const actor = await t.prisma.client.user.findFirstOrThrow({
      where: { access: { some: { businessId: shop.id } } },
      select: { id: true },
    });
    await t.prisma.forBusiness(shop.id).$transaction((tx) =>
      t.app.get(StockLedger).apply(tx, shop.id, actor.id, [
        {
          productId,
          quantity: new Prisma.Decimal(quantity).negated(),
          kind: 'adjustment',
          movementDate: TODAY,
          sourceType: 'adjustment',
          sourceId: null,
          reason: 'test: stock taken out',
        },
      ]),
    );
  }

  async function expectConsistent() {
    const rows = await t.prisma.client.$queryRawUnsafe<{ stock: string; total: string | null }[]>(
      `SELECT p.current_stock::text AS stock,
              (SELECT sum(m.quantity)::text FROM stock_movements m
                WHERE m.business_id = p.business_id AND m.product_id = p.id) AS total
         FROM products p WHERE p.business_id = $1::uuid`,
      shop.id,
    );
    for (const row of rows) {
      expect(Number(row.total ?? 0)).toBe(Number(row.stock));
    }
  }

  beforeAll(async () => {
    await runSeed(); // roles must exist before a business gets its default grants
    t = await createTestApp();
    data = new TestData(t);
    shop = await data.createBusiness('buy-changes');
    await runSeed();
    await member('owner', null);
    await member('ownerRole', 'owner');
    await member('manager', 'manager');
    await member('salesman', 'salesman');
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
    await expectConsistent();
    await data.cleanup();
    await t.app.close();
  });

  describe('void', () => {
    it('reverses stock on the void date, takes the bags off the purchase month, recomputes the last price', async () => {
      const opc = await newProduct();
      await buy([{ productId: opc, quantity: '100', unitPrice: '560' }], {
        purchaseDate: addDays(TODAY, -3),
      });
      // The newest purchase is dated last month (owner may backdate).
      const purchase = await buy([{ productId: opc, quantity: '50', unitPrice: '575' }], {
        purchaseDate: TODAY,
      });
      const old = await buy([{ productId: opc, quantity: '20', unitPrice: '540' }], {
        purchaseDate: LAST_MONTH_END,
      });
      expect(await product(opc)).toEqual({ stock: '170', lastPrice: '575.00' });
      const lastMonthBefore = await counter(periodOf(LAST_MONTH_END));

      const voided = await send(
        t.server,
        'post',
        path(`purchases/${purchase.id}/void`),
        who('ownerRole'),
        {
          reason: 'Entered twice by mistake',
        },
      ).expect(200);
      expect(voided.body).toMatchObject({ status: 'void', voidReason: 'Entered twice by mistake' });
      expect(await product(opc)).toEqual({ stock: '120', lastPrice: '560.00' });
      const reversal = (await movements(purchase.id)).at(-1);
      expect(reversal).toMatchObject({ kind: 'purchase_void', reason: 'Entered twice by mistake' });
      expect(reversal?.quantity.toString()).toBe('-50');
      expect(reversal?.movementDate.toISOString().slice(0, 10)).toBe(TODAY);

      // A purchase from last month is taken off last month's counter, voided today.
      await send(t.server, 'post', path(`purchases/${old.id}/void`), who('ownerRole'), {
        reason: 'Wrong supplier paper',
      }).expect(200);
      expect(await counter(periodOf(LAST_MONTH_END))).toBe(lastMonthBefore - 20);
      const oldReversal = (await movements(old.id)).at(-1);
      expect(oldReversal?.movementDate.toISOString().slice(0, 10)).toBe(TODAY);

      const again = await send(
        t.server,
        'post',
        path(`purchases/${purchase.id}/void`),
        who('ownerRole'),
        {
          reason: 'again',
        },
      ).expect(409);
      expect(again.body).toMatchObject({ code: 'PURCHASE_ALREADY_VOID' });
      await expectConsistent();
    });

    it('sets the last purchase price to null when no valid purchase is left', async () => {
      const opc = await newProduct();
      const only = await buy([{ productId: opc, quantity: '5', unitPrice: '570' }]);
      await send(t.server, 'post', path(`purchases/${only.id}/void`), who('ownerRole'), {
        reason: 'Cancelled order',
      }).expect(200);
      expect(await product(opc)).toEqual({ stock: '0', lastPrice: null });
    });

    it('refuses a void that would take stock below zero, and changes nothing', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '100', unitPrice: '570' }]);
      await takeOut(opc, '80');
      const refused = await send(
        t.server,
        'post',
        path(`purchases/${purchase.id}/void`),
        who('ownerRole'),
        {
          reason: 'Wrong entry',
        },
      ).expect(409);
      expect(refused.body).toMatchObject({
        code: 'STOCK_INSUFFICIENT',
        details: { productId: opc, available: '20', required: '100' },
      });
      expect(await product(opc)).toEqual({ stock: '20', lastPrice: '570.00' });
      const detail = await get(t.server, path(`purchases/${purchase.id}`), who('manager')).expect(
        200,
      );
      expect((detail.body as PurchaseBody).status).toBe('active');
      // The same through a request: refused when asking, too.
      const asked = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'void',
        reason: 'Wrong entry',
      }).expect(409);
      expect(asked.body).toMatchObject({ code: 'STOCK_INSUFFICIENT' });
    });

    it('lets the manager ask for a void that the owner approves; staff cannot void directly', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '40', unitPrice: '570' }]);
      await send(t.server, 'post', path(`purchases/${purchase.id}/void`), who('manager'), {
        reason: 'mine',
      }).expect(403);
      await requestChange('salesman', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'void',
        reason: 'no access',
      }).expect(403);
      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'void',
        reason: 'Akij cancelled the delivery',
      }).expect(201);
      const body = created.body as RequestBody & { summary: string };
      expect(body.summary).toBe('Void purchase');
      const keys = (body.impact ?? []).map((line) => line.key);
      expect(keys).toContain(`stock.${opc}`);
      expect(keys).toContain('purchase.totalAmount');
      // Commission progress stays owner-only.
      expect(keys.some((key) => key.startsWith('purchaseCounter.'))).toBe(false);
      const forOwner = await get(t.server, path(`change-requests/${body.id}`), who('owner')).expect(
        200,
      );
      expect(
        ((forOwner.body as RequestBody).impact ?? []).some((line) =>
          line.key.startsWith('purchaseCounter.'),
        ),
      ).toBe(true);

      await decide('ownerRole', body.id, 'approve').expect(200);
      expect((await product(opc)).stock).toBe('0');
      const after = await get(t.server, path(`purchases/${purchase.id}`), who('manager')).expect(
        200,
      );
      expect((after.body as PurchaseBody).status).toBe('void');
    });
  });

  describe('edit', () => {
    it('moves stock by the difference on the edit date and recomputes totals and counters', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '100', unitPrice: '570' }]);
      const item = purchase.items[0]?.id ?? '';
      const period = periodOf(TODAY);
      const before = await counter(period);

      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'Akij paper says 90 bags at 565',
        proposedChange: {
          [`items.${item}.quantity`]: '90',
          [`items.${item}.unitPrice`]: '565',
        },
      }).expect(201);
      const impact = (created.body as RequestBody).impact ?? [];
      expect(impact.find((line) => line.key === `stock.${opc}`)).toMatchObject({
        before: '100',
        after: '90',
        delta: '-10',
      });
      expect(impact.find((line) => line.key === 'purchase.totalAmount')).toMatchObject({
        before: '57000.00',
        after: '50850.00',
      });
      expect(impact.find((line) => line.key === `lastPurchasePrice.${opc}`)).toMatchObject({
        before: '570.00',
        after: '565.00',
      });

      await decide('owner', (created.body as RequestBody).id, 'approve').expect(200);
      const after = (
        await get(t.server, path(`purchases/${purchase.id}`), who('manager')).expect(200)
      ).body as PurchaseBody;
      expect(after).toMatchObject({ totalQuantity: '90', totalAmount: '50850.00', version: 2 });
      expect(after.items[0]).toMatchObject({
        quantity: '90',
        unitPrice: '565.00',
        lineTotal: '50850.00',
      });
      expect(await product(opc)).toEqual({ stock: '90', lastPrice: '565.00' });
      expect(await counter(period)).toBe(before - 10);
      const edit = (await movements(purchase.id)).at(-1);
      expect(edit).toMatchObject({
        kind: 'purchase_edit',
        reason: 'Akij paper says 90 bags at 565',
      });
      expect(edit?.quantity.toString()).toBe('-10');
      expect(edit?.movementDate.toISOString().slice(0, 10)).toBe(TODAY);
    });

    it('restates the purchase ledger entry, so Accounts stops showing the old amount', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '100', unitPrice: '570' }]);
      const item = purchase.items[0]?.id ?? '';
      expect(await ledgerEntries(purchase.id)).toMatchObject([
        { amount: new Prisma.Decimal('57000.00'), status: 'active', direction: 'out' },
      ]);

      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'Akij paper says 90 bags at 565',
        proposedChange: {
          [`items.${item}.quantity`]: '90',
          [`items.${item}.unitPrice`]: '565',
        },
      }).expect(201);
      await decide('owner', (created.body as RequestBody).id, 'approve').expect(200);

      // One row, restated in place — never a second entry for the same purchase.
      const entries = await ledgerEntries(purchase.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.amount.toString()).toBe('50850');
      expect(entries[0]?.status).toBe('active');
    });

    it('moves the ledger entry to the new month when the purchase date moves', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '10', unitPrice: '100' }]);
      const lastMonth = addDays(TODAY, -40);

      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'the challan is dated last month',
        proposedChange: { purchaseDate: lastMonth },
      }).expect(201);
      await decide('owner', (created.body as RequestBody).id, 'approve').expect(200);

      const entries = await ledgerEntries(purchase.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.entryDate.toISOString().slice(0, 10)).toBe(lastMonth);
      // The amount did not change, only the month it counts in.
      expect(entries[0]?.amount.toString()).toBe('1000');
    });

    it('agrees with the cash book after an edit (both read the corrected amount)', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '20', unitPrice: '500' }]);
      const item = purchase.items[0]?.id ?? '';

      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'price corrected to 450',
        proposedChange: { [`items.${item}.unitPrice`]: '450' },
      }).expect(201);
      await decide('owner', (created.body as RequestBody).id, 'approve').expect(200);

      // A price-only edit moves no stock, so this is exactly the case that used
      // to leave the ledger stale.
      const entries = await ledgerEntries(purchase.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.amount.toString()).toBe('9000');
    });

    it('previews only the lines that change on a purchase with several lines', async () => {
      const opc = await newProduct();
      const pcc = await newProduct();
      const purchase = await buy([
        { productId: opc, quantity: '500', unitPrice: '570' },
        { productId: pcc, quantity: '200', unitPrice: '545.50' },
      ]);
      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'Challan says 490',
        proposedChange: { [`items.${purchase.items[0]?.id ?? ''}.quantity`]: '490' },
      }).expect(201);
      const impact = (created.body as RequestBody).impact ?? [];
      expect(impact.filter((line) => line.key.startsWith('stock.'))).toEqual([
        expect.objectContaining({ key: `stock.${opc}`, before: '500', after: '490', delta: '-10' }),
      ]);
      expect(impact.find((line) => line.key === 'purchase.totalAmount')).toMatchObject({
        before: '394100.00',
        after: '388400.00',
      });
      await decide('owner', (created.body as RequestBody).id, 'approve').expect(200);
      expect((await product(opc)).stock).toBe('490');
      expect((await product(pcc)).stock).toBe('200');
    });

    it('moves the bags to the new month when the date changes month', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '60', unitPrice: '570' }]);
      const thisMonth = await counter(periodOf(TODAY));
      const lastMonth = await counter(periodOf(LAST_MONTH_END));
      await send(t.server, 'patch', path(`purchases/${purchase.id}`), who('ownerRole'), {
        purchaseDate: LAST_MONTH_END,
        reason: 'Bought on the last day of last month',
      }).expect(200);
      expect(await counter(periodOf(TODAY))).toBe(thisMonth - 60);
      expect(await counter(periodOf(LAST_MONTH_END))).toBe(lastMonth + 60);
      // No stock moves for a date change.
      expect((await movements(purchase.id)).map((row) => row.kind)).toEqual(['purchase']);
      expect((await product(opc)).stock).toBe('60');
    });

    it('refuses a correction that would take stock below zero', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '50', unitPrice: '570' }]);
      await takeOut(opc, '45');
      const refused = await send(
        t.server,
        'patch',
        path(`purchases/${purchase.id}`),
        who('ownerRole'),
        {
          items: [{ id: purchase.items[0]?.id, quantity: '1' }],
          reason: 'Only one bag came',
        },
      ).expect(409);
      expect(refused.body).toMatchObject({
        code: 'STOCK_INSUFFICIENT',
        field: `items.${purchase.items[0]?.id ?? ''}.quantity`,
      });
      expect((await product(opc)).stock).toBe('5');
    });

    it('applies the direct-edit permission per field', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '10', unitPrice: '570' }]);
      const patch = (who_: string, body: object) =>
        send(t.server, 'patch', path(`purchases/${purchase.id}`), who(who_), body);
      // A note needs only purchase.create and no reason.
      const noted = await patch('manager', { note: 'Truck 12' }).expect(200);
      expect((noted.body as PurchaseBody).note).toBe('Truck 12');
      await patch('manager', {
        items: [{ id: purchase.items[0]?.id, quantity: '9' }],
        reason: 'less',
      }).expect(403);
      const reason = await patch('ownerRole', {
        items: [{ id: purchase.items[0]?.id, quantity: '9' }],
      }).expect(400);
      expect(reason.body).toMatchObject({ code: 'REASON_REQUIRED', field: 'reason' });
      const unknown = await patch('ownerRole', {
        items: [{ id: '00000000-0000-7000-8000-000000000000', quantity: '9' }],
        reason: 'wrong line',
      }).expect(400);
      expect(unknown.body).toMatchObject({ code: 'FIELD_NOT_CHANGEABLE' });
      const future = await patch('ownerRole', {
        purchaseDate: addDays(TODAY, 1),
        reason: 'typo',
      }).expect(400);
      expect(future.body).toMatchObject({ code: 'PURCHASE_DATE_IN_FUTURE', field: 'purchaseDate' });
      await patch('ownerRole', { note: 'Truck 12' }).expect(400); // nothing to change
    });

    it('marks a pending request stale after a direct change', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '10', unitPrice: '570' }]);
      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'Price was 568',
        proposedChange: { [`items.${purchase.items[0]?.id ?? ''}.unitPrice`]: '568' },
      }).expect(201);
      await send(t.server, 'patch', path(`purchases/${purchase.id}`), who('ownerRole'), {
        items: [{ id: purchase.items[0]?.id, quantity: '11' }],
        reason: 'One extra bag',
      }).expect(200);
      const stale = await decide('owner', (created.body as RequestBody).id, 'approve').expect(409);
      expect(stale.body).toMatchObject({ code: 'STALE_REQUEST' });
      // A void purchase cannot be corrected.
      await send(t.server, 'post', path(`purchases/${purchase.id}/void`), who('ownerRole'), {
        reason: 'Wrong entry',
      }).expect(200);
      const voided = await send(
        t.server,
        'patch',
        path(`purchases/${purchase.id}`),
        who('ownerRole'),
        {
          note: 'late note',
        },
      ).expect(409);
      expect(voided.body).toMatchObject({ code: 'PURCHASE_ALREADY_VOID' });
    });

    it('hides unit prices in requests from viewers without product.cost.view', async () => {
      const opc = await newProduct();
      const purchase = await buy([{ productId: opc, quantity: '10', unitPrice: '570' }]);
      const created = await requestChange('manager', {
        entityType: 'purchase',
        entityId: purchase.id,
        kind: 'edit',
        reason: 'Price and quantity',
        proposedChange: {
          [`items.${purchase.items[0]?.id ?? ''}.unitPrice`]: '569',
          [`items.${purchase.items[0]?.id ?? ''}.quantity`]: '12',
        },
      }).expect(201);
      const matrix = await get(t.server, path('roles/permissions'), who('owner')).expect(200);
      const salesman =
        (matrix.body as { roles: { key: string; permissions: string[] }[] }).roles.find(
          (role) => role.key === 'salesman',
        )?.permissions ?? [];
      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: [...salesman, 'change.view.all', 'purchase.view'],
      }).expect(200);
      const seen = await get(
        t.server,
        path(`change-requests/${(created.body as RequestBody).id}`),
        who('salesman'),
      ).expect(200);
      const text = JSON.stringify(seen.body);
      expect(text).not.toContain('569.00');
      expect(text).not.toContain('570.00');
      expect(text).toContain('Line quantity: 10 → 12');
      await send(t.server, 'put', path('roles/salesman/permissions'), who('owner'), {
        permissions: salesman,
      }).expect(200);
    });
  });
});

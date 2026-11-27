import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  ChangeContext,
  ChangeHandler,
  ChangeValues,
  FieldRule,
  ImpactLine,
  LoadedRecord,
  ProposedChange,
} from '../../../core/approvals/change-handler';
import { fromDbDate, isCalendarDate, toDbDate, todayIn } from '../../../core/common/business-time';
import { MONEY_PATTERN, moneyString, toDecimal } from '../../../core/common/money';
import { lockRows } from '../../../core/database/row-lock';
import { badRequest, conflict } from '../../../core/errors';
import { DealershipConfig, parseDealershipConfig } from '../dealership.config';
import { DEALERSHIP_TYPE } from '../dealership.permissions';
import { QUANTITY_PATTERN } from '../purchases/dto/requests';
import { fitsUnit, lineTotalOf } from '../purchases/purchases.service';
import { StockLedger, quantityString } from '../stock/stock-ledger';
import { VALUE_SCALE } from '../stock/inventory-cost';
import { BusinessLedgerService } from '../accounts/business-ledger.service';
import { CustomerAccounts } from './customer-accounts';
import { tooMuch } from './deliveries.service';
import { DELIVERY_WINDOWS, deliveryStatusOf, signedMoney, signedQuantity } from './sales.common';

const ZERO = new Prisma.Decimal(0);
const ITEM_FIELD = /^items\.([0-9a-f-]{36})\.(quantity|unitPrice)$/;

async function configOf(
  tx: Prisma.TransactionClient,
  businessId: string,
): Promise<DealershipConfig> {
  const business = await tx.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { config: true },
  });
  return parseDealershipConfig(business.config);
}

function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((total, value) => total.add(value), ZERO);
}

function text(
  ctx: ChangeContext,
  key: string,
  value: unknown,
  limit: number,
  code: string,
): string | null {
  if (value !== null && (typeof value !== 'string' || value.trim().length > limit)) {
    throw badRequest(
      code,
      `${key} must be text of at most ${String(limit)} characters`,
      `${ctx.fieldPrefix}${key}`,
    );
  }
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function date(
  ctx: ChangeContext,
  key: string,
  value: unknown,
  subject: string,
  timezone: string,
  earliest?: string,
): string {
  const field = `${ctx.fieldPrefix}${key}`;
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    throw badRequest(`${subject}_INVALID`, 'Not a real date', field);
  }
  if (value > todayIn(timezone)) {
    throw badRequest(`${subject}_IN_FUTURE`, 'The date cannot be in the future', field);
  }
  if (earliest !== undefined && value < earliest) {
    throw badRequest(`${subject}_INVALID`, `The date cannot be before ${earliest}`, field);
  }
  return value;
}

// =============================================================================
// Orders
// =============================================================================

interface OrderLine {
  id: string;
  productId: string;
  productCode: string;
  decimals: number;
  quantity: Prisma.Decimal;
  delivered: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
}

interface OrderState {
  id: string;
  status: string;
  customerId: string;
  orderDate: string;
  firstDeliveryDate: string | null;
  activeDeliveries: number;
  timezone: string;
  lines: OrderLine[];
}

const ORDER_FIELDS: Record<string, FieldRule> = {
  orderDate: { label: 'Order date', directPermission: 'sale.edit' },
  deliveryWindow: { label: 'Delivery window', directPermission: 'sale.edit' },
  deliverBy: { label: 'Deliver by', directPermission: 'sale.edit' },
  note: { label: 'Note', directPermission: 'sale.edit' },
};

/**
 * Orders: void only with no active delivery (void those first). Edit the
 * lines' quantities (never below what was delivered) and prices, the dates,
 * window and note. A price change re-prices what was already delivered: the
 * delivery lines, the customer's balance and a ledger line per delivery, dated
 * the day of the change.
 */
@Injectable()
export class SalesOrderChangeHandler implements ChangeHandler {
  readonly entityType = 'sales_order';
  readonly businessTypes = [DEALERSHIP_TYPE];
  readonly viewPermission = 'sale.view.all';
  readonly fields = ORDER_FIELDS;
  readonly void = { label: 'Void order', directPermission: 'sale.void' };
  private readonly states = new WeakMap<LoadedRecord, OrderState>();

  constructor(private readonly accounts: CustomerAccounts) {}

  fieldRule(key: string): FieldRule | undefined {
    const match = ITEM_FIELD.exec(key);
    if (!match) return undefined;
    return match[2] === 'quantity'
      ? { label: 'Line quantity', directPermission: 'sale.edit' }
      : { label: 'Line unit price', directPermission: 'sale.edit' };
  }

  async load(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    options: { forUpdate: boolean },
  ) {
    if (options.forUpdate) await lockRows(tx, 'sales_orders', ctx.businessId, [id]);
    const [order, config] = await Promise.all([
      tx.salesOrder.findUnique({
        where: { id },
        select: {
          id: true,
          code: true,
          status: true,
          customerId: true,
          orderDate: true,
          deliveryWindow: true,
          deliverBy: true,
          note: true,
          version: true,
          items: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              productId: true,
              quantity: true,
              deliveredQuantity: true,
              unitPrice: true,
              product: { select: { code: true, unitKey: true } },
            },
          },
          deliveries: {
            where: { status: 'active' },
            orderBy: { deliveryDate: 'asc' },
            select: { deliveryDate: true },
          },
        },
      }),
      configOf(tx, ctx.businessId),
    ]);
    if (!order) return null;
    const decimalsOf = new Map(config.units.map((unit) => [unit.key, unit.decimals]));
    const state: OrderState = {
      id: order.id,
      status: order.status,
      customerId: order.customerId,
      orderDate: fromDbDate(order.orderDate),
      firstDeliveryDate: order.deliveries[0] ? fromDbDate(order.deliveries[0].deliveryDate) : null,
      activeDeliveries: order.deliveries.length,
      timezone: config.timezone,
      lines: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productCode: item.product.code,
        decimals: decimalsOf.get(item.product.unitKey) ?? 0,
        quantity: item.quantity,
        delivered: item.deliveredQuantity,
        unitPrice: item.unitPrice,
      })),
    };
    const values: ChangeValues = {
      status: order.status,
      orderDate: state.orderDate,
      deliveryWindow: order.deliveryWindow,
      deliverBy: order.deliverBy ? fromDbDate(order.deliverBy) : null,
      note: order.note,
    };
    for (const line of state.lines) {
      values[`items.${line.id}.quantity`] = quantityString(line.quantity);
      values[`items.${line.id}.unitPrice`] = moneyString(line.unitPrice);
    }
    const record: LoadedRecord = {
      version: order.version,
      label: `${order.code} (${state.orderDate})`,
      values,
    };
    this.states.set(record, state);
    return record;
  }

  validateEdit(ctx: ChangeContext, current: LoadedRecord, proposed: ChangeValues): ChangeValues {
    const state = this.stateOf(current);
    if (state.status === 'void') throw conflict('ORDER_ALREADY_VOID', 'This order is void');
    const values: ChangeValues = {};
    const orderDate =
      'orderDate' in proposed
        ? date(ctx, 'orderDate', proposed['orderDate'], 'ORDER_DATE', state.timezone)
        : state.orderDate;
    if (state.firstDeliveryDate && orderDate > state.firstDeliveryDate) {
      throw badRequest(
        'ORDER_DATE_INVALID',
        'The order date cannot be after its first delivery',
        `${ctx.fieldPrefix}orderDate`,
      );
    }
    for (const [key, value] of Object.entries(proposed)) {
      const field = `${ctx.fieldPrefix}${key}`;
      if (key === 'orderDate') {
        values[key] = orderDate;
      } else if (key === 'deliveryWindow') {
        if (typeof value !== 'string' || !(DELIVERY_WINDOWS as readonly string[]).includes(value)) {
          throw badRequest('DELIVERY_WINDOW_INVALID', 'Use today, two_days or one_week', field);
        }
        values[key] = value;
      } else if (key === 'deliverBy') {
        if (
          value !== null &&
          (typeof value !== 'string' || !isCalendarDate(value) || value < orderDate)
        ) {
          throw badRequest(
            'DELIVER_BY_INVALID',
            'deliverBy must be a real date on or after the order date',
            field,
          );
        }
        values[key] = value;
      } else if (key === 'note') {
        values[key] = text(ctx, key, value, 500, 'NOTE_INVALID');
      } else {
        const match = ITEM_FIELD.exec(key);
        const line = match ? state.lines.find((candidate) => candidate.id === match[1]) : undefined;
        if (!match || !line) {
          throw badRequest('FIELD_NOT_CHANGEABLE', `Field "${key}" cannot be changed`, field);
        }
        if (match[2] === 'quantity') {
          const quantity =
            typeof value === 'string' && QUANTITY_PATTERN.test(value) ? toDecimal(value) : null;
          if (!quantity || !fitsUnit(quantity, line.decimals)) {
            throw badRequest(
              'QUANTITY_INVALID',
              'Quantity must be above zero and fit the product’s unit',
              field,
            );
          }
          if (quantity.lessThan(line.delivered)) {
            throw badRequest(
              'ORDER_QUANTITY_TOO_SMALL',
              `Already ${quantityString(line.delivered)} delivered on this line`,
              field,
            );
          }
          values[key] = quantityString(quantity);
        } else {
          if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
            throw badRequest(
              'UNIT_PRICE_INVALID',
              'unitPrice must be an amount like "570.50" (as a string)',
              field,
            );
          }
          values[key] = moneyString(toDecimal(value));
        }
      }
    }
    return values;
  }

  validateVoid(
    _tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
  ): Promise<void> {
    const state = this.stateOf(current);
    if (state.status === 'void') throw conflict('ORDER_ALREADY_VOID', 'This order is already void');
    if (state.activeDeliveries > 0) {
      throw conflict('DELIVERY_EXISTS', 'Void the order’s deliveries first');
    }
    return Promise.resolve();
  }

  async preview(
    tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
    change: ProposedChange,
  ) {
    const state = this.stateOf(current);
    const lines: ImpactLine[] = [];
    if (change.kind === 'void') {
      const remaining = sum(state.lines.map((line) => line.quantity.sub(line.delivered)));
      if (!remaining.isZero()) {
        lines.push({
          key: 'customer.pendingDeliveryQuantity',
          label: 'Still to deliver',
          delta: signedQuantity(remaining.negated()),
        });
      }
      return lines;
    }
    const next = this.next(state, change.values);
    const totalBefore = sum(state.lines.map((line) => lineTotalOf(line.quantity, line.unitPrice)));
    const totalAfter = sum(
      state.lines.map((line) => lineTotalOf(next.quantity(line), next.price(line))),
    );
    if (!totalBefore.equals(totalAfter)) {
      lines.push({
        key: 'order.totalAmount',
        label: 'Order total',
        before: totalBefore.toFixed(2),
        after: totalAfter.toFixed(2),
        delta: signedMoney(totalAfter.sub(totalBefore)),
      });
    }
    const pending = sum(state.lines.map((line) => next.quantity(line).sub(line.quantity)));
    if (!pending.isZero()) {
      lines.push({
        key: 'customer.pendingDeliveryQuantity',
        label: 'Still to deliver',
        delta: signedQuantity(pending),
      });
    }
    const repriced = await this.repricing(tx, state, next.price);
    const balanceDelta = sum(repriced.map((row) => row.delta));
    if (!balanceDelta.isZero()) {
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: state.customerId },
        select: { currentBalance: true },
      });
      lines.push({
        key: 'customer.currentBalance',
        label: 'Customer balance (delivered part re-priced)',
        before: moneyString(customer.currentBalance),
        after: moneyString(customer.currentBalance.add(balanceDelta)),
        delta: signedMoney(balanceDelta),
        visibleWith: 'customer.due.view',
      });
    }
    return lines;
  }

  async applyEdit(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    values: ChangeValues,
  ) {
    const state = this.stateOf(current);
    const next = this.next(state, values);
    const today = todayIn(state.timezone);
    await Promise.all(
      state.lines
        .filter(
          (line) =>
            !next.quantity(line).equals(line.quantity) || !next.price(line).equals(line.unitPrice),
        )
        .map((line) =>
          tx.salesOrderItem.update({
            where: { id: line.id },
            data: {
              quantity: next.quantity(line),
              unitPrice: next.price(line),
              lineTotal: lineTotalOf(next.quantity(line), next.price(line)),
            },
          }),
        ),
    );
    const totalQuantity = sum(state.lines.map((line) => next.quantity(line)));
    const delivered = sum(state.lines.map((line) => line.delivered));
    await tx.salesOrder.update({
      where: { id },
      data: {
        ...('orderDate' in values ? { orderDate: toDbDate(String(values['orderDate'])) } : {}),
        ...('deliveryWindow' in values ? { deliveryWindow: String(values['deliveryWindow']) } : {}),
        ...('deliverBy' in values
          ? {
              deliverBy:
                values['deliverBy'] === null ? null : toDbDate(String(values['deliverBy'])),
            }
          : {}),
        ...('note' in values ? { note: values['note'] as string | null } : {}),
        totalQuantity,
        totalAmount: sum(
          state.lines.map((line) => lineTotalOf(next.quantity(line), next.price(line))),
        ),
        deliveryStatus: deliveryStatusOf(delivered, totalQuantity),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
    // Re-price what was delivered: delivery lines, delivery totals, balance, ledger.
    const repriced = await this.repricing(tx, state, next.price);
    for (const row of repriced) {
      await Promise.all(
        row.items.map((item) =>
          tx.deliveryItem.update({
            where: { id: item.id },
            data: { unitPrice: item.unitPrice, lineTotal: item.lineTotal },
          }),
        ),
      );
      await tx.delivery.update({
        where: { id: row.deliveryId },
        data: {
          totalAmount: { increment: row.delta },
          version: { increment: 1 },
          updatedBy: ctx.actorUserId,
        },
      });
      await this.accounts.move(tx, ctx.businessId, ctx.actorUserId, state.customerId, {
        delivered: row.delta,
        ledger: {
          kind: 'delivery_edit',
          entryDate: today,
          sourceType: 'delivery',
          sourceId: row.deliveryId,
          reason: ctx.reason || 'Order price corrected',
        },
      });
    }
    const pending = totalQuantity.sub(sum(state.lines.map((line) => line.quantity)));
    await this.accounts.move(tx, ctx.businessId, ctx.actorUserId, state.customerId, { pending });
  }

  async applyVoid(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    reason: string,
  ) {
    const state = this.stateOf(current);
    await this.validateVoid(tx, ctx, current);
    await tx.salesOrder.update({
      where: { id },
      data: {
        status: 'void',
        voidedAt: new Date(),
        voidedBy: ctx.actorUserId,
        voidReason: reason,
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
    const remaining = sum(state.lines.map((line) => line.quantity.sub(line.delivered)));
    await this.accounts.move(tx, ctx.businessId, ctx.actorUserId, state.customerId, {
      pending: remaining.negated(),
    });
  }

  private next(_state: OrderState, values: ChangeValues) {
    const quantities = new Map<string, Prisma.Decimal>();
    const prices = new Map<string, Prisma.Decimal>();
    for (const [key, value] of Object.entries(values)) {
      const match = ITEM_FIELD.exec(key);
      if (match && typeof value === 'string') {
        (match[2] === 'quantity' ? quantities : prices).set(match[1] ?? '', toDecimal(value));
      }
    }
    return {
      quantity: (line: OrderLine) => quantities.get(line.id) ?? line.quantity,
      price: (line: OrderLine) => prices.get(line.id) ?? line.unitPrice,
    };
  }

  /** Active delivery lines of re-priced order lines, with their new totals, by delivery. */
  private async repricing(
    tx: Prisma.TransactionClient,
    state: OrderState,
    price: (line: OrderLine) => Prisma.Decimal,
  ) {
    const changed = state.lines.filter(
      (line) => !price(line).equals(line.unitPrice) && line.delivered.greaterThan(0),
    );
    if (changed.length === 0) return [];
    const items = await tx.deliveryItem.findMany({
      where: { orderItemId: { in: changed.map((line) => line.id) }, status: 'active' },
      select: { id: true, deliveryId: true, orderItemId: true, quantity: true, lineTotal: true },
    });
    const byDelivery = new Map<
      string,
      {
        deliveryId: string;
        delta: Prisma.Decimal;
        items: { id: string; unitPrice: Prisma.Decimal; lineTotal: Prisma.Decimal }[];
      }
    >();
    for (const item of items) {
      const line = changed.find((candidate) => candidate.id === item.orderItemId);
      if (!line) continue;
      const unitPrice = price(line);
      const lineTotal = lineTotalOf(item.quantity, unitPrice);
      const entry = byDelivery.get(item.deliveryId) ?? {
        deliveryId: item.deliveryId,
        delta: ZERO,
        items: [],
      };
      entry.delta = entry.delta.add(lineTotal.sub(item.lineTotal));
      entry.items.push({ id: item.id, unitPrice, lineTotal });
      byDelivery.set(item.deliveryId, entry);
    }
    return [...byDelivery.values()].filter((row) => !row.delta.isZero() || row.items.length > 0);
  }

  private stateOf(record: LoadedRecord): OrderState {
    const state = this.states.get(record);
    if (!state) throw new Error('SalesOrderChangeHandler: record was not loaded by this handler');
    return state;
  }
}

// =============================================================================
// Deliveries
// =============================================================================

interface DeliveryLine {
  id: string;
  orderItemId: string;
  productId: string;
  productCode: string;
  unitKey: string;
  decimals: number;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  /** Most this line may hold: what the order line still allows plus this line's quantity. */
  capacity: Prisma.Decimal;
  /** What these bags cost when they left, so a return puts back the same value. */
  unitCost: Prisma.Decimal | null;
  costAmount: Prisma.Decimal | null;
  /** The part of this line that left with no cost basis. */
  uncostedQuantity: Prisma.Decimal;
}

interface DeliveryState {
  id: string;
  status: string;
  orderId: string;
  customerId: string;
  orderDate: string;
  orderTotal: Prisma.Decimal;
  orderDelivered: Prisma.Decimal;
  timezone: string;
  lines: DeliveryLine[];
}

const DELIVERY_FIELDS: Record<string, FieldRule> = {
  deliveryDate: { label: 'Delivery date', directPermission: 'delivery.edit' },
  transportReference: { label: 'Transport reference', directPermission: 'delivery.edit' },
  note: { label: 'Note', directPermission: 'delivery.edit' },
};

/**
 * Deliveries: void returns the stock (dated the day of the void), takes the
 * value off the balance (ledger reversal) and gives the bags back to the
 * order. Edit changes a line's quantity: stock, the order's delivered bags,
 * the balance and ledger move by the difference, dated the day of the edit.
 */
@Injectable()
export class DeliveryChangeHandler implements ChangeHandler {
  readonly entityType = 'delivery';
  readonly businessTypes = [DEALERSHIP_TYPE];
  readonly viewPermission = 'delivery.view';
  readonly fields = DELIVERY_FIELDS;
  readonly void = { label: 'Void delivery', directPermission: 'delivery.void' };
  private readonly states = new WeakMap<LoadedRecord, DeliveryState>();

  constructor(
    private readonly ledger: StockLedger,
    private readonly accounts: CustomerAccounts,
  ) {}

  fieldRule(key: string): FieldRule | undefined {
    const match = ITEM_FIELD.exec(key);
    return match && match[2] === 'quantity'
      ? { label: 'Line quantity', directPermission: 'delivery.edit' }
      : undefined;
  }

  async load(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    options: { forUpdate: boolean },
  ) {
    if (options.forUpdate) {
      // Lock order: the order before the delivery (as everywhere else).
      const head = await tx.delivery.findUnique({ where: { id }, select: { orderId: true } });
      if (!head) return null;
      await lockRows(tx, 'sales_orders', ctx.businessId, [head.orderId]);
      await lockRows(tx, 'deliveries', ctx.businessId, [id]);
    }
    const [delivery, config] = await Promise.all([
      tx.delivery.findUnique({
        where: { id },
        select: {
          id: true,
          code: true,
          status: true,
          orderId: true,
          customerId: true,
          deliveryDate: true,
          transportReference: true,
          note: true,
          version: true,
          order: { select: { orderDate: true, totalQuantity: true, deliveredQuantity: true } },
          items: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              orderItemId: true,
              productId: true,
              quantity: true,
              unitPrice: true,
              unitCost: true,
              costAmount: true,
              uncostedQuantity: true,
              product: { select: { code: true, unitKey: true } },
              orderItem: { select: { quantity: true, deliveredQuantity: true } },
            },
          },
        },
      }),
      configOf(tx, ctx.businessId),
    ]);
    if (!delivery) return null;
    const decimalsOf = new Map(config.units.map((unit) => [unit.key, unit.decimals]));
    const state: DeliveryState = {
      id: delivery.id,
      status: delivery.status,
      orderId: delivery.orderId,
      customerId: delivery.customerId,
      orderDate: fromDbDate(delivery.order.orderDate),
      orderTotal: delivery.order.totalQuantity,
      orderDelivered: delivery.order.deliveredQuantity,
      timezone: config.timezone,
      lines: delivery.items.map((item) => ({
        id: item.id,
        orderItemId: item.orderItemId,
        productId: item.productId,
        productCode: item.product.code,
        unitKey: item.product.unitKey,
        decimals: decimalsOf.get(item.product.unitKey) ?? 0,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        capacity: item.orderItem.quantity.sub(item.orderItem.deliveredQuantity).add(item.quantity),
        unitCost: item.unitCost,
        costAmount: item.costAmount,
        uncostedQuantity: item.uncostedQuantity,
      })),
    };
    const values: ChangeValues = {
      status: delivery.status,
      deliveryDate: fromDbDate(delivery.deliveryDate),
      transportReference: delivery.transportReference,
      note: delivery.note,
    };
    for (const line of state.lines)
      values[`items.${line.id}.quantity`] = quantityString(line.quantity);
    const record: LoadedRecord = {
      version: delivery.version,
      label: `${delivery.code} (${String(values['deliveryDate'])})`,
      values,
    };
    this.states.set(record, state);
    return record;
  }

  validateEdit(ctx: ChangeContext, current: LoadedRecord, proposed: ChangeValues): ChangeValues {
    const state = this.stateOf(current);
    if (state.status === 'void') throw conflict('DELIVERY_ALREADY_VOID', 'This delivery is void');
    const values: ChangeValues = {};
    for (const [key, value] of Object.entries(proposed)) {
      const field = `${ctx.fieldPrefix}${key}`;
      if (key === 'deliveryDate') {
        values[key] = date(ctx, key, value, 'DELIVERY_DATE', state.timezone, state.orderDate);
      } else if (key === 'transportReference') {
        values[key] = text(ctx, key, value, 64, 'TRANSPORT_REFERENCE_INVALID');
      } else if (key === 'note') {
        values[key] = text(ctx, key, value, 500, 'NOTE_INVALID');
      } else {
        const match = ITEM_FIELD.exec(key);
        const line = match ? state.lines.find((candidate) => candidate.id === match[1]) : undefined;
        if (!match || !line || match[2] !== 'quantity') {
          throw badRequest('FIELD_NOT_CHANGEABLE', `Field "${key}" cannot be changed`, field);
        }
        const quantity =
          typeof value === 'string' && QUANTITY_PATTERN.test(value) ? toDecimal(value) : null;
        if (!quantity || !fitsUnit(quantity, line.decimals)) {
          throw badRequest(
            'QUANTITY_INVALID',
            'Quantity must be above zero and fit the product’s unit',
            field,
          );
        }
        if (quantity.greaterThan(line.capacity))
          throw tooMuch(line.capacity.sub(line.quantity), field);
        values[key] = quantityString(quantity);
      }
    }
    return values;
  }

  validateVoid(
    _tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
  ): Promise<void> {
    if (this.stateOf(current).status === 'void') {
      throw conflict('DELIVERY_ALREADY_VOID', 'This delivery is already void');
    }
    return Promise.resolve();
  }

  async preview(
    tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
    change: ProposedChange,
  ) {
    const state = this.stateOf(current);
    const quantity = this.quantities(state, change);
    const lines: ImpactLine[] = [];
    const stock = await tx.product.findMany({
      where: { id: { in: state.lines.map((line) => line.productId) } },
      select: { id: true, currentStock: true },
    });
    const stockOf = new Map(stock.map((row) => [row.id, row.currentStock]));
    for (const line of state.lines) {
      const delta = quantity(line).sub(line.quantity);
      if (delta.isZero()) continue;
      const before = stockOf.get(line.productId) ?? ZERO;
      lines.push({
        key: `stock.${line.productId}`,
        label: `Stock ${line.productCode}`,
        before: quantityString(before),
        after: quantityString(before.sub(delta)),
        delta: signedQuantity(delta.negated()),
        unit: line.unitKey,
        ...(before.sub(delta).isNegative()
          ? { note: 'Not enough stock: this change will be refused.' }
          : {}),
      });
    }
    const amountDelta = sum(
      state.lines.map((line) =>
        lineTotalOf(quantity(line), line.unitPrice).sub(lineTotalOf(line.quantity, line.unitPrice)),
      ),
    );
    const qtyDelta = sum(state.lines.map((line) => quantity(line).sub(line.quantity)));
    if (!qtyDelta.isZero()) {
      lines.push({
        key: 'order.remainingQuantity',
        label: 'Left to deliver on the order',
        delta: signedQuantity(qtyDelta.negated()),
      });
    }
    if (!amountDelta.isZero()) {
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: state.customerId },
        select: { currentBalance: true },
      });
      lines.push({
        key: 'customer.currentBalance',
        label: 'Customer balance',
        before: moneyString(customer.currentBalance),
        after: moneyString(customer.currentBalance.add(amountDelta)),
        delta: signedMoney(amountDelta),
        visibleWith: 'customer.due.view',
      });
    }
    return lines;
  }

  async applyEdit(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    values: ChangeValues,
  ) {
    const state = this.stateOf(current);
    const quantity = this.quantities(state, { kind: 'edit', values });
    await this.move(tx, ctx, state, quantity, 'delivery_edit', ctx.reason || 'Delivery corrected');
    await tx.delivery.update({
      where: { id },
      data: {
        ...('deliveryDate' in values
          ? { deliveryDate: toDbDate(String(values['deliveryDate'])) }
          : {}),
        ...('transportReference' in values
          ? { transportReference: values['transportReference'] as string | null }
          : {}),
        ...('note' in values ? { note: values['note'] as string | null } : {}),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
  }

  async applyVoid(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    reason: string,
  ) {
    const state = this.stateOf(current);
    await this.validateVoid(tx, ctx, current);
    await this.move(tx, ctx, state, () => ZERO, 'delivery_void', reason);
    await tx.delivery.update({
      where: { id },
      data: {
        status: 'void',
        voidedAt: new Date(),
        voidedBy: ctx.actorUserId,
        voidReason: reason,
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
    await tx.deliveryItem.updateMany({ where: { deliveryId: id }, data: { status: 'void' } });
  }

  /**
   * Moves everything by the difference between the lines now and `quantity`:
   * delivery lines and totals, the order's delivered bags, the customer, stock.
   */
  private async move(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    state: DeliveryState,
    quantity: (line: DeliveryLine) => Prisma.Decimal,
    kind: 'delivery_edit' | 'delivery_void',
    reason: string,
  ) {
    const today = todayIn(state.timezone);
    const changes = state.lines
      .map((line) => {
        const next = quantity(line);
        return {
          line,
          next,
          qtyDelta: next.sub(line.quantity),
          amountDelta: lineTotalOf(next, line.unitPrice).sub(
            lineTotalOf(line.quantity, line.unitPrice),
          ),
        };
      })
      .filter((change) => !change.qtyDelta.isZero());
    if (changes.length === 0) return;
    const qtyDelta = sum(changes.map((change) => change.qtyDelta));
    const amountDelta = sum(changes.map((change) => change.amountDelta));

    if (kind === 'delivery_edit') {
      await Promise.all(
        changes.map((change) =>
          tx.deliveryItem.update({
            where: { id: change.line.id },
            data: {
              quantity: change.next,
              lineTotal: lineTotalOf(change.next, change.line.unitPrice),
            },
          }),
        ),
      );
      await tx.delivery.update({
        where: { id: state.id },
        data: { totalQuantity: { increment: qtyDelta }, totalAmount: { increment: amountDelta } },
      });
    }
    await Promise.all(
      changes.map((change) =>
        tx.salesOrderItem.update({
          where: { id: change.line.orderItemId },
          data: { deliveredQuantity: { increment: change.qtyDelta } },
        }),
      ),
    );
    const delivered = state.orderDelivered.add(qtyDelta);
    await tx.salesOrder.update({
      where: { id: state.orderId },
      data: {
        deliveredQuantity: delivered,
        deliveryStatus: deliveryStatusOf(delivered, state.orderTotal),
      },
    });
    // Lock order: customer before products.
    await this.accounts.move(tx, ctx.businessId, ctx.actorUserId, state.customerId, {
      delivered: amountDelta,
      pending: qtyDelta.negated(),
      ledger: { kind, entryDate: today, sourceType: 'delivery', sourceId: state.id, reason },
    });
    const byProduct = new Map(state.lines.map((line) => [line.productId, line.id]));
    const costs = await this.ledger.apply(
      tx,
      ctx.businessId,
      ctx.actorUserId,
      changes.map((change) => ({
        productId: change.line.productId,
        quantity: change.qtyDelta.negated(),
        kind,
        movementDate: today,
        sourceType: 'delivery' as const,
        sourceId: state.id,
        reason,
        // Cutting a line down or voiding it sends bags back: they return at the
        // cost they left with, never at today's average, so value out and value
        // back in cancel exactly. The uncosted share returns in proportion.
        ...(change.qtyDelta.isNegative()
          ? {
              returnOf: {
                unitCost: change.line.unitCost,
                uncostedQuantity: change.line.quantity.isZero()
                  ? ZERO
                  : change.line.uncostedQuantity
                      .mul(change.qtyDelta.negated())
                      .div(change.line.quantity)
                      .toDecimalPlaces(3),
              },
            }
          : {}),
      })),
      (productId) => `${ctx.fieldPrefix}items.${byProduct.get(productId) ?? ''}.quantity`,
    );

    // A corrected quantity changes what this line actually cost. Growing it
    // issues more bags at today's average; shrinking it gives back a share of
    // what the line already held. A void leaves the line alone — it is marked
    // void and stops counting towards cost of goods sold that way.
    if (kind === 'delivery_edit') {
      await Promise.all(
        changes.map((change, at) => {
          const line = change.line;
          const costedBefore = line.quantity.sub(line.uncostedQuantity);
          let costAmount = line.costAmount ?? ZERO;
          let uncosted = line.uncostedQuantity;
          if (change.qtyDelta.isNegative()) {
            uncosted = line.quantity.isZero()
              ? ZERO
              : uncosted.mul(change.next).div(line.quantity).toDecimalPlaces(3);
            costAmount = costedBefore.isZero()
              ? ZERO
              : costAmount
                  .mul(change.next.sub(uncosted))
                  .div(costedBefore)
                  .toDecimalPlaces(VALUE_SCALE);
          } else {
            costAmount = costAmount.add(costs[at]?.costAmount ?? ZERO);
            uncosted = uncosted.add(costs[at]?.uncostedQuantity ?? ZERO);
          }
          const costedAfter = change.next.sub(uncosted);
          return tx.deliveryItem.update({
            where: { id: line.id },
            data: {
              unitCost: costedAfter.greaterThan(0)
                ? costAmount.div(costedAfter).toDecimalPlaces(VALUE_SCALE)
                : null,
              costAmount: line.unitCost === null && costedAfter.isZero() ? null : costAmount,
              uncostedQuantity: uncosted,
            },
          });
        }),
      );
    }
  }

  private quantities(_state: DeliveryState, change: ProposedChange) {
    if (change.kind === 'void') return () => ZERO;
    const next = new Map<string, Prisma.Decimal>();
    for (const [key, value] of Object.entries(change.values)) {
      const match = ITEM_FIELD.exec(key);
      if (match && match[2] === 'quantity' && typeof value === 'string')
        next.set(match[1] ?? '', toDecimal(value));
    }
    return (line: DeliveryLine) => next.get(line.id) ?? line.quantity;
  }

  private stateOf(record: LoadedRecord): DeliveryState {
    const state = this.states.get(record);
    if (!state) throw new Error('DeliveryChangeHandler: record was not loaded by this handler');
    return state;
  }
}

// =============================================================================
// Collections
// =============================================================================

interface CollectionState {
  id: string;
  status: string;
  customerId: string;
  amount: Prisma.Decimal;
  timezone: string;
  methods: string[];
}

const COLLECTION_FIELDS: Record<string, FieldRule> = {
  collectionDate: { label: 'Collection date', directPermission: 'collection.edit' },
  method: { label: 'Method', directPermission: 'collection.edit' },
  amount: { label: 'Amount', directPermission: 'collection.edit', visibleWith: 'collection.view' },
  reference: { label: 'Reference', directPermission: 'collection.edit' },
  note: { label: 'Note', directPermission: 'collection.edit' },
};

/** Collections: void reverses the money (dated the day of the void); edit moves it by the difference. */
@Injectable()
export class CollectionChangeHandler implements ChangeHandler {
  readonly entityType = 'collection';
  readonly businessTypes = [DEALERSHIP_TYPE];
  readonly viewPermission = 'collection.view';
  readonly fields = COLLECTION_FIELDS;
  readonly void = { label: 'Void collection', directPermission: 'collection.void' };
  private readonly states = new WeakMap<LoadedRecord, CollectionState>();

  constructor(
    private readonly accounts: CustomerAccounts,
    private readonly ledger: BusinessLedgerService,
  ) {}

  async load(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    options: { forUpdate: boolean },
  ) {
    if (options.forUpdate) await lockRows(tx, 'collections', ctx.businessId, [id]);
    const [row, config] = await Promise.all([
      tx.collection.findUnique({
        where: { id },
        select: {
          id: true,
          code: true,
          status: true,
          customerId: true,
          collectionDate: true,
          method: true,
          amount: true,
          reference: true,
          note: true,
          version: true,
        },
      }),
      configOf(tx, ctx.businessId),
    ]);
    if (!row) return null;
    const record: LoadedRecord = {
      version: row.version,
      label: `${row.code} (${fromDbDate(row.collectionDate)})`,
      values: {
        status: row.status,
        collectionDate: fromDbDate(row.collectionDate),
        method: row.method,
        amount: moneyString(row.amount),
        reference: row.reference,
        note: row.note,
      },
    };
    this.states.set(record, {
      id: row.id,
      status: row.status,
      customerId: row.customerId,
      amount: row.amount,
      timezone: config.timezone,
      methods: config.collectionMethods,
    });
    return record;
  }

  validateEdit(ctx: ChangeContext, current: LoadedRecord, proposed: ChangeValues): ChangeValues {
    const state = this.stateOf(current);
    if (state.status === 'void')
      throw conflict('COLLECTION_ALREADY_VOID', 'This collection is void');
    const values: ChangeValues = {};
    for (const [key, value] of Object.entries(proposed)) {
      const field = `${ctx.fieldPrefix}${key}`;
      if (key === 'collectionDate') {
        values[key] = date(ctx, key, value, 'COLLECTION_DATE', state.timezone);
      } else if (key === 'method') {
        if (typeof value !== 'string' || !state.methods.includes(value)) {
          throw badRequest(
            'COLLECTION_METHOD_UNKNOWN',
            'Not one of this business’s methods',
            field,
          );
        }
        values[key] = value;
      } else if (key === 'amount') {
        if (
          typeof value !== 'string' ||
          !MONEY_PATTERN.test(value) ||
          !toDecimal(value).greaterThan(0)
        ) {
          throw badRequest(
            'AMOUNT_INVALID',
            'amount must be above zero, like "5000.00" (as a string)',
            field,
          );
        }
        values[key] = moneyString(toDecimal(value));
      } else if (key === 'reference') {
        values[key] = text(ctx, key, value, 64, 'REFERENCE_INVALID');
      } else if (key === 'note') {
        values[key] = text(ctx, key, value, 500, 'NOTE_INVALID');
      } else {
        throw badRequest('FIELD_NOT_CHANGEABLE', `Field "${key}" cannot be changed`, field);
      }
    }
    return values;
  }

  validateVoid(
    _tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
  ): Promise<void> {
    if (this.stateOf(current).status === 'void') {
      throw conflict('COLLECTION_ALREADY_VOID', 'This collection is already void');
    }
    return Promise.resolve();
  }

  async preview(
    tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
    change: ProposedChange,
  ) {
    const state = this.stateOf(current);
    const after =
      change.kind === 'void'
        ? ZERO
        : typeof change.values['amount'] === 'string'
          ? toDecimal(change.values['amount'])
          : state.amount;
    const delta = after.sub(state.amount);
    if (delta.isZero()) return [];
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: state.customerId },
      select: { currentBalance: true },
    });
    return [
      {
        key: 'customer.currentBalance',
        label: 'Customer balance',
        before: moneyString(customer.currentBalance),
        after: moneyString(customer.currentBalance.sub(delta)),
        delta: signedMoney(delta.negated()),
        visibleWith: 'customer.due.view',
      },
    ];
  }

  async applyEdit(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    values: ChangeValues,
  ) {
    const state = this.stateOf(current);
    const amount =
      typeof values['amount'] === 'string' ? toDecimal(values['amount']) : state.amount;
    await tx.collection.update({
      where: { id },
      data: {
        ...('collectionDate' in values
          ? { collectionDate: toDbDate(String(values['collectionDate'])) }
          : {}),
        ...('method' in values ? { method: String(values['method']) } : {}),
        ...('reference' in values ? { reference: values['reference'] as string | null } : {}),
        ...('note' in values ? { note: values['note'] as string | null } : {}),
        amount,
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
    await this.accounts.move(tx, ctx.businessId, ctx.actorUserId, state.customerId, {
      collected: amount.sub(state.amount),
      ledger: {
        kind: 'collection_edit',
        entryDate: todayIn(state.timezone),
        sourceType: 'collection',
        sourceId: id,
        reason: ctx.reason || 'Collection corrected',
      },
    });
  }

  async applyVoid(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    reason: string,
  ) {
    const state = this.stateOf(current);
    await this.validateVoid(tx, ctx, current);
    await tx.collection.update({
      where: { id },
      data: {
        status: 'void',
        voidedAt: new Date(),
        voidedBy: ctx.actorUserId,
        voidReason: reason,
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });
    await this.accounts.move(tx, ctx.businessId, ctx.actorUserId, state.customerId, {
      collected: state.amount.negated(),
      ledger: {
        kind: 'collection_void',
        entryDate: todayIn(state.timezone),
        sourceType: 'collection',
        sourceId: id,
        reason,
      },
    });
    await this.ledger.voidByReference(tx, ctx.businessId, 'collection', id);
  }

  private stateOf(record: LoadedRecord): CollectionState {
    const state = this.states.get(record);
    if (!state) throw new Error('CollectionChangeHandler: record was not loaded by this handler');
    return state;
  }
}

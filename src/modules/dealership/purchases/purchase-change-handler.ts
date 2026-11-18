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
import {
  fromDbDate,
  isCalendarDate,
  periodOf,
  toDbDate,
  todayIn,
} from '../../../core/common/business-time';
import { MONEY_PATTERN, moneyString, toDecimal } from '../../../core/common/money';
import { lockRows } from '../../../core/database/row-lock';
import { badRequest, conflict } from '../../../core/errors';
import { PeriodCounterService } from '../../../core/numbering/period-counter.service';
import { parseDealershipConfig } from '../dealership.config';
import { DEALERSHIP_TYPE } from '../dealership.permissions';
import { StockEntry, StockLedger, quantityString, stockInsufficient } from '../stock/stock-ledger';
import { QUANTITY_PATTERN } from './dto/requests';
import { PURCHASE_COUNTER_TABLE, fitsUnit, lineTotalOf } from './purchases.service';

const ITEM_FIELD = /^items\.([0-9a-f-]{36})\.(quantity|unitPrice)$/;

const FIELDS: Record<string, FieldRule> = {
  purchaseDate: { label: 'Purchase date', directPermission: 'purchase.edit' },
  note: { label: 'Note', directPermission: 'purchase.create' },
  supplierReference: { label: 'Supplier reference', directPermission: 'purchase.create' },
};

const QUANTITY_RULE: FieldRule = { label: 'Line quantity', directPermission: 'purchase.edit' };
const PRICE_RULE: FieldRule = {
  label: 'Line unit price',
  directPermission: 'purchase.edit',
  visibleWith: 'product.cost.view',
};

/** A purchase line as the handler sees it. */
interface Line {
  id: string;
  productId: string;
  productCode: string;
  unitKey: string;
  decimals: number;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
}

/** Everything the handler needs about a purchase (kept beside the flat values). */
interface PurchaseState {
  id: string;
  code: string;
  status: string;
  purchaseDate: string;
  createdAt: Date;
  timezone: string;
  lines: Line[];
}

const ZERO = new Prisma.Decimal(0);

function signed(value: Prisma.Decimal): string {
  return `${value.isNegative() ? '' : '+'}${quantityString(value)}`;
}

function signedMoney(value: Prisma.Decimal): string {
  return `${value.isNegative() ? '' : '+'}${value.toFixed(2)}`;
}

function monthOf(period: number): string {
  return `${String(Math.floor(period / 100))}-${String(period % 100).padStart(2, '0')}`;
}

/**
 * Change requests and owner-level direct changes for purchases. Void: reverse
 * the stock (dated the day of the void, refused if stock would go below zero),
 * take the bags off the purchase month's counter, recompute the products' last
 * purchase price. Edit: only the existing lines' quantities and prices, the
 * date, note and reference; the stock moves by the difference (dated the day
 * of the edit), the counters move between months if the date's month changes.
 */
@Injectable()
export class PurchaseChangeHandler implements ChangeHandler {
  readonly entityType = 'purchase';
  readonly businessTypes = [DEALERSHIP_TYPE];
  readonly viewPermission = 'purchase.view';
  readonly fields = FIELDS;
  readonly void = { label: 'Void purchase', directPermission: 'purchase.void' };

  /** Loaded state by purchase id, for the rest of the same request. */
  private readonly states = new WeakMap<LoadedRecord, PurchaseState>();

  constructor(
    private readonly ledger: StockLedger,
    private readonly periods: PeriodCounterService,
  ) {}

  fieldRule(key: string): FieldRule | undefined {
    const match = ITEM_FIELD.exec(key);
    if (!match) {
      return undefined;
    }
    return match[2] === 'quantity' ? QUANTITY_RULE : PRICE_RULE;
  }

  async load(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    options: { forUpdate: boolean },
  ): Promise<LoadedRecord | null> {
    if (options.forUpdate) {
      await lockRows(tx, 'purchases', ctx.businessId, [id]);
    }
    const [purchase, business] = await Promise.all([
      tx.purchase.findUnique({
        where: { id },
        select: {
          id: true,
          code: true,
          status: true,
          purchaseDate: true,
          note: true,
          supplierReference: true,
          version: true,
          createdAt: true,
          items: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              productId: true,
              quantity: true,
              unitPrice: true,
              product: { select: { code: true, unitKey: true } },
            },
          },
        },
      }),
      tx.business.findUniqueOrThrow({ where: { id: ctx.businessId }, select: { config: true } }),
    ]);
    if (!purchase) {
      return null;
    }
    const config = parseDealershipConfig(business.config);
    const decimalsOf = new Map(config.units.map((unit) => [unit.key, unit.decimals]));
    const state: PurchaseState = {
      id: purchase.id,
      code: purchase.code,
      status: purchase.status,
      purchaseDate: fromDbDate(purchase.purchaseDate),
      createdAt: purchase.createdAt,
      timezone: config.timezone,
      lines: purchase.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productCode: item.product.code,
        unitKey: item.product.unitKey,
        decimals: decimalsOf.get(item.product.unitKey) ?? 0,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    };
    const values: ChangeValues = {
      status: purchase.status,
      purchaseDate: state.purchaseDate,
      note: purchase.note,
      supplierReference: purchase.supplierReference,
    };
    for (const line of state.lines) {
      values[`items.${line.id}.quantity`] = quantityString(line.quantity);
      values[`items.${line.id}.unitPrice`] = moneyString(line.unitPrice);
    }
    const record: LoadedRecord = {
      version: purchase.version,
      label: `${purchase.code} (${state.purchaseDate})`,
      values,
    };
    this.states.set(record, state);
    return record;
  }

  validateEdit(ctx: ChangeContext, current: LoadedRecord, proposed: ChangeValues): ChangeValues {
    const state = this.stateOf(current);
    if (state.status === 'void') {
      throw conflict('PURCHASE_ALREADY_VOID', 'This purchase is void');
    }
    const field = (key: string) => `${ctx.fieldPrefix}${key}`;
    const values: ChangeValues = {};
    for (const [key, value] of Object.entries(proposed)) {
      if (key === 'purchaseDate') {
        if (typeof value !== 'string' || !isCalendarDate(value)) {
          throw badRequest('PURCHASE_DATE_INVALID', 'Not a real date', field(key));
        }
        if (value > todayIn(state.timezone)) {
          throw badRequest(
            'PURCHASE_DATE_IN_FUTURE',
            'A purchase cannot be dated in the future',
            field(key),
          );
        }
        values[key] = value;
        continue;
      }
      if (key === 'note' || key === 'supplierReference') {
        const limit = key === 'note' ? 500 : 64;
        if (value !== null && (typeof value !== 'string' || value.trim().length > limit)) {
          throw badRequest(
            key === 'note' ? 'NOTE_INVALID' : 'SUPPLIER_REFERENCE_INVALID',
            `${key} must be text of at most ${String(limit)} characters`,
            field(key),
          );
        }
        values[key] = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
        continue;
      }
      const match = ITEM_FIELD.exec(key);
      const line = match ? state.lines.find((candidate) => candidate.id === match[1]) : undefined;
      if (!match || !line) {
        throw badRequest('FIELD_NOT_CHANGEABLE', `Field "${key}" cannot be changed`, field(key));
      }
      if (match[2] === 'quantity') {
        const quantity =
          typeof value === 'string' && QUANTITY_PATTERN.test(value) ? toDecimal(value) : null;
        if (!quantity || !fitsUnit(quantity, line.decimals)) {
          throw badRequest(
            'QUANTITY_INVALID',
            'Quantity must be above zero and fit the product’s unit',
            field(key),
          );
        }
        values[key] = quantityString(quantity);
      } else {
        if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
          throw badRequest(
            'UNIT_PRICE_INVALID',
            'unitPrice must be an amount like "570.50" (as a string)',
            field(key),
          );
        }
        values[key] = moneyString(toDecimal(value));
      }
    }
    return values;
  }

  async validateVoid(
    tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
  ): Promise<void> {
    const state = this.stateOf(current);
    if (state.status === 'void') {
      throw conflict('PURCHASE_ALREADY_VOID', 'This purchase is already void');
    }
    // Checked again under the product locks when the void is applied.
    const stock = await this.stockOf(tx, state.lines);
    for (const line of state.lines) {
      const available = stock.get(line.productId) ?? ZERO;
      if (available.lessThan(line.quantity)) {
        // A void names no input field: the whole purchase is reversed.
        throw stockInsufficient(line.productId, available, line.quantity);
      }
    }
  }

  async preview(
    tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
    change: ProposedChange,
  ): Promise<ImpactLine[]> {
    const state = this.stateOf(current);
    const next = this.nextState(state, change);
    const [stock, lastPrices] = await Promise.all([
      this.stockOf(tx, state.lines),
      this.lastPricesAfter(tx, state, next),
    ]);
    const lines: ImpactLine[] = [];

    // Stock per product.
    for (const line of state.lines) {
      // Unchanged lines keep their quantity (a void sets every line to zero).
      const delta = (next.quantities.get(line.id) ?? line.quantity).sub(line.quantity);
      if (delta.isZero()) continue;
      const before = stock.get(line.productId) ?? ZERO;
      lines.push({
        key: `stock.${line.productId}`,
        label: `Stock ${line.productCode}`,
        before: quantityString(before),
        after: quantityString(before.add(delta)),
        delta: signed(delta),
        unit: line.unitKey,
        ...(before.add(delta).isNegative()
          ? { note: 'Not enough stock: this change will be refused.' }
          : {}),
      });
    }

    // Purchase total (purchase prices are hidden without product.cost.view).
    const totalBefore = this.totalOf(state.lines, new Map(), new Map());
    const totalAfter = next.void ? ZERO : this.totalOf(state.lines, next.quantities, next.prices);
    if (!totalBefore.equals(totalAfter)) {
      lines.push({
        key: 'purchase.totalAmount',
        label: 'Purchase total',
        before: totalBefore.toFixed(2),
        after: totalAfter.toFixed(2),
        delta: signedMoney(totalAfter.sub(totalBefore)),
        visibleWith: 'product.cost.view',
      });
    }

    // Monthly purchase counter: commission progress, owner-only.
    for (const [period, delta] of this.counterChanges(state, next)) {
      lines.push({
        key: `purchaseCounter.${monthOf(period)}`,
        label: `Bags bought in ${monthOf(period)}`,
        delta: signed(delta),
        visibleWith: 'commission.view',
      });
    }

    // Last purchase price of each product.
    for (const line of state.lines) {
      const before = lastPrices.before.get(line.productId) ?? null;
      const after = lastPrices.after.get(line.productId) ?? null;
      if (before !== after) {
        lines.push({
          key: `lastPurchasePrice.${line.productId}`,
          label: `Last purchase price ${line.productCode}`,
          before,
          after,
          visibleWith: 'product.cost.view',
        });
      }
    }
    return lines;
  }

  async applyEdit(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    values: ChangeValues,
  ): Promise<void> {
    const state = this.stateOf(current);
    const next = this.nextState(state, { kind: 'edit', values });
    const today = todayIn(state.timezone);
    const reason = ctx.reason || null;

    // Stock: only the difference, dated the day of the correction.
    const entries: StockEntry[] = state.lines
      .map((line) => ({
        line,
        delta: (next.quantities.get(line.id) ?? line.quantity).sub(line.quantity),
      }))
      .filter(({ delta }) => !delta.isZero())
      .map(({ line, delta }) => ({
        productId: line.productId,
        quantity: delta,
        kind: 'purchase_edit' as const,
        movementDate: today,
        sourceType: 'purchase' as const,
        sourceId: id,
        reason,
      }));
    const byProduct = new Map(state.lines.map((line) => [line.productId, line.id]));
    await this.ledger.apply(
      tx,
      ctx.businessId,
      ctx.actorUserId,
      entries,
      (productId) => `${ctx.fieldPrefix}items.${byProduct.get(productId) ?? ''}.quantity`,
    );

    // Lines and totals.
    const changedLines = state.lines.filter(
      (line) =>
        !(next.quantities.get(line.id) ?? line.quantity).equals(line.quantity) ||
        !(next.prices.get(line.id) ?? line.unitPrice).equals(line.unitPrice),
    );
    await Promise.all(
      changedLines.map((line) => {
        const quantity = next.quantities.get(line.id) ?? line.quantity;
        const unitPrice = next.prices.get(line.id) ?? line.unitPrice;
        return tx.purchaseItem.update({
          where: { id: line.id },
          data: { quantity, unitPrice, lineTotal: lineTotalOf(quantity, unitPrice) },
        });
      }),
    );
    if (next.purchaseDate !== state.purchaseDate) {
      await tx.purchaseItem.updateMany({
        where: { purchaseId: id },
        data: { purchaseDate: toDbDate(next.purchaseDate) },
      });
    }
    const totalQuantity = state.lines.reduce(
      (sum, line) => sum.add(next.quantities.get(line.id) ?? line.quantity),
      ZERO,
    );
    await tx.purchase.update({
      where: { id },
      data: {
        purchaseDate: toDbDate(next.purchaseDate),
        totalQuantity,
        totalAmount: this.totalOf(state.lines, next.quantities, next.prices),
        ...('note' in values ? { note: values['note'] as string | null } : {}),
        ...('supplierReference' in values
          ? { supplierReference: values['supplierReference'] as string | null }
          : {}),
        version: { increment: 1 },
        updatedBy: ctx.actorUserId,
      },
    });

    // Counters by purchase month.
    for (const [period, delta] of this.counterChanges(state, next)) {
      await this.periods.add(tx, PURCHASE_COUNTER_TABLE, ctx.businessId, period, delta);
    }
    if (next.purchaseDate !== state.purchaseDate || changedLines.length > 0) {
      await this.ledger.refreshLastPurchase(
        tx,
        state.lines.map((line) => line.productId),
        state.timezone,
      );
    }
  }

  async applyVoid(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    current: LoadedRecord,
    reason: string,
  ): Promise<void> {
    const state = this.stateOf(current);
    if (state.status === 'void') {
      throw conflict('PURCHASE_ALREADY_VOID', 'This purchase is already void');
    }
    const today = todayIn(state.timezone);
    // Reversal dated the day of the void; refused if stock would go below zero.
    await this.ledger.apply(
      tx,
      ctx.businessId,
      ctx.actorUserId,
      state.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity.negated(),
        kind: 'purchase_void' as const,
        movementDate: today,
        sourceType: 'purchase' as const,
        sourceId: id,
        reason,
      })),
    );
    await tx.purchase.update({
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
    await tx.purchaseItem.updateMany({ where: { purchaseId: id }, data: { status: 'void' } });
    // The counter belongs to the purchase month (owner's decision).
    const total = state.lines.reduce((sum, line) => sum.add(line.quantity), ZERO);
    await this.periods.add(
      tx,
      PURCHASE_COUNTER_TABLE,
      ctx.businessId,
      periodOf(state.purchaseDate),
      total.negated(),
    );
    await this.ledger.refreshLastPurchase(
      tx,
      state.lines.map((line) => line.productId),
      state.timezone,
    );
  }

  // ---------------------------------------------------------------------------

  private stateOf(record: LoadedRecord): PurchaseState {
    const state = this.states.get(record);
    if (!state) {
      throw new Error('PurchaseChangeHandler: record was not loaded by this handler');
    }
    return state;
  }

  private nextState(state: PurchaseState, change: ProposedChange) {
    const quantities = new Map<string, Prisma.Decimal>();
    const prices = new Map<string, Prisma.Decimal>();
    if (change.kind === 'void') {
      for (const line of state.lines) quantities.set(line.id, ZERO);
      return { void: true, purchaseDate: state.purchaseDate, quantities, prices };
    }
    let purchaseDate = state.purchaseDate;
    for (const [key, value] of Object.entries(change.values)) {
      if (key === 'purchaseDate' && typeof value === 'string') {
        purchaseDate = value;
        continue;
      }
      const match = ITEM_FIELD.exec(key);
      if (match && typeof value === 'string') {
        (match[2] === 'quantity' ? quantities : prices).set(match[1] ?? '', toDecimal(value));
      }
    }
    return { void: false, purchaseDate, quantities, prices };
  }

  private totalOf(
    lines: Line[],
    quantities: Map<string, Prisma.Decimal>,
    prices: Map<string, Prisma.Decimal>,
  ): Prisma.Decimal {
    return lines.reduce(
      (sum, line) =>
        sum.add(
          lineTotalOf(
            quantities.get(line.id) ?? line.quantity,
            prices.get(line.id) ?? line.unitPrice,
          ),
        ),
      ZERO,
    );
  }

  /** How each month's counter moves: the purchase month keeps its bags (owner's rule). */
  private counterChanges(
    state: PurchaseState,
    next: ReturnType<PurchaseChangeHandler['nextState']>,
  ): [number, Prisma.Decimal][] {
    const before = state.lines.reduce((sum, line) => sum.add(line.quantity), ZERO);
    const after = next.void
      ? ZERO
      : state.lines.reduce(
          (sum, line) => sum.add(next.quantities.get(line.id) ?? line.quantity),
          ZERO,
        );
    const oldPeriod = periodOf(state.purchaseDate);
    const newPeriod = periodOf(next.purchaseDate);
    const changes: [number, Prisma.Decimal][] =
      oldPeriod === newPeriod
        ? [[oldPeriod, after.sub(before)]]
        : [
            [oldPeriod, before.negated()],
            [newPeriod, after],
          ];
    return changes.filter(([, delta]) => !delta.isZero());
  }

  private async stockOf(tx: Prisma.TransactionClient, lines: Line[]) {
    const rows = await tx.product.findMany({
      where: { id: { in: lines.map((line) => line.productId) } },
      select: { id: true, currentStock: true },
    });
    return new Map(rows.map((row) => [row.id, row.currentStock]));
  }

  /** The last purchase price of each product now, and after the change (for the preview). */
  private async lastPricesAfter(
    tx: Prisma.TransactionClient,
    state: PurchaseState,
    next: ReturnType<PurchaseChangeHandler['nextState']>,
  ) {
    const before = new Map<string, string | null>();
    const after = new Map<string, string | null>();
    await Promise.all(
      state.lines.map(async (line) => {
        const [now, other] = await Promise.all([
          tx.product.findUnique({
            where: { id: line.productId },
            select: { lastPurchasePrice: true },
          }),
          // The latest valid line of this product outside this purchase.
          tx.purchaseItem.findFirst({
            where: { productId: line.productId, status: 'active', purchaseId: { not: state.id } },
            orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            select: { unitPrice: true, purchaseDate: true, createdAt: true },
          }),
        ]);
        before.set(
          line.productId,
          now?.lastPurchasePrice ? moneyString(now.lastPurchasePrice) : null,
        );
        const own =
          next.void || state.status === 'void'
            ? null
            : {
                price: next.prices.get(line.id) ?? line.unitPrice,
                date: next.purchaseDate,
                createdAt: state.createdAt,
              };
        const otherDate = other ? fromDbDate(other.purchaseDate) : null;
        const ownWins =
          own !== null &&
          (other === null ||
            otherDate === null ||
            own.date > otherDate ||
            (own.date === otherDate && own.createdAt >= other.createdAt));
        after.set(
          line.productId,
          ownWins ? moneyString(own.price) : other ? moneyString(other.unitPrice) : null,
        );
      }),
    );
    return { before, after };
  }
}

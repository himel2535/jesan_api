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
import { todayIn } from '../../../core/common/business-time';
import { toDecimal } from '../../../core/common/money';
import { badRequest } from '../../../core/errors';
import { parseDealershipConfig } from '../dealership.config';
import { DEALERSHIP_TYPE } from '../dealership.permissions';
import { SIGNED_QUANTITY_PATTERN } from '../purchases/dto/requests';
import { fitsUnit } from '../purchases/purchases.service';
import { StockLedger, quantityString } from './stock-ledger';

const FIELDS: Record<string, FieldRule> = {
  adjustBy: { label: 'Stock adjustment', directPermission: 'stock.adjust.large' },
};

interface StockState {
  productId: string;
  unitKey: string;
  decimals: number;
  timezone: string;
  stock: Prisma.Decimal;
}

/**
 * Large stock adjustments by change request (above a person's daily limit).
 * The request carries a signed amount (`adjustBy`), not a target count, so it
 * stays valid while purchases move the stock in the meantime: the record's
 * version is constant and the request never goes stale. Applying it is the
 * same ledger movement as a direct adjustment, with the request's reason.
 */
@Injectable()
export class ProductStockChangeHandler implements ChangeHandler {
  readonly entityType = 'product_stock';
  readonly businessTypes = [DEALERSHIP_TYPE];
  readonly viewPermission = 'stock.view';
  readonly fields = FIELDS;

  private readonly states = new WeakMap<LoadedRecord, StockState>();

  constructor(private readonly ledger: StockLedger) {}

  async load(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    id: string,
    options: { forUpdate: boolean },
  ): Promise<LoadedRecord | null> {
    if (options.forUpdate) {
      await this.ledger.lock(tx, ctx.businessId, [id]);
    }
    const [product, business] = await Promise.all([
      tx.product.findUnique({
        where: { id },
        select: { id: true, code: true, nameEn: true, unitKey: true, currentStock: true },
      }),
      tx.business.findUniqueOrThrow({ where: { id: ctx.businessId }, select: { config: true } }),
    ]);
    if (!product) {
      return null;
    }
    const config = parseDealershipConfig(business.config);
    const record: LoadedRecord = {
      version: 1,
      label: `${product.code} ${product.nameEn}`,
      values: { adjustBy: '0' },
    };
    this.states.set(record, {
      productId: product.id,
      unitKey: product.unitKey,
      decimals: config.units.find((unit) => unit.key === product.unitKey)?.decimals ?? 0,
      timezone: config.timezone,
      stock: product.currentStock,
    });
    return record;
  }

  validateEdit(ctx: ChangeContext, current: LoadedRecord, proposed: ChangeValues): ChangeValues {
    const state = this.stateOf(current);
    const value = proposed['adjustBy'];
    const amount =
      typeof value === 'string' && SIGNED_QUANTITY_PATTERN.test(value) ? toDecimal(value) : null;
    if (!amount || !fitsUnit(amount.abs(), state.decimals)) {
      throw badRequest(
        'ADJUST_BY_INVALID',
        'adjustBy must be a non-zero quantity like "-30" that fits the unit',
        `${ctx.fieldPrefix}adjustBy`,
      );
    }
    return { adjustBy: quantityString(amount) };
  }

  preview(
    _tx: Prisma.TransactionClient,
    _ctx: ChangeContext,
    current: LoadedRecord,
    change: ProposedChange,
  ): Promise<ImpactLine[]> {
    const state = this.stateOf(current);
    if (change.kind !== 'edit' || typeof change.values['adjustBy'] !== 'string') {
      return Promise.resolve([]);
    }
    const amount = toDecimal(change.values['adjustBy']);
    const after = state.stock.add(amount);
    return Promise.resolve([
      {
        key: `stock.${state.productId}`,
        label: 'Stock',
        before: quantityString(state.stock),
        after: quantityString(after),
        delta: `${amount.isNegative() ? '' : '+'}${quantityString(amount)}`,
        unit: state.unitKey,
        ...(after.isNegative() ? { note: 'Not enough stock: this change will be refused.' } : {}),
      },
    ]);
  }

  async applyEdit(
    tx: Prisma.TransactionClient,
    ctx: ChangeContext,
    _id: string,
    current: LoadedRecord,
    values: ChangeValues,
  ): Promise<void> {
    const state = this.stateOf(current);
    await this.ledger.apply(
      tx,
      ctx.businessId,
      ctx.actorUserId,
      [
        {
          productId: state.productId,
          quantity: toDecimal(String(values['adjustBy'])),
          kind: 'adjustment',
          movementDate: todayIn(state.timezone),
          sourceType: 'adjustment',
          sourceId: null,
          reason: ctx.reason || 'Approved stock adjustment',
        },
      ],
      () => `${ctx.fieldPrefix}adjustBy`,
    );
  }

  private stateOf(record: LoadedRecord): StockState {
    const state = this.states.get(record);
    if (!state) {
      throw new Error('ProductStockChangeHandler: record was not loaded by this handler');
    }
    return state;
  }
}

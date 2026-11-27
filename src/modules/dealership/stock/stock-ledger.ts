import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { dayStartIn, toDbDate } from '../../../core/common/business-time';
import { lockRows } from '../../../core/database/row-lock';
import { errorBody } from '../../../core/errors';
import {
  applyIssue,
  applyReceipt,
  applyReceiptReversal,
  applyReturn,
  emptyPools,
  type Pools,
} from './inventory-cost';

export type MovementKind =
  | 'purchase'
  | 'purchase_edit'
  | 'purchase_void'
  | 'adjustment'
  | 'delivery'
  | 'delivery_edit'
  | 'delivery_void';

export interface StockEntry {
  productId: string;
  /** Signed: + in, - out. */
  quantity: Prisma.Decimal;
  kind: MovementKind;
  /** Business date it counts on (YYYY-MM-DD). */
  movementDate: string;
  sourceType: 'purchase' | 'delivery' | 'adjustment';
  sourceId: string | null;
  reason: string | null;
  /**
   * What these bags cost to acquire, for goods coming in from a purchase. Left
   * out when nothing is known (a found-bags adjustment), and those bags then
   * join the uncosted pool instead of moving the average.
   */
  unitCost?: Prisma.Decimal | null;
  /**
   * Goods coming back from a delivery that was voided or cut down. They return
   * at the cost snapshotted when they left, so the value put back is exactly
   * the value taken out; `uncostedQuantity` is the part that left with no cost.
   */
  returnOf?: { unitCost: Prisma.Decimal | null; uncostedQuantity: Prisma.Decimal };
}

/** What costing did with one entry, for the caller to snapshot on its own line. */
export interface CostOutcome {
  /** The moving average at the moment of an issue; null when nothing is costed. */
  unitCost: Prisma.Decimal | null;
  /** Value taken out of (or put into) the costed pool. */
  costAmount: Prisma.Decimal;
  /** The part of an issue that had no cost basis at all. */
  uncostedQuantity: Prisma.Decimal;
  /** Value stranded when the costed pool emptied; booked as a residual. */
  roundingResidual: Prisma.Decimal;
}

/** Quantities leave the API as plain decimal strings: "50", "12.5". */
export function quantityString(value: Prisma.Decimal): string {
  return value.toString();
}

/**
 * The 409 when stock would go below zero. It says which product and how much
 * is on hand, nothing about other records.
 */
export function stockInsufficient(
  productId: string,
  available: Prisma.Decimal,
  required: Prisma.Decimal,
  field?: string,
): ConflictException {
  const body = errorBody(
    HttpStatus.CONFLICT,
    'STOCK_INSUFFICIENT',
    'Not enough stock for this change',
    field,
  );
  return new ConflictException({
    ...body,
    details: {
      productId,
      available: quantityString(available),
      required: quantityString(required),
    },
  });
}

/**
 * The only way stock changes. Inside the caller's transaction: lock the
 * products (id order, no deadlocks), refuse any balance below zero, append the
 * movements with the balance after each, and move current_stock by the same
 * amount. So current_stock always equals the sum of the movements.
 */
@Injectable()
export class StockLedger {
  async apply(
    tx: Prisma.TransactionClient,
    businessId: string,
    actorUserId: string,
    entries: readonly StockEntry[],
    fieldFor: (productId: string) => string | undefined = () => undefined,
  ): Promise<(CostOutcome | null)[]> {
    const outcomes: (CostOutcome | null)[] = entries.map(() => null);
    const moving = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !entry.quantity.isZero());
    if (moving.length === 0) {
      return outcomes;
    }
    const productIds = [...new Set(moving.map(({ entry }) => entry.productId))];
    await this.lock(tx, businessId, productIds);
    const stocks = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        currentStock: true,
        costedQuantity: true,
        costedValue: true,
        uncostedQuantity: true,
      },
    });
    const balance = new Map(stocks.map((row) => [row.id, row.currentStock]));
    const pools = new Map<string, Pools>(
      stocks.map((row) => [
        row.id,
        {
          costedQuantity: row.costedQuantity,
          costedValue: row.costedValue,
          uncostedQuantity: row.uncostedQuantity,
        },
      ]),
    );

    const rows = moving.map(({ entry, index }) => {
      const before = balance.get(entry.productId) ?? new Prisma.Decimal(0);
      const after = before.add(entry.quantity);
      if (after.isNegative()) {
        throw stockInsufficient(
          entry.productId,
          before,
          entry.quantity.negated(),
          fieldFor(entry.productId),
        );
      }
      balance.set(entry.productId, after);
      outcomes[index] = this.cost(pools, entry);
      return {
        businessId,
        productId: entry.productId,
        kind: entry.kind,
        quantity: entry.quantity,
        balanceAfter: after,
        movementDate: toDbDate(entry.movementDate),
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        reason: entry.reason,
        createdBy: actorUserId,
      };
    });
    await tx.stockMovement.createMany({ data: rows });

    // Stock and its value move in the same statement, so the pools can never
    // drift away from current_stock.
    await Promise.all(
      [...pools.entries()].map(([productId, next]) =>
        tx.product.update({
          where: { id: productId },
          data: {
            currentStock: balance.get(productId) ?? new Prisma.Decimal(0),
            costedQuantity: next.costedQuantity,
            costedValue: next.costedValue,
            uncostedQuantity: next.uncostedQuantity,
          },
        }),
      ),
    );
    return outcomes;
  }

  /** Moves one entry through the product's cost pools (see `inventory-cost.ts`). */
  private cost(pools: Map<string, Pools>, entry: StockEntry): CostOutcome {
    const current = pools.get(entry.productId) ?? emptyPools();
    const none = {
      unitCost: null,
      costAmount: new Prisma.Decimal(0),
      uncostedQuantity: new Prisma.Decimal(0),
      roundingResidual: new Prisma.Decimal(0),
    };
    if (entry.quantity.isNegative() && entry.sourceType === 'purchase') {
      // Undoing a receipt: the bags leave at the price they arrived at.
      pools.set(
        entry.productId,
        applyReceiptReversal(current, entry.quantity.negated(), entry.unitCost ?? null),
      );
      return none;
    }
    if (entry.quantity.isNegative()) {
      const issue = applyIssue(current, entry.quantity.negated());
      pools.set(entry.productId, issue.pools);
      return {
        unitCost: issue.unitCost,
        costAmount: issue.costAmount,
        uncostedQuantity: issue.uncostedQuantity,
        roundingResidual: issue.roundingResidual,
      };
    }
    if (entry.returnOf) {
      pools.set(
        entry.productId,
        applyReturn(current, {
          costedQuantity: entry.quantity.sub(entry.returnOf.uncostedQuantity),
          unitCost: entry.returnOf.unitCost,
          uncostedQuantity: entry.returnOf.uncostedQuantity,
        }),
      );
      return none;
    }
    pools.set(entry.productId, applyReceipt(current, entry.quantity, entry.unitCost ?? null));
    return none;
  }

  /** Locks product rows in id order (call before reading stock you will change). */
  async lock(
    tx: Prisma.TransactionClient,
    businessId: string,
    productIds: readonly string[],
  ): Promise<void> {
    await lockRows(tx, 'products', businessId, productIds);
  }

  /**
   * Sets each product's last purchase price and date from its latest valid
   * purchase line (by purchase date, then time of entry), or null when none is
   * left. Call with the products locked, in the purchase's transaction.
   */
  async refreshLastPurchase(
    tx: Prisma.TransactionClient,
    productIds: readonly string[],
    timeZone: string,
  ): Promise<void> {
    await Promise.all(
      [...new Set(productIds)].map(async (productId) => {
        const latest = await tx.purchaseItem.findFirst({
          where: { productId, status: 'active' },
          orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          select: { unitPrice: true, purchaseDate: true },
        });
        await tx.product.update({
          where: { id: productId },
          data: latest
            ? {
                lastPurchasePrice: latest.unitPrice,
                lastPurchasedAt: dayStartIn(
                  latest.purchaseDate.toISOString().slice(0, 10),
                  timeZone,
                ),
              }
            : { lastPurchasePrice: null, lastPurchasedAt: null },
        });
      }),
    );
  }
}

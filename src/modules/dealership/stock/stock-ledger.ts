import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { dayStartIn, toDbDate } from '../../../core/common/business-time';
import { lockRows } from '../../../core/database/row-lock';
import { errorBody } from '../../../core/errors';

export type MovementKind = 'purchase' | 'purchase_edit' | 'purchase_void' | 'adjustment';

export interface StockEntry {
  productId: string;
  /** Signed: + in, - out. */
  quantity: Prisma.Decimal;
  kind: MovementKind;
  /** Business date it counts on (YYYY-MM-DD). */
  movementDate: string;
  sourceType: 'purchase' | 'adjustment';
  sourceId: string | null;
  reason: string | null;
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
  ): Promise<void> {
    const moving = entries.filter((entry) => !entry.quantity.isZero());
    if (moving.length === 0) {
      return;
    }
    const productIds = [...new Set(moving.map((entry) => entry.productId))];
    await this.lock(tx, businessId, productIds);
    const stocks = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, currentStock: true },
    });
    const balance = new Map(stocks.map((row) => [row.id, row.currentStock]));

    const rows = moving.map((entry) => {
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

    const net = new Map<string, Prisma.Decimal>();
    for (const entry of moving) {
      net.set(
        entry.productId,
        (net.get(entry.productId) ?? new Prisma.Decimal(0)).add(entry.quantity),
      );
    }
    await Promise.all(
      [...net.entries()]
        .filter(([, amount]) => !amount.isZero())
        .map(([productId, amount]) =>
          tx.product.update({
            where: { id: productId },
            data: { currentStock: { increment: amount } },
          }),
        ),
    );
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

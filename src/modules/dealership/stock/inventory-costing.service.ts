import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, toDbDate } from '../../../core/common/business-time';
import { errorBody } from '../../../core/errors';
import {
  applyIssue,
  applyReceipt,
  applyReceiptReversal,
  applyReturn,
  emptyPools,
  totalQuantity,
  VALUE_SCALE,
  type Pools,
} from './inventory-cost';
import { quantityString } from './stock-ledger';

const ZERO = new Prisma.Decimal(0);

export type CorrectionKind =
  'purchase_edit' | 'purchase_void' | 'backdated_entry' | 'rounding_residual';

export interface ReplayResult {
  pools: Pools;
  /** Cost of goods sold over the whole history: deliveries out, less what came back. */
  cogsTotal: Prisma.Decimal;
  /** Bags delivered that had no cost basis at all. */
  uncostedDelivered: Prisma.Decimal;
  /** Total bags the replay ends on; must equal the product's `currentStock`. */
  endQuantity: Prisma.Decimal;
  /** The first day the business-date timeline goes below zero, if it does. */
  negativeAt: { date: string; shortfall: Prisma.Decimal } | null;
  /** The earliest day the replay covered, used as a correction's effective date. */
  earliestDate: string | null;
  /**
   * What each delivery's bags of this product cost, as the replay works it out:
   * net of anything that came back. This is what a snapshot should say, and is
   * what the backfill writes onto lines that have none.
   */
  deliveryCosts: Map<
    string,
    {
      unitCost: Prisma.Decimal | null;
      costAmount: Prisma.Decimal;
      uncostedQuantity: Prisma.Decimal;
    }
  >;
}

/** 409 when a backdated entry would make the business-date timeline go negative. */
export function backdatedStockNegative(
  productId: string,
  date: string,
  shortfall: Prisma.Decimal,
  field?: string,
): ConflictException {
  return new ConflictException({
    ...errorBody(
      HttpStatus.CONFLICT,
      'BACKDATED_STOCK_NEGATIVE',
      'This date would leave the product with less than no stock on an earlier day',
      field,
    ),
    details: { productId, date, shortfall: quantityString(shortfall) },
  });
}

interface ReplayStep {
  seq: bigint;
  effectiveDate: string;
  quantity: Prisma.Decimal;
  kind: string;
  sourceType: string;
  sourceId: string | null;
}

/**
 * Inventory costing over a product's whole history.
 *
 * Ordinary trading is costed forward, one movement at a time, by
 * `StockLedger.apply`. This service is for the cases that forward costing
 * cannot answer on its own:
 *
 * - **Replay.** When an old purchase's price, quantity or date is corrected,
 *   the average every later delivery was costed at is no longer what it should
 *   have been. The product's movements are replayed in *effective business
 *   date* order — the parent document's current date, not the frozen
 *   `movement_date`, which a date edit leaves stale and which the append-only
 *   trigger forbids fixing.
 * - **Corrections.** Delivery snapshots are never rewritten. The replayed cost
 *   of goods sold is compared with the frozen snapshots and the difference is
 *   booked as one correction row, dated the day the correction was made — the
 *   same way every other reversal in this system is dated.
 * - **The backdating guard.** In business-date order a timeline can go below
 *   zero (a delivery dated before the purchase that supplied it), where a
 *   moving average has no meaning. The replay reports it and the caller
 *   refuses, rather than quietly costing it at a made-up number.
 */
@Injectable()
export class InventoryCostingService {
  /**
   * Replays one product in effective-business-date order. Reads only: the
   * caller decides what to do with the result. Call with the product locked.
   */
  async replayProduct(tx: Prisma.TransactionClient, productId: string): Promise<ReplayResult> {
    const [movements, purchaseLines, deliveryLines] = await Promise.all([
      tx.stockMovement.findMany({
        where: { productId },
        orderBy: { seq: 'asc' },
        select: {
          seq: true,
          quantity: true,
          kind: true,
          movementDate: true,
          sourceType: true,
          sourceId: true,
        },
      }),
      // `purchase_items.purchase_date` is kept in step with the purchase, so it
      // is the current date even when the movement's own date went stale.
      tx.purchaseItem.findMany({
        where: { productId },
        select: { purchaseId: true, unitPrice: true, purchaseDate: true },
      }),
      tx.deliveryItem.findMany({
        where: { productId },
        select: { deliveryId: true, quantity: true, uncostedQuantity: true },
      }),
    ]);

    const deliveryIds = [...new Set(deliveryLines.map((line) => line.deliveryId))];
    const deliveries = deliveryIds.length
      ? await tx.delivery.findMany({
          where: { id: { in: deliveryIds } },
          select: { id: true, deliveryDate: true },
        })
      : [];
    const deliveryDate = new Map(deliveries.map((row) => [row.id, fromDbDate(row.deliveryDate)]));
    const purchasePrice = new Map(
      purchaseLines.map((line) => [line.purchaseId, line.unitPrice] as const),
    );
    const purchaseDate = new Map(
      purchaseLines.map((line) => [line.purchaseId, fromDbDate(line.purchaseDate)] as const),
    );

    const steps: ReplayStep[] = movements.map((row) => ({
      seq: row.seq,
      effectiveDate: this.effectiveDateOf(row, purchaseDate, deliveryDate),
      quantity: row.quantity,
      kind: row.kind,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
    }));
    steps.sort((a, b) =>
      a.effectiveDate === b.effectiveDate
        ? Number(a.seq - b.seq)
        : a.effectiveDate.localeCompare(b.effectiveDate),
    );

    let pools = emptyPools();
    let cogsTotal = ZERO;
    let uncostedDelivered = ZERO;
    let running = ZERO;
    let negativeAt: ReplayResult['negativeAt'] = null;
    /** What each delivery's bags cost when they went out, so a return matches. */
    const issuedAt = new Map<string, Prisma.Decimal | null>();
    const deliveryCosts: ReplayResult['deliveryCosts'] = new Map();
    const bump = (
      deliveryId: string,
      unitCost: Prisma.Decimal | null,
      costAmount: Prisma.Decimal,
      uncosted: Prisma.Decimal,
    ) => {
      const row = deliveryCosts.get(deliveryId) ?? {
        unitCost,
        costAmount: ZERO,
        uncostedQuantity: ZERO,
      };
      row.unitCost = unitCost ?? row.unitCost;
      row.costAmount = row.costAmount.add(costAmount);
      row.uncostedQuantity = row.uncostedQuantity.add(uncosted);
      deliveryCosts.set(deliveryId, row);
    };

    for (const step of steps) {
      running = running.add(step.quantity);
      if (running.isNegative() && negativeAt === null) {
        negativeAt = { date: step.effectiveDate, shortfall: running.negated() };
      }
      if (step.quantity.isNegative()) {
        if (step.sourceType === 'purchase') {
          // A voided or reduced purchase: the bags go back to the supplier at
          // the price they came in at, never at the average.
          pools = applyReceiptReversal(
            pools,
            step.quantity.negated(),
            step.sourceId ? (purchasePrice.get(step.sourceId) ?? null) : null,
          );
          continue;
        }
        const issue = applyIssue(pools, step.quantity.negated());
        pools = issue.pools;
        if (step.sourceType === 'delivery') {
          cogsTotal = cogsTotal.add(issue.costAmount);
          uncostedDelivered = uncostedDelivered.add(issue.uncostedQuantity);
          if (step.sourceId) {
            issuedAt.set(step.sourceId, issue.unitCost);
            bump(step.sourceId, issue.unitCost, issue.costAmount, issue.uncostedQuantity);
          }
        }
        continue;
      }
      if (step.sourceType === 'delivery') {
        // Bags coming back from a voided or reduced delivery, at the cost the
        // replay itself issued them at.
        const unitCost = step.sourceId ? (issuedAt.get(step.sourceId) ?? null) : null;
        const lines = deliveryLines.filter((line) => line.deliveryId === step.sourceId);
        const lineQuantity = lines.reduce((sum, line) => sum.add(line.quantity), ZERO);
        const lineUncosted = lines.reduce((sum, line) => sum.add(line.uncostedQuantity), ZERO);
        const uncostedBack = lineQuantity.isZero()
          ? ZERO
          : Prisma.Decimal.min(
              step.quantity,
              lineUncosted.mul(step.quantity).div(lineQuantity).toDecimalPlaces(3),
            );
        pools = applyReturn(pools, {
          costedQuantity: step.quantity.sub(uncostedBack),
          unitCost,
          uncostedQuantity: uncostedBack,
        });
        const returnedValue =
          unitCost === null
            ? ZERO
            : step.quantity.sub(uncostedBack).mul(unitCost).toDecimalPlaces(VALUE_SCALE);
        cogsTotal = cogsTotal.sub(returnedValue);
        uncostedDelivered = uncostedDelivered.sub(uncostedBack);
        if (step.sourceId)
          bump(step.sourceId, unitCost, returnedValue.negated(), uncostedBack.negated());
        continue;
      }
      // A purchase receipt carries its price; an adjustment carries none.
      const unitCost =
        step.sourceType === 'purchase' && step.sourceId
          ? (purchasePrice.get(step.sourceId) ?? null)
          : null;
      pools = applyReceipt(pools, step.quantity, unitCost);
    }

    return {
      pools,
      cogsTotal,
      uncostedDelivered,
      endQuantity: totalQuantity(pools),
      negativeAt,
      earliestDate: steps[0]?.effectiveDate ?? null,
      deliveryCosts,
    };
  }

  /**
   * Replays the products, writes the recomputed pools, and books the difference
   * between the replayed cost of goods sold and the frozen delivery snapshots
   * as one correction per product. Call with the products locked, inside the
   * mutating transaction, after the stock has moved.
   *
   * Throws `BACKDATED_STOCK_NEGATIVE` when the change leaves a business-date
   * timeline below zero, which rolls the whole transaction back.
   */
  async recompute(
    tx: Prisma.TransactionClient,
    businessId: string,
    actorUserId: string,
    productIds: readonly string[],
    correction: {
      kind: CorrectionKind;
      reason: string | null;
      sourceType: string;
      sourceId: string | null;
      today: string;
    },
  ): Promise<void> {
    for (const productId of [...new Set(productIds)]) {
      const replay = await this.replayProduct(tx, productId);
      if (replay.negativeAt) {
        throw backdatedStockNegative(
          productId,
          replay.negativeAt.date,
          replay.negativeAt.shortfall,
        );
      }
      const snapshots = await tx.deliveryItem.aggregate({
        where: { productId, status: 'active' },
        _sum: { costAmount: true },
      });
      const booked = snapshots._sum.costAmount ?? ZERO;
      const cogsDelta = replay.cogsTotal.sub(booked).toDecimalPlaces(VALUE_SCALE);

      const before = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { costedValue: true },
      });
      const stockValueDelta = replay.pools.costedValue.sub(before.costedValue);

      await tx.product.update({
        where: { id: productId },
        data: {
          costedQuantity: replay.pools.costedQuantity,
          costedValue: replay.pools.costedValue,
          uncostedQuantity: replay.pools.uncostedQuantity,
        },
      });

      if (!cogsDelta.isZero() || !stockValueDelta.isZero()) {
        await tx.inventoryCostCorrection.create({
          data: {
            businessId,
            productId,
            correctionDate: toDbDate(correction.today),
            effectiveDate: toDbDate(replay.earliestDate ?? correction.today),
            cogsDelta,
            stockValueDelta,
            kind: correction.kind,
            reason: correction.reason,
            sourceType: correction.sourceType,
            sourceId: correction.sourceId,
            createdBy: actorUserId,
          },
        });
      }
    }
  }

  /**
   * Refuses a backdated entry that would leave an earlier day with less than no
   * stock. Only worth running when something was dated in the past: a movement
   * dated today cannot reorder a timeline that already balances.
   */
  async assertTimelineHolds(
    tx: Prisma.TransactionClient,
    productIds: readonly string[],
    fieldFor: (productId: string) => string | undefined = () => undefined,
  ): Promise<void> {
    for (const productId of [...new Set(productIds)]) {
      const replay = await this.replayProduct(tx, productId);
      if (replay.negativeAt) {
        throw backdatedStockNegative(
          productId,
          replay.negativeAt.date,
          replay.negativeAt.shortfall,
          fieldFor(productId),
        );
      }
    }
  }

  /**
   * The business date a movement belongs to. Purchases and deliveries take
   * their parent document's current date, so a corrected date is followed even
   * though the movement's own `movement_date` can never be updated. Everything
   * else — an edit, a void, an adjustment — genuinely happened on its own day.
   */
  private effectiveDateOf(
    row: { kind: string; movementDate: Date; sourceType: string; sourceId: string | null },
    purchaseDate: Map<string, string>,
    deliveryDate: Map<string, string>,
  ): string {
    const own = fromDbDate(row.movementDate);
    if (!row.sourceId) return own;
    if (row.kind === 'purchase') return purchaseDate.get(row.sourceId) ?? own;
    if (row.kind === 'delivery') return deliveryDate.get(row.sourceId) ?? own;
    return own;
  }
}

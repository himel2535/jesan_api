import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, toDbDate } from '../../../core/common/business-time';
import { uuid7 } from '../../../core/common/uuid7';
import { errorBody } from '../../../core/errors';
import {
  cloneState,
  distributeMoney,
  emptyState,
  issue,
  netSlices,
  restore,
  sliceOf,
  takeBack,
  type FifoState,
  type Slice,
} from './fifo';
import { allocationSlices, poolsOf, quantityString } from './stock-ledger';

const ZERO = new Prisma.Decimal(0);

export type CorrectionKind =
  | 'purchase_edit'
  | 'purchase_void'
  | 'backdated_entry'
  | 'rounding_residual'
  | 'costing_policy_change';

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

/** A purchase or a found-bags adjustment, as the replay sees it. */
export interface ReplaySource {
  /** `purchase:<purchase id>` or `adjustment:<movement id>`. */
  key: string;
  sourceType: 'purchase' | 'adjustment';
  sourceId: string;
  /** Bags in as things stand now (all edits and voids folded in). */
  quantity: Prisma.Decimal;
  /** null = unknown cost. */
  unitCost: Prisma.Decimal | null;
  date: string;
  seq: bigint;
  /** The batch row already standing for it, if any. */
  batch: { id: string } | null;
}

export interface ReplayResult {
  sources: Map<string, ReplaySource>;
  /** What is left of each source's bags, by source key. */
  remaining: Map<string, Prisma.Decimal>;
  /** Legacy bags (belonging to no batch) left at the end. */
  legacyLeft: Prisma.Decimal;
  /** Per delivery: the bags it holds now, by source key (null key = legacy), after returns. */
  deliveries: Map<string, Slice[]>;
  /** Per delivery: everything it ever drew, before any return (what a voided one held at its peak). */
  issued: Map<string, Slice[]>;
  /** Total bags the replay ends on; must equal the product's `currentStock`. */
  endQuantity: Prisma.Decimal;
  /** The first day the business-date timeline goes below zero, if it does. */
  negativeAt: { date: string; shortfall: Prisma.Decimal } | null;
  /** The earliest day the replay covered, used as a correction's effective date. */
  earliestDate: string | null;
  /** Cost of goods sold over the whole history under FIFO (known costs only). */
  cogsTotal: Prisma.Decimal;
  /** Bags delivered with no cost basis. */
  uncostedDelivered: Prisma.Decimal;
}

interface Step {
  seq: bigint;
  date: string;
  op: 'receive' | 'issue' | 'return' | 'adjust_out';
  quantity: Prisma.Decimal;
  deliveryId?: string;
  sourceKey?: string;
}

/**
 * Inventory costing over a product's whole history, FIFO by batch.
 *
 * Ordinary trading is costed forward, one movement at a time, by
 * `StockLedger.apply`. This service handles what forward costing cannot:
 *
 * - **Replay.** When an old purchase's price, quantity or date is corrected, or a
 *   backdated purchase or delivery lands in the middle of the timeline, the batch
 *   every later delivery drew from may no longer be the right one. The product is
 *   replayed in *effective business date* order, oldest first.
 * - **Corrections, never rewrites.** Original rows — the purchase as entered, each
 *   delivery's frozen snapshot, the original allocations — are never touched. The
 *   replayed allocation is compared with what the delivery lines hold now, and each
 *   difference is *appended* as a signed adjustment allocation under one
 *   `inventory_cost_corrections` row dated today, the way every other reversal in
 *   this system is dated.
 * - **The backdating guard.** In business-date order a timeline can go below zero (a
 *   delivery dated before the purchase that supplied it). The replay reports it and
 *   the caller refuses, rather than quietly guessing.
 *
 * Bags that belong to no batch (stock from before batches existed) are *legacy*:
 * unknown cost, older than every batch. Deliveries that predate batches have no
 * allocations and are left alone; they can only ever draw legacy bags.
 */
@Injectable()
export class InventoryCostingService {
  /**
   * Replays one product in effective-business-date order. Reads only: the caller
   * decides what to do with the result. Call with the product locked.
   *
   * `rebuild` treats every purchase and adjustment as a batch and every delivery as
   * costed, which is how a FIFO backfill sees history. Without it, only what already
   * has a batch row (or allocations) is costed; the rest stays legacy.
   */
  async replayProduct(
    tx: Prisma.TransactionClient,
    productId: string,
    options: { rebuild?: boolean } = {},
  ): Promise<ReplayResult> {
    const rebuild = options.rebuild === true;
    const [movements, purchaseLines, batches, deliveryLines, allocated] = await Promise.all([
      tx.stockMovement.findMany({
        where: { productId },
        orderBy: { seq: 'asc' },
        select: {
          id: true,
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
      tx.inventoryBatch.findMany({
        where: { productId },
        select: { id: true, sourceType: true, sourceId: true },
      }),
      tx.deliveryItem.findMany({ where: { productId }, select: { id: true, deliveryId: true } }),
      tx.deliveryItemAllocation.groupBy({
        by: ['deliveryItemId'],
        where: { productId },
        _count: { _all: true },
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
    const withAllocations = new Set(allocated.map((row) => row.deliveryItemId));
    const costedDelivery = new Set(
      deliveryLines.filter((line) => withAllocations.has(line.id)).map((line) => line.deliveryId),
    );
    const batchOf = new Map(
      batches.map((batch) => [`${batch.sourceType}:${batch.sourceId}`, batch]),
    );
    const purchaseInfo = new Map(purchaseLines.map((line) => [line.purchaseId, line]));

    // Sources: what each purchase and each found-bags adjustment brought in, net of edits and voids.
    const sources = new Map<string, ReplaySource>();
    for (const row of movements) {
      if (row.sourceType === 'purchase' && row.sourceId) {
        const key = `purchase:${row.sourceId}`;
        const have = sources.get(key);
        if (have) {
          have.quantity = have.quantity.add(row.quantity);
          continue;
        }
        const line = purchaseInfo.get(row.sourceId);
        sources.set(key, {
          key,
          sourceType: 'purchase',
          sourceId: row.sourceId,
          quantity: row.quantity,
          unitCost: line?.unitPrice ?? null,
          date: line ? fromDbDate(line.purchaseDate) : fromDbDate(row.movementDate),
          seq: row.seq,
          batch: batchOf.get(key) ?? null,
        });
      } else if (row.sourceType === 'adjustment' && row.quantity.greaterThan(0)) {
        const key = `adjustment:${row.id}`;
        sources.set(key, {
          key,
          sourceType: 'adjustment',
          sourceId: row.id,
          quantity: row.quantity,
          unitCost: null,
          date: fromDbDate(row.movementDate),
          seq: row.seq,
          batch: batchOf.get(key) ?? null,
        });
      }
    }

    const steps: Step[] = [];
    for (const source of sources.values()) {
      if (source.quantity.greaterThan(0)) {
        steps.push({
          seq: source.seq,
          date: source.date,
          op: 'receive',
          quantity: source.quantity,
          sourceKey: source.key,
        });
      }
    }
    for (const row of movements) {
      if (row.sourceType === 'adjustment' && row.quantity.isNegative()) {
        steps.push({
          seq: row.seq,
          date: fromDbDate(row.movementDate),
          op: 'adjust_out',
          quantity: row.quantity.negated(),
        });
      } else if (row.sourceType === 'delivery' && row.sourceId) {
        // A delivery counts on its current date; edits and voids on the day they happened.
        const date =
          row.kind === 'delivery'
            ? (deliveryDate.get(row.sourceId) ?? fromDbDate(row.movementDate))
            : fromDbDate(row.movementDate);
        steps.push({
          seq: row.seq,
          date,
          op: row.quantity.isNegative() ? 'issue' : 'return',
          quantity: row.quantity.abs(),
          deliveryId: row.sourceId,
        });
      }
    }
    steps.sort((a, b) =>
      a.date === b.date ? Number(a.seq - b.seq) : a.date.localeCompare(b.date),
    );

    let state: FifoState = emptyState();
    let running = ZERO;
    let negativeAt: ReplayResult['negativeAt'] = null;
    const held = new Map<string, Slice[]>();
    const issuedAll = new Map<string, Slice[]>();
    const remainingByKey = new Map<string, Prisma.Decimal>();
    const outsideState = new Set<string>();

    for (const step of steps) {
      const signed =
        step.op === 'receive' || step.op === 'return' ? step.quantity : step.quantity.negated();
      running = running.add(signed);
      if (running.isNegative() && negativeAt === null) {
        negativeAt = { date: step.date, shortfall: running.negated() };
      }
      if (step.op === 'receive') {
        const source = sources.get(step.sourceKey ?? '');
        if (!source) continue;
        if (rebuild || source.batch) {
          state.batches.push({
            key: source.key,
            unitCost: source.unitCost,
            remaining: step.quantity,
          });
        } else {
          state.legacy = state.legacy.add(step.quantity);
          outsideState.add(source.key);
        }
      } else if (step.op === 'adjust_out') {
        state = issue(state, step.quantity).state;
      } else if (step.op === 'issue') {
        const id = step.deliveryId ?? '';
        if (rebuild || costedDelivery.has(id)) {
          const out = issue(state, step.quantity);
          state = out.state;
          held.set(id, netSlices([...(held.get(id) ?? []), ...out.slices]));
          issuedAll.set(id, netSlices([...(issuedAll.get(id) ?? []), ...out.slices]));
        } else {
          // Delivered before batches existed: it only ever drew legacy bags.
          const take = Prisma.Decimal.min(step.quantity, state.legacy);
          state = { ...cloneState(state), legacy: state.legacy.sub(take) };
        }
      } else {
        const id = step.deliveryId ?? '';
        if (rebuild || costedDelivery.has(id)) {
          const back = takeBack(held.get(id) ?? [], step.quantity);
          const returned = back.shortfall.greaterThan(0)
            ? [...back.returned, sliceOf(null, back.shortfall, null)]
            : back.returned;
          state = restore(state, returned);
          held.set(
            id,
            netSlices([
              ...(held.get(id) ?? []),
              ...returned.map((slice) => ({
                ...slice,
                quantity: slice.quantity.negated(),
                costAmount: slice.costAmount?.negated() ?? null,
              })),
            ]),
          );
        } else {
          state = { ...cloneState(state), legacy: state.legacy.add(step.quantity) };
        }
      }
    }

    for (const batch of state.batches) remainingByKey.set(batch.key, batch.remaining);
    let cogsTotal = ZERO;
    let uncostedDelivered = ZERO;
    for (const slices of held.values()) {
      for (const slice of slices) {
        if (slice.costAmount === null) uncostedDelivered = uncostedDelivered.add(slice.quantity);
        else cogsTotal = cogsTotal.add(slice.costAmount);
      }
    }
    return {
      sources,
      remaining: remainingByKey,
      legacyLeft: state.legacy,
      deliveries: held,
      issued: issuedAll,
      endQuantity: state.batches.reduce((sum, b) => sum.add(b.remaining), state.legacy),
      negativeAt,
      earliestDate: steps[0]?.date ?? null,
      cogsTotal,
      uncostedDelivered,
    };
  }

  /**
   * Replays the products after a purchase edit, a void or a backdated entry, and
   * brings the batches into line with what history now says. Original rows are
   * never changed. What moves is appended:
   *
   * - a batch whose price, quantity or date was corrected gets its current values
   *   updated (the originals stay) and one `inventory_batch_events` row;
   * - a delivery line whose bags now come from different batches (or at a different
   *   price) gets signed `adjustment` allocations for the difference;
   * - one `inventory_cost_corrections` row per product books the effect on cost of
   *   goods sold and on the value of the stock left, dated today.
   *
   * Call with the products locked, inside the mutating transaction, after the
   * stock has moved. Throws `BACKDATED_STOCK_NEGATIVE` when the change leaves a
   * business-date timeline below zero, which rolls the whole transaction back.
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
      fieldFor?: (productId: string) => string | undefined;
    },
  ): Promise<void> {
    for (const productId of [...new Set(productIds)]) {
      const replay = await this.replayProduct(tx, productId);
      if (replay.negativeAt) {
        throw backdatedStockNegative(
          productId,
          replay.negativeAt.date,
          replay.negativeAt.shortfall,
          correction.fieldFor?.(productId),
        );
      }
      const batches = await tx.inventoryBatch.findMany({
        where: { productId },
        select: {
          id: true,
          sourceType: true,
          sourceId: true,
          receivedQuantity: true,
          unitCost: true,
          receivedDate: true,
          remainingQuantity: true,
        },
      });
      const keyOfBatch = new Map(batches.map((b) => [b.id, `${b.sourceType}:${b.sourceId}`]));
      const batchOfKey = new Map(batches.map((b) => [`${b.sourceType}:${b.sourceId}`, b]));

      // Stock value before and after, over the costed batches.
      let valueBefore = ZERO;
      let valueAfter = ZERO;
      type BatchChange = {
        id: string;
        received: Prisma.Decimal;
        unitCost: Prisma.Decimal | null;
        date: string;
        remaining: Prisma.Decimal;
        event: {
          type: 'quantity_edit' | 'price_edit' | 'date_edit' | 'void';
          quantity: Prisma.Decimal;
          value: Prisma.Decimal;
        } | null;
        changed: boolean;
      };
      const changes: BatchChange[] = [];
      for (const batch of batches) {
        const key = keyOfBatch.get(batch.id) ?? '';
        const source = replay.sources.get(key);
        const remaining = replay.remaining.get(key) ?? ZERO;
        const received = source
          ? Prisma.Decimal.max(source.quantity, ZERO)
          : batch.receivedQuantity;
        const unitCost =
          source && source.sourceType === 'purchase' ? source.unitCost : batch.unitCost;
        const date = source ? source.date : fromDbDate(batch.receivedDate);
        valueBefore = valueBefore.add(
          batch.unitCost ? batch.remainingQuantity.mul(batch.unitCost) : ZERO,
        );
        valueAfter = valueAfter.add(unitCost ? remaining.mul(unitCost) : ZERO);
        const sameReceipt =
          received.equals(batch.receivedQuantity) &&
          (unitCost === null
            ? batch.unitCost === null
            : (batch.unitCost?.equals(unitCost) ?? false));
        const sameDate = date === fromDbDate(batch.receivedDate);
        const changed = !sameReceipt || !sameDate || !remaining.equals(batch.remainingQuantity);
        let event: BatchChange['event'] = null;
        if (!sameReceipt || !sameDate) {
          const oldValue = batch.unitCost ? batch.receivedQuantity.mul(batch.unitCost) : ZERO;
          const newValue = unitCost ? received.mul(unitCost) : ZERO;
          event = {
            type: received.isZero()
              ? 'void'
              : !received.equals(batch.receivedQuantity)
                ? 'quantity_edit'
                : !sameReceipt
                  ? 'price_edit'
                  : 'date_edit',
            quantity: received.sub(batch.receivedQuantity),
            value: newValue.sub(oldValue),
          };
        }
        changes.push({ id: batch.id, received, unitCost, date, remaining, event, changed });
      }

      // The delivery lines that were costed under FIFO: what they hold now against what history says.
      const lines = await tx.deliveryItem.findMany({
        where: { productId, allocations: { some: {} } },
        select: { id: true, deliveryId: true, quantity: true, lineTotal: true },
      });
      type Row = {
        deliveryItemId: string;
        batchId: string | null;
        quantity: Prisma.Decimal;
        unitCost: Prisma.Decimal | null;
        costAmount: Prisma.Decimal | null;
        revenue: Prisma.Decimal;
        costKnown: boolean;
      };
      const rows: Row[] = [];
      for (const line of lines) {
        const wanted = replay.deliveries.get(line.deliveryId) ?? [];
        const held = await tx.deliveryItemAllocation.groupBy({
          by: ['batchId'],
          where: { deliveryItemId: line.id },
          _sum: { quantity: true, costAmount: true, revenueAmount: true },
        });
        const heldBy = new Map(held.map((row) => [row.batchId ?? '', row._sum]));
        const revenue = distributeMoney(
          line.lineTotal,
          wanted.map((slice) => slice.quantity),
        );
        const seen = new Set<string>();
        wanted.forEach((slice, at) => {
          const batch = slice.batchKey ? batchOfKey.get(slice.batchKey) : undefined;
          const id = batch?.id ?? '';
          seen.add(id);
          const have = heldBy.get(id);
          const dq = slice.quantity.sub(have?.quantity ?? ZERO);
          const dc =
            slice.costAmount === null ? null : slice.costAmount.sub(have?.costAmount ?? ZERO);
          const dr = (revenue[at] ?? ZERO).sub(have?.revenueAmount ?? ZERO);
          if (dq.isZero() && (dc === null || dc.isZero()) && dr.isZero()) return;
          rows.push({
            deliveryItemId: line.id,
            batchId: batch?.id ?? null,
            quantity: dq,
            unitCost: slice.unitCost,
            costAmount: dc,
            revenue: dr,
            costKnown: slice.costAmount !== null,
          });
        });
        // What the line holds from batches the replay no longer draws on.
        for (const [id, have] of heldBy) {
          if (seen.has(id)) continue;
          const dq = (have.quantity ?? ZERO).negated();
          const dr = (have.revenueAmount ?? ZERO).negated();
          if (dq.isZero() && dr.isZero()) continue;
          const batch = id ? batches.find((b) => b.id === id) : undefined;
          const known = batch?.unitCost !== null && batch?.unitCost !== undefined;
          rows.push({
            deliveryItemId: line.id,
            batchId: id || null,
            quantity: dq,
            unitCost: batch?.unitCost ?? null,
            costAmount: known ? (have.costAmount ?? ZERO).negated() : null,
            revenue: dr,
            costKnown: known,
          });
        }
      }

      const cogsDelta = rows.reduce((sum, row) => sum.add(row.costAmount ?? ZERO), ZERO);
      // The change in what the remaining stock is worth *beyond* the direct edit of the
      // receipts: money that moved between cost of goods sold and stock. Together with
      // `cogsDelta` it explains the whole change in the purchase value.
      const receiptChange = changes.reduce(
        (sum, change) => sum.add(change.event?.value ?? ZERO),
        ZERO,
      );
      const stockValueDelta = valueAfter.sub(valueBefore).sub(receiptChange);

      // Pools follow the batches; this also heals a product whose pools were never filled in.
      const nextState: FifoState = {
        legacy: replay.legacyLeft,
        batches: changes.map((change) => ({
          key: change.id,
          unitCost: change.unitCost,
          remaining: change.remaining,
        })),
      };

      let correctionId: string | null = null;
      if (rows.length > 0 || !cogsDelta.isZero() || !stockValueDelta.isZero()) {
        correctionId = uuid7();
        await tx.inventoryCostCorrection.create({
          data: {
            id: correctionId,
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
      for (const change of changes) {
        if (!change.changed) continue;
        await tx.inventoryBatch.update({
          where: { id: change.id },
          data: {
            receivedQuantity: change.received,
            unitCost: change.unitCost,
            receivedDate: toDbDate(change.date),
            remainingQuantity: change.remaining,
          },
        });
        if (change.event) {
          await tx.inventoryBatchEvent.create({
            data: {
              businessId,
              batchId: change.id,
              productId,
              eventType: change.event.type,
              businessDate: toDbDate(correction.today),
              quantityDelta: change.event.quantity,
              valueDelta: change.event.value,
              sourceType: correction.sourceType,
              sourceId: correction.sourceId,
              correctionId,
              reason: correction.reason,
              createdBy: actorUserId,
            },
          });
        }
      }
      if (rows.length > 0 && correctionId) {
        await tx.deliveryItemAllocation.createMany({
          data: rows.map((row) => ({
            businessId,
            deliveryItemId: row.deliveryItemId,
            productId,
            batchId: row.batchId,
            kind: 'adjustment',
            quantity: row.quantity,
            unitCost: row.unitCost,
            costAmount: row.costAmount,
            revenueAmount: row.revenue,
            costKnown: row.costKnown,
            allocationDate: toDbDate(correction.today),
            correctionId,
          })),
        });
      }
      await tx.product.update({ where: { id: productId }, data: poolsOf(nextState) });
    }
  }

  /** The bags a delivery line holds now, newest slice last: what a return gives back first. */
  held(tx: Prisma.TransactionClient, deliveryItemId: string): Promise<Slice[]> {
    return allocationSlices(tx, deliveryItemId);
  }
}

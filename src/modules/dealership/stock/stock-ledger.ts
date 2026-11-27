import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { dayStartIn, fromDbDate, toDbDate } from '../../../core/common/business-time';
import { uuid7 } from '../../../core/common/uuid7';
import { lockRows } from '../../../core/database/row-lock';
import { errorBody } from '../../../core/errors';
import {
  costedPool,
  distributeMoney,
  issue,
  netSlices,
  restore,
  snapshotOf,
  sliceOf,
  takeBack,
  uncostedOnHand,
  type FifoState,
  type Slice,
} from './fifo';

const ZERO = new Prisma.Decimal(0);

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
   * What these bags cost to acquire, for a purchase receipt: it becomes the
   * price of that purchase's own batch and never changes with later purchases.
   */
  unitCost?: Prisma.Decimal | null;
  /**
   * Bags coming back from a delivery line that was voided or cut down. They go
   * back to the batches they left, at the cost they left with.
   */
  returnOf?: { deliveryItemId: string };
}

/** What costing did with one entry, for the caller to freeze on its own line. */
export interface CostOutcome {
  /** The slices an issue took, oldest batch first; for a return, the slices that went back. */
  slices: Slice[];
  /** Average cost of the known bags in `slices`; null when none had a cost. */
  unitCost: Prisma.Decimal | null;
  /** Cost of the known bags; null when none had a cost (never zero). */
  costAmount: Prisma.Decimal | null;
  /** The part with no cost basis at all. */
  uncostedQuantity: Prisma.Decimal;
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

/** Working copy of one product's batches while a call to `apply` runs. */
interface Working {
  state: FifoState;
  /** Receipt date of each batch, parallel to `state.batches`. */
  dates: string[];
  /** Insertion order of each batch, parallel to `state.batches` (the tie-break within a day). */
  seqs: bigint[];
  created: {
    id: string;
    sourceType: 'purchase' | 'adjustment';
    sourceId: string | null;
    quantity: Prisma.Decimal;
    unitCost: Prisma.Decimal | null;
    date: string;
    entryIndex: number;
    reason: string | null;
  }[];
  touched: Set<string>;
  events: {
    batchId: string;
    eventType: 'received' | 'adjust_in' | 'adjust_out';
    date: string;
    quantity: Prisma.Decimal;
    value: Prisma.Decimal;
    sourceType: string | null;
    sourceId: string | null;
    reason: string | null;
  }[];
}

/** Slices of a delivery line's net allocations: what it holds now, in batch order. */
export async function allocationSlices(
  tx: Prisma.TransactionClient,
  deliveryItemId: string,
): Promise<Slice[]> {
  const rows = await tx.deliveryItemAllocation.findMany({
    where: { deliveryItemId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { batchId: true, quantity: true, unitCost: true, costAmount: true },
  });
  return netSlices(
    rows.map((row) => ({
      batchKey: row.batchId,
      quantity: row.quantity,
      unitCost: row.unitCost,
      costAmount: row.costAmount,
    })),
  );
}

/**
 * What a delivery line froze at the time: what the delivery itself consumed
 * (original allocations less reversals). Accounting adjustments made later by
 * corrected history are deliberately left out; they live in the corrections.
 */
export async function lineSnapshot(tx: Prisma.TransactionClient, deliveryItemId: string) {
  const rows = await tx.deliveryItemAllocation.findMany({
    where: { deliveryItemId, kind: { in: ['original', 'reversal'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { batchId: true, quantity: true, unitCost: true, costAmount: true },
  });
  return snapshotOf(
    netSlices(
      rows.map((row) => ({
        batchKey: row.batchId,
        quantity: row.quantity,
        unitCost: row.unitCost,
        costAmount: row.costAmount,
      })),
    ),
  );
}

/**
 * The only way stock changes. Inside the caller's transaction: lock the
 * products (id order, no deadlocks), refuse any balance below zero, append the
 * movements with the balance after each, and move current_stock by the same
 * amount. So current_stock always equals the sum of the movements.
 *
 * Stock is costed FIFO, batch by batch (see `fifo.ts`): a purchase receipt
 * opens its own batch at its own price, found bags open an unknown-cost batch,
 * and every issue takes the oldest bags first and says which batches they came
 * from. Purchase edits and voids are *not* costed here: their batches are
 * rebuilt by `InventoryCostingService.recompute`, which replays the history.
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
      select: { id: true, currentStock: true },
    });
    const balance = new Map(stocks.map((row) => [row.id, row.currentStock]));
    const working = await this.load(tx, productIds, balance);

    const movementIds = moving.map(() => uuid7());
    const rows = [];
    for (const [at, { entry, index }] of moving.entries()) {
      const before = balance.get(entry.productId) ?? ZERO;
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
      const work = working.get(entry.productId);
      if (work) {
        outcomes[index] = await this.cost(tx, work, entry, movementIds[at] ?? '', index);
      }
      rows.push({
        id: movementIds[at],
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
      });
    }
    await tx.stockMovement.createMany({ data: rows });
    await this.persist(tx, businessId, actorUserId, working, balance);
    return outcomes;
  }

  /** Each product's open batches, oldest first, and the bags that belong to none. */
  private async load(
    tx: Prisma.TransactionClient,
    productIds: readonly string[],
    balance: Map<string, Prisma.Decimal>,
  ): Promise<Map<string, Working>> {
    const batches = await tx.inventoryBatch.findMany({
      where: { productId: { in: [...productIds] }, remainingQuantity: { gt: 0 } },
      orderBy: [{ receivedDate: 'asc' }, { seq: 'asc' }],
      select: {
        id: true,
        productId: true,
        unitCost: true,
        remainingQuantity: true,
        receivedDate: true,
        seq: true,
      },
    });
    const result = new Map<string, Working>();
    for (const productId of productIds) {
      const own = batches.filter((batch) => batch.productId === productId);
      const inBatches = own.reduce((sum, batch) => sum.add(batch.remainingQuantity), ZERO);
      // Bags on hand that no batch accounts for: stock from before batches existed.
      const legacy = Prisma.Decimal.max((balance.get(productId) ?? ZERO).sub(inBatches), ZERO);
      result.set(productId, {
        state: {
          legacy,
          batches: own.map((batch) => ({
            key: batch.id,
            unitCost: batch.unitCost,
            remaining: batch.remainingQuantity,
          })),
        },
        dates: own.map((batch) => fromDbDate(batch.receivedDate)),
        seqs: own.map((batch) => batch.seq),
        created: [],
        touched: new Set(),
        events: [],
      });
    }
    return result;
  }

  /** Moves one entry through its product's batches. */
  private async cost(
    tx: Prisma.TransactionClient,
    work: Working,
    entry: StockEntry,
    movementId: string,
    entryIndex: number,
  ): Promise<CostOutcome | null> {
    const none = null;
    if (entry.kind === 'purchase_edit' || entry.kind === 'purchase_void') {
      // Rebuilt from history by `recompute`, which every purchase edit and void calls.
      return none;
    }
    if (entry.quantity.isNegative()) {
      const out = issue(work.state, entry.quantity.negated());
      work.state = out.state;
      for (const slice of out.slices) {
        if (slice.batchKey) work.touched.add(slice.batchKey);
        if (entry.kind === 'adjustment' && slice.batchKey) {
          work.events.push({
            batchId: slice.batchKey,
            eventType: 'adjust_out',
            date: entry.movementDate,
            quantity: slice.quantity.negated(),
            value: slice.costAmount?.negated() ?? ZERO,
            sourceType: 'adjustment',
            sourceId: movementId,
            reason: entry.reason,
          });
        }
      }
      return { slices: out.slices, ...snapshotOf(out.slices) };
    }
    if (entry.returnOf) {
      const held = await allocationSlices(tx, entry.returnOf.deliveryItemId);
      const back = takeBack(held, entry.quantity);
      const returned = back.shortfall.greaterThan(0)
        ? [...back.returned, sliceOf(null, back.shortfall, null)]
        : back.returned;
      // Bags go back to the batch they left, even one that has since run empty.
      await this.reopen(
        tx,
        work,
        returned.flatMap((slice) => (slice.batchKey ? [slice.batchKey] : [])),
      );
      work.state = restore(work.state, returned);
      for (const slice of returned) if (slice.batchKey) work.touched.add(slice.batchKey);
      return { slices: returned, ...snapshotOf(returned) };
    }
    if (entry.kind === 'purchase') {
      if (entry.unitCost === undefined || entry.unitCost === null) {
        throw new Error('A purchase receipt must carry the price of its bags');
      }
      this.open(work, entry, 'purchase', entry.sourceId, entry.unitCost, movementId, entryIndex);
      return none;
    }
    // Found bags: counted, never valued.
    this.open(work, entry, 'adjustment', movementId, null, movementId, entryIndex);
    return none;
  }

  /** Brings batches that ran empty back into the working list, in their place in the order. */
  private async reopen(
    tx: Prisma.TransactionClient,
    work: Working,
    ids: readonly string[],
  ): Promise<void> {
    const have = new Set(work.state.batches.map((batch) => batch.key));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length === 0) return;
    const rows = await tx.inventoryBatch.findMany({
      where: { id: { in: missing } },
      select: { id: true, unitCost: true, receivedDate: true, seq: true },
    });
    for (const row of rows) {
      const date = fromDbDate(row.receivedDate);
      let at = work.dates.length;
      while (
        at > 0 &&
        ((work.dates[at - 1] ?? '') > date ||
          ((work.dates[at - 1] ?? '') === date && (work.seqs[at - 1] ?? 0n) > row.seq))
      ) {
        at -= 1;
      }
      work.state.batches.splice(at, 0, { key: row.id, unitCost: row.unitCost, remaining: ZERO });
      work.dates.splice(at, 0, date);
      work.seqs.splice(at, 0, row.seq);
    }
  }

  /** Opens a batch for bags coming in; it sits after every batch received on or before its date. */
  private open(
    work: Working,
    entry: StockEntry,
    sourceType: 'purchase' | 'adjustment',
    sourceId: string | null,
    unitCost: Prisma.Decimal | null,
    movementId: string,
    entryIndex: number,
  ): void {
    const id = uuid7();
    let at = work.dates.length;
    while (at > 0 && (work.dates[at - 1] ?? '') > entry.movementDate) at -= 1;
    work.state.batches.splice(at, 0, { key: id, unitCost, remaining: entry.quantity });
    work.dates.splice(at, 0, entry.movementDate);
    // Not written yet, so it sorts after anything already on its day.
    work.seqs.splice(at, 0, BigInt(Number.MAX_SAFE_INTEGER));
    work.created.push({
      id,
      sourceType,
      sourceId,
      quantity: entry.quantity,
      unitCost,
      date: entry.movementDate,
      entryIndex,
      reason: entry.reason,
    });
    work.events.push({
      batchId: id,
      eventType: sourceType === 'purchase' ? 'received' : 'adjust_in',
      date: entry.movementDate,
      quantity: entry.quantity,
      value: unitCost === null ? ZERO : entry.quantity.mul(unitCost),
      sourceType: entry.sourceType,
      sourceId: movementId === sourceId ? movementId : entry.sourceId,
      reason: entry.reason,
    });
  }

  /** Writes what the entries did: batches, their events, and the product's stock and pools. */
  private async persist(
    tx: Prisma.TransactionClient,
    businessId: string,
    actorUserId: string,
    working: Map<string, Working>,
    balance: Map<string, Prisma.Decimal>,
  ): Promise<void> {
    for (const [productId, work] of working) {
      const remaining = new Map(work.state.batches.map((batch) => [batch.key, batch.remaining]));
      const createdIds = new Set(work.created.map((batch) => batch.id));
      if (work.created.length > 0) {
        await tx.inventoryBatch.createMany({
          data: work.created.map((batch) => ({
            id: batch.id,
            businessId,
            productId,
            sourceType: batch.sourceType,
            // A purchase batch is keyed by its purchase; found bags by their own movement.
            sourceId: batch.sourceId ?? batch.id,
            originalQuantity: batch.quantity,
            originalUnitCost: batch.unitCost,
            originalReceivedDate: toDbDate(batch.date),
            receivedQuantity: batch.quantity,
            unitCost: batch.unitCost,
            receivedDate: toDbDate(batch.date),
            remainingQuantity: remaining.get(batch.id) ?? batch.quantity,
          })),
        });
      }
      await Promise.all(
        [...work.touched]
          .filter((id) => !createdIds.has(id))
          .map((id) =>
            tx.inventoryBatch.update({
              where: { id },
              data: { remainingQuantity: remaining.get(id) ?? ZERO },
            }),
          ),
      );
      if (work.events.length > 0) {
        await tx.inventoryBatchEvent.createMany({
          data: work.events.map((event) => ({
            businessId,
            batchId: event.batchId,
            productId,
            eventType: event.eventType,
            businessDate: toDbDate(event.date),
            quantityDelta: event.quantity,
            valueDelta: event.value,
            sourceType: event.sourceType,
            sourceId: event.sourceId,
            reason: event.reason,
            createdBy: actorUserId,
          })),
        });
      }
      await tx.product.update({
        where: { id: productId },
        data: { currentStock: balance.get(productId) ?? ZERO, ...poolsOf(work.state) },
      });
    }
  }

  /**
   * Records which batches a delivery line's bags came from, and the share of
   * the line's selling price each slice carries (split by bags, never by cost).
   * `revenueTotal` is the signed change to the line's total that these slices
   * account for. Appended, never changed.
   */
  async writeAllocations(
    tx: Prisma.TransactionClient,
    businessId: string,
    input: {
      deliveryItemId: string;
      productId: string;
      kind: 'original' | 'reversal';
      slices: readonly Slice[];
      revenueTotal: Prisma.Decimal;
      allocationDate: string;
      backfillRunId?: string;
    },
  ): Promise<void> {
    if (input.slices.length === 0) return;
    const sign = input.kind === 'reversal' ? new Prisma.Decimal(-1) : new Prisma.Decimal(1);
    const revenue = distributeMoney(
      input.revenueTotal,
      input.slices.map((slice) => slice.quantity),
    );
    await tx.deliveryItemAllocation.createMany({
      data: input.slices.map((slice, at) => ({
        businessId,
        deliveryItemId: input.deliveryItemId,
        productId: input.productId,
        batchId: slice.batchKey,
        kind: input.kind,
        quantity: slice.quantity.mul(sign),
        unitCost: slice.unitCost,
        costAmount: slice.costAmount === null ? null : slice.costAmount.mul(sign),
        revenueAmount: revenue[at] ?? ZERO,
        costKnown: slice.costAmount !== null,
        allocationDate: toDbDate(input.allocationDate),
        ...(input.backfillRunId ? { backfillRunId: input.backfillRunId } : {}),
      })),
    });
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

/** The product's cost pools, derived from its batches (and the legacy bags that belong to none). */
export function poolsOf(state: FifoState) {
  const pool = costedPool(state);
  return {
    costedQuantity: pool.quantity,
    costedValue: pool.value.toDecimalPlaces(6),
    uncostedQuantity: uncostedOnHand(state),
  };
}

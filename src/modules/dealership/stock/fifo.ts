import { Prisma } from '../../../generated/prisma/client';

/**
 * FIFO inventory costing as pure arithmetic over a list of batches.
 *
 * Every purchase line is its own batch and keeps its own price for good. Goods
 * leave oldest batch first, so a delivery that spans two purchases is costed at
 * each purchase's own price, slice by slice. Nothing here touches the database;
 * the stock ledger and the replay both run these functions, so a figure costed
 * live and a figure rebuilt from history cannot disagree.
 *
 * Three kinds of stock exist:
 * - a **costed batch**: bags whose purchase price is known;
 * - an **unknown-cost batch**: bags that arrived with no price (found bags);
 * - **legacy** stock: bags on hand from before batches existed. Unknown cost,
 *   and older than every batch by definition, so it leaves first.
 * Unknown-cost bags are counted and delivered but never valued: their slice has
 * `costAmount = null`, never zero.
 */

const ZERO = new Prisma.Decimal(0);

/** A batch as the engine sees it: oldest first, with what is left. */
export interface FifoBatch {
  key: string;
  /** null = unknown cost. */
  unitCost: Prisma.Decimal | null;
  remaining: Prisma.Decimal;
}

/** One piece of an issue: some bags from one batch (or from legacy stock). */
export interface Slice {
  /** null = legacy stock, never batched. */
  batchKey: string | null;
  quantity: Prisma.Decimal;
  /** null = unknown cost. */
  unitCost: Prisma.Decimal | null;
  /** null = unknown cost; never zero. */
  costAmount: Prisma.Decimal | null;
}

export interface FifoState {
  batches: FifoBatch[];
  /** Bags on hand that belong to no batch. */
  legacy: Prisma.Decimal;
}

export function emptyState(): FifoState {
  return { batches: [], legacy: ZERO };
}

export function cloneState(state: FifoState): FifoState {
  return { batches: state.batches.map((b) => ({ ...b })), legacy: state.legacy };
}

export function totalOnHand(state: FifoState): Prisma.Decimal {
  return state.batches.reduce((sum, b) => sum.add(b.remaining), state.legacy);
}

/** What the costed batches still hold, in bags and in money. */
export function costedPool(state: FifoState): { quantity: Prisma.Decimal; value: Prisma.Decimal } {
  let quantity = ZERO;
  let value = ZERO;
  for (const batch of state.batches) {
    if (batch.unitCost === null) continue;
    quantity = quantity.add(batch.remaining);
    value = value.add(batch.remaining.mul(batch.unitCost));
  }
  return { quantity, value };
}

/** Bags on hand whose cost is unknown: unknown-cost batches plus legacy stock. */
export function uncostedOnHand(state: FifoState): Prisma.Decimal {
  return state.batches.reduce(
    (sum, b) => (b.unitCost === null ? sum.add(b.remaining) : sum),
    state.legacy,
  );
}

export function sliceOf(
  batchKey: string | null,
  quantity: Prisma.Decimal,
  unitCost: Prisma.Decimal | null,
): Slice {
  return {
    batchKey,
    quantity,
    unitCost,
    costAmount: unitCost === null ? null : quantity.mul(unitCost),
  };
}

export interface IssueOutcome {
  state: FifoState;
  slices: Slice[];
  /** Bags that could not be found; non-zero means stock would go below zero. */
  shortfall: Prisma.Decimal;
}

/**
 * Takes `quantity` bags out, oldest first: legacy stock, then batches in the
 * order given. `batches` must already be sorted oldest first.
 */
export function issue(state: FifoState, quantity: Prisma.Decimal): IssueOutcome {
  const next = cloneState(state);
  const slices: Slice[] = [];
  let left = quantity;
  if (left.greaterThan(0) && next.legacy.greaterThan(0)) {
    const take = Prisma.Decimal.min(left, next.legacy);
    slices.push(sliceOf(null, take, null));
    next.legacy = next.legacy.sub(take);
    left = left.sub(take);
  }
  for (const batch of next.batches) {
    if (left.lessThanOrEqualTo(0)) break;
    if (batch.remaining.lessThanOrEqualTo(0)) continue;
    const take = Prisma.Decimal.min(left, batch.remaining);
    slices.push(sliceOf(batch.key, take, batch.unitCost));
    batch.remaining = batch.remaining.sub(take);
    left = left.sub(take);
  }
  return { state: next, slices, shortfall: Prisma.Decimal.max(left, ZERO) };
}

/**
 * Puts bags back where they came from: each slice returns to its own batch at
 * the cost it left with. A slice whose batch no longer exists (or was legacy)
 * returns to legacy stock rather than being given a made-up home.
 */
export function restore(state: FifoState, slices: readonly Slice[]): FifoState {
  const next = cloneState(state);
  for (const slice of slices) {
    const batch = slice.batchKey ? next.batches.find((b) => b.key === slice.batchKey) : undefined;
    if (batch) batch.remaining = batch.remaining.add(slice.quantity);
    else next.legacy = next.legacy.add(slice.quantity);
  }
  return next;
}

/**
 * Takes `quantity` bags back out of a list of slices, newest slice first (last
 * in, first out), merging nothing. Used for a delivery cut or voided: the bags
 * that left last are the ones that return.
 */
export function takeBack(
  slices: readonly Slice[],
  quantity: Prisma.Decimal,
): { returned: Slice[]; shortfall: Prisma.Decimal } {
  const returned: Slice[] = [];
  let left = quantity;
  for (let at = slices.length - 1; at >= 0 && left.greaterThan(0); at -= 1) {
    const slice = slices[at];
    if (!slice || slice.quantity.lessThanOrEqualTo(0)) continue;
    const take = Prisma.Decimal.min(left, slice.quantity);
    returned.push(sliceOf(slice.batchKey, take, slice.unitCost));
    left = left.sub(take);
  }
  return { returned, shortfall: left };
}

/**
 * Sums slices that share a batch (same cost, since a batch has one cost) so a
 * history of issues and returns reads as one net figure per batch. Order is the
 * order batches were first seen; zero-quantity results are dropped.
 */
export function netSlices(slices: readonly Slice[]): Slice[] {
  const byKey = new Map<string, Slice>();
  const order: string[] = [];
  for (const slice of slices) {
    const id = slice.batchKey ?? '';
    const have = byKey.get(id);
    if (!have) {
      byKey.set(id, { ...slice });
      order.push(id);
      continue;
    }
    have.quantity = have.quantity.add(slice.quantity);
    have.costAmount =
      have.costAmount === null || slice.costAmount === null
        ? null
        : have.costAmount.add(slice.costAmount);
  }
  return order
    .map((id) => byKey.get(id))
    .filter((slice): slice is Slice => slice !== undefined && !slice.quantity.isZero());
}

/** Splits `total` over `weights` in 2 decimals with the rounding left over on the last. */
export function distributeMoney(
  total: Prisma.Decimal,
  weights: readonly Prisma.Decimal[],
): Prisma.Decimal[] {
  const sum = weights.reduce((acc, w) => acc.add(w), ZERO);
  if (weights.length === 0) return [];
  if (sum.isZero()) return weights.map((_, at) => (at === weights.length - 1 ? total : ZERO));
  const parts: Prisma.Decimal[] = [];
  let given = ZERO;
  weights.forEach((weight, at) => {
    if (at === weights.length - 1) {
      parts.push(total.sub(given));
    } else {
      const part = total.mul(weight).div(sum).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      parts.push(part);
      given = given.add(part);
    }
  });
  return parts;
}

/** What a delivery line freezes onto itself: the cost of its known bags and how many had none. */
export function snapshotOf(slices: readonly Slice[]): {
  unitCost: Prisma.Decimal | null;
  costAmount: Prisma.Decimal | null;
  uncostedQuantity: Prisma.Decimal;
} {
  let costAmount: Prisma.Decimal | null = null;
  let known = ZERO;
  let uncosted = ZERO;
  for (const slice of slices) {
    if (slice.costAmount === null) {
      uncosted = uncosted.add(slice.quantity);
    } else {
      costAmount = (costAmount ?? ZERO).add(slice.costAmount);
      known = known.add(slice.quantity);
    }
  }
  return {
    unitCost:
      costAmount !== null && known.greaterThan(0) ? costAmount.div(known).toDecimalPlaces(6) : null,
    costAmount,
    uncostedQuantity: uncosted,
  };
}

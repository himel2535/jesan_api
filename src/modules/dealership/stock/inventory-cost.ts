import { Prisma } from '../../../generated/prisma/client';

/**
 * Moving weighted average cost, as pure arithmetic over two pools.
 *
 * A product's stock is held in two pools that never mix:
 *
 * - the **costed** pool: bags whose acquisition price is known, carried as a
 *   quantity and a total value. The average is always derived from the value
 *   (`value / quantity`), never stored, so a rounded average can never drift
 *   away from the money.
 * - the **uncosted** pool: bags that arrived with no price — a "found bags"
 *   adjustment has no document and no cost behind it. They are counted but
 *   never valued, and a later purchase must never retro-price them.
 *
 * Nothing here touches the database or rounds to 2 decimal places: money is
 * rounded only when the API serialises it. Values are quantised to
 * `VALUE_SCALE` so repeated division cannot grow an unbounded tail.
 */

/** Decimal places kept for stored values and unit costs. */
export const VALUE_SCALE = 6;

const ZERO = new Prisma.Decimal(0);

export interface Pools {
  /** Bags whose cost is known. */
  costedQuantity: Prisma.Decimal;
  /** Total acquisition value of the costed pool. */
  costedValue: Prisma.Decimal;
  /** Bags on hand with no cost basis. */
  uncostedQuantity: Prisma.Decimal;
}

export function emptyPools(): Pools {
  return { costedQuantity: ZERO, costedValue: ZERO, uncostedQuantity: ZERO };
}

/** Total bags on hand; must always equal the product's `currentStock`. */
export function totalQuantity(pools: Pools): Prisma.Decimal {
  return pools.costedQuantity.add(pools.uncostedQuantity);
}

/**
 * The moving weighted average of the costed pool, or null when nothing costed
 * is on hand. Derived on every read; never stored.
 */
export function averageCost(pools: Pools): Prisma.Decimal | null {
  if (pools.costedQuantity.lessThanOrEqualTo(0)) return null;
  return pools.costedValue.div(pools.costedQuantity).toDecimalPlaces(VALUE_SCALE);
}

/**
 * Goods in. With a known `unitCost` they join the costed pool and move the
 * average; without one they join the uncosted pool, which leaves the average
 * exactly as it was.
 */
export function applyReceipt(
  pools: Pools,
  quantity: Prisma.Decimal,
  unitCost: Prisma.Decimal | null,
): Pools {
  if (quantity.lessThanOrEqualTo(0)) return pools;
  if (unitCost === null) {
    return { ...pools, uncostedQuantity: pools.uncostedQuantity.add(quantity) };
  }
  return {
    ...pools,
    costedQuantity: pools.costedQuantity.add(quantity),
    costedValue: pools.costedValue.add(quantity.mul(unitCost)).toDecimalPlaces(VALUE_SCALE),
  };
}

/**
 * A receipt undone: a purchase voided, or a purchase line cut back. The bags
 * leave at the price they arrived at, not at today's average, so the pool ends
 * up exactly where it would have been had the purchase never happened. Costing
 * them at the average instead would leave the price of goods that were never
 * really bought smeared across the stock that remains.
 */
export function applyReceiptReversal(
  pools: Pools,
  quantity: Prisma.Decimal,
  unitCost: Prisma.Decimal | null,
): Pools {
  if (quantity.lessThanOrEqualTo(0)) return pools;
  if (unitCost === null) {
    // No price to reverse: fall back to taking the bags out of the uncosted
    // pool first, then at the average.
    return applyIssue(pools, quantity).pools;
  }
  const taken = Prisma.Decimal.min(quantity, pools.costedQuantity);
  const value = Prisma.Decimal.min(taken.mul(unitCost), pools.costedValue);
  return {
    costedQuantity: pools.costedQuantity.sub(taken),
    costedValue: pools.costedValue.sub(value).toDecimalPlaces(VALUE_SCALE),
    uncostedQuantity: pools.uncostedQuantity.sub(quantity.sub(taken)),
  };
}

export interface IssueResult {
  pools: Pools;
  /** The average at the moment of issue — the snapshot a delivery line keeps. */
  unitCost: Prisma.Decimal | null;
  /** Value taken out of the costed pool: this line's cost of goods sold. */
  costAmount: Prisma.Decimal;
  /** How much of the issue came from the costed pool. */
  costedQuantity: Prisma.Decimal;
  /** How much came from the uncosted pool — delivered with no cost basis. */
  uncostedQuantity: Prisma.Decimal;
  /** Value left stranded when the costed pool emptied; booked as a residual. */
  roundingResidual: Prisma.Decimal;
}

/**
 * Goods out (a delivery, a negative adjustment, a reversed receipt). The costed
 * pool is consumed first so ordinary trading stays fully costed and bags of
 * unknown price stay confined to the tail; whatever spills past it is reported
 * as uncosted rather than priced at a number nobody knows.
 *
 * `costAmount` is computed from the pool's value in one division
 * (`value × taken / quantity`), not by multiplying a rounded average, so the
 * remaining value stays exact. When the costed pool empties, any residue left
 * by earlier rounding is returned as `roundingResidual` and the pool is zeroed,
 * so drift is surfaced as an auditable number instead of persisting silently.
 */
export function applyIssue(pools: Pools, quantity: Prisma.Decimal): IssueResult {
  if (quantity.lessThanOrEqualTo(0)) {
    return {
      pools,
      unitCost: averageCost(pools),
      costAmount: ZERO,
      costedQuantity: ZERO,
      uncostedQuantity: ZERO,
      roundingResidual: ZERO,
    };
  }
  const unitCost = averageCost(pools);
  const fromCosted = Prisma.Decimal.min(quantity, pools.costedQuantity);
  const fromUncosted = quantity.sub(fromCosted);

  let costAmount = ZERO;
  if (fromCosted.greaterThan(0)) {
    costAmount = pools.costedValue
      .mul(fromCosted)
      .div(pools.costedQuantity)
      .toDecimalPlaces(VALUE_SCALE);
  }

  const costedQuantityAfter = pools.costedQuantity.sub(fromCosted);
  let costedValueAfter = pools.costedValue.sub(costAmount);
  let roundingResidual = ZERO;
  if (costedQuantityAfter.isZero() && !costedValueAfter.isZero()) {
    // The pool is empty, so no value may remain behind it.
    roundingResidual = costedValueAfter;
    costedValueAfter = ZERO;
  }

  return {
    pools: {
      costedQuantity: costedQuantityAfter,
      costedValue: costedValueAfter,
      uncostedQuantity: pools.uncostedQuantity.sub(fromUncosted),
    },
    unitCost,
    costAmount,
    costedQuantity: fromCosted,
    uncostedQuantity: fromUncosted,
    roundingResidual,
  };
}

/**
 * Goods back in from a voided or reduced delivery. They return at the unit cost
 * snapshotted when they left, not at today's average, so the value put back is
 * exactly the value taken out and the average is undisturbed. The part that
 * left uncosted returns uncosted.
 */
export function applyReturn(
  pools: Pools,
  returned: {
    costedQuantity: Prisma.Decimal;
    unitCost: Prisma.Decimal | null;
    uncostedQuantity: Prisma.Decimal;
  },
): Pools {
  let next = pools;
  if (returned.costedQuantity.greaterThan(0) && returned.unitCost !== null) {
    next = {
      ...next,
      costedQuantity: next.costedQuantity.add(returned.costedQuantity),
      costedValue: next.costedValue
        .add(returned.costedQuantity.mul(returned.unitCost))
        .toDecimalPlaces(VALUE_SCALE),
    };
  } else if (returned.costedQuantity.greaterThan(0)) {
    // The original line has no snapshot (delivered before costing existed), so
    // its bags come back without a cost rather than inventing one.
    next = { ...next, uncostedQuantity: next.uncostedQuantity.add(returned.costedQuantity) };
  }
  if (returned.uncostedQuantity.greaterThan(0)) {
    next = { ...next, uncostedQuantity: next.uncostedQuantity.add(returned.uncostedQuantity) };
  }
  return next;
}

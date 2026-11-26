import { Prisma } from '../../../generated/prisma/client';

const ZERO = new Prisma.Decimal(0);

export interface CalendarRange {
  from: string;
  to: string;
}

/** Calendar range of one month, `YYYY-MM-01` to its last day (no time zone math needed). */
export function monthRange(year: number, month: number): CalendarRange {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return {
    from: `${String(year)}-${mm}-01`,
    to: `${String(year)}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** `YYYY-MM` key for the month of a calendar date (`YYYY-MM-DD`). */
export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/** `YYYY-MM` key for a month number (1-12). */
export function monthKey(year: number, month: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

/**
 * Which cash-position bucket a ledger row belongs to. Rows without a method (for
 * example, commission receipts carry none) are `unassigned`, so the three buckets
 * always add up to the whole ledger instead of silently dropping money.
 */
export type CashBucket = 'cash' | 'bank' | 'unassigned';

export function bucketOf(method: string | null, cashMethods: ReadonlySet<string>): CashBucket {
  if (method === null) return 'unassigned';
  return cashMethods.has(method) ? 'cash' : 'bank';
}

export interface LedgerGroupRow {
  type: string;
  method: string | null;
  direction: string;
  amount: Prisma.Decimal;
}

export interface BucketAmounts {
  /** Net balance of every active row before the period. */
  opening: Prisma.Decimal;
  /** Collections (type `collection`) received in the period. */
  collectionsIn: Prisma.Decimal;
  /** All money in during the period (collections, commission receipts, manual entries). */
  in: Prisma.Decimal;
  /** All money out during the period (expenses, purchases, supplier payments, manual entries). */
  out: Prisma.Decimal;
}

export function emptyBucket(): BucketAmounts {
  return { opening: ZERO, collectionsIn: ZERO, in: ZERO, out: ZERO };
}

/**
 * Folds grouped ledger rows into the three cash-position buckets. `periodRows` are the
 * active rows dated inside the range; `openingRows` the active rows dated before it.
 */
export function foldLedgerBuckets(
  periodRows: LedgerGroupRow[],
  openingRows: LedgerGroupRow[],
  cashMethods: ReadonlySet<string>,
): Record<CashBucket, BucketAmounts> {
  const buckets: Record<CashBucket, BucketAmounts> = {
    cash: emptyBucket(),
    bank: emptyBucket(),
    unassigned: emptyBucket(),
  };
  for (const row of openingRows) {
    const bucket = buckets[bucketOf(row.method, cashMethods)];
    bucket.opening = bucket.opening.add(row.direction === 'in' ? row.amount : row.amount.neg());
  }
  for (const row of periodRows) {
    const bucket = buckets[bucketOf(row.method, cashMethods)];
    if (row.direction === 'in') {
      bucket.in = bucket.in.add(row.amount);
      if (row.type === 'collection') bucket.collectionsIn = bucket.collectionsIn.add(row.amount);
    } else {
      bucket.out = bucket.out.add(row.amount);
    }
  }
  return buckets;
}

export function closingOf(bucket: BucketAmounts): Prisma.Decimal {
  return bucket.opening.add(bucket.in).sub(bucket.out);
}

export function sumDecimals(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((total, value) => total.add(value), ZERO);
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  addDays,
  fromDbDate,
  isCalendarDate,
  toDbDate,
  todayIn,
} from '../../../core/common/business-time';
import { badRequest } from '../../../core/errors';
import { moneyString } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveDateRange, type DateRange } from '../business-dates';
import { DealershipContext } from '../master-data/master-data.context';
import {
  DashboardCashbookQueryDto,
  DashboardKpisQueryDto,
  DashboardYearQueryDto,
} from './dto/requests';
import {
  monthKey,
  monthKeyOf,
  foldLedgerBuckets,
  closingOf,
  sumDecimals,
  type BucketAmounts,
  type LedgerGroupRow,
} from './dashboard.helpers';

const ZERO = new Prisma.Decimal(0);

/**
 * Read-only dashboard aggregates. Every figure is a database sum over active rows
 * (voided rows never count). Dates are the business's calendar dates (Asia/Dhaka by
 * default); the year and month edges come from the business time zone, not the server clock.
 * Each query is one `GROUP BY` over an indexed date column, so the cost is bounded by the
 * number of days in the year, never by the number of rows.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
  ) {}

  /** Cash, bank and unassigned positions from the ledger, with opening and closing balances. */
  async cashbook(access: BusinessAccess, query: DashboardCashbookQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const cashMethods = new Set(config.cashMethodKeys);

    const [openingGroups, periodGroups] = await Promise.all([
      db.businessLedgerEntry.groupBy({
        by: ['type', 'method', 'direction'],
        where: { status: 'active', entryDate: { lt: toDbDate(from) } },
        _sum: { amount: true },
      }),
      db.businessLedgerEntry.groupBy({
        by: ['type', 'method', 'direction'],
        where: {
          status: 'active',
          entryDate: { gte: toDbDate(from), lte: toDbDate(to) },
        },
        _sum: { amount: true },
      }),
    ]);

    const buckets = foldLedgerBuckets(
      toLedgerRows(periodGroups),
      toLedgerRows(openingGroups),
      cashMethods,
    );

    const cash = view(buckets.cash);
    const bank = view(buckets.bank);
    return {
      from,
      to,
      cash,
      bank,
      unassigned: view(buckets.unassigned),
      availableCashAndBank: moneyString(closingOf(buckets.cash).add(closingOf(buckets.bank))),
    };
  }

  /**
   * The KPI cards' four figures (collection, sales, bags sold, bags bought) for one window and,
   * when `prevFrom`/`prevTo` are sent, a comparison window. Each figure is one indexed aggregate
   * over active rows, and the windows run in parallel, so one request replaces what used to be a
   * paginated report call per figure.
   * Codes: `PREV_FROM_REQUIRED` / `PREV_TO_REQUIRED` / `PREV_FROM_INVALID` / `PREV_TO_INVALID`.
   */
  async kpis(access: BusinessAccess, query: DashboardKpisQueryDto) {
    const config = await this.context.config(access.businessId);
    const current = resolveDateRange(query, config.timezone);
    const previous = resolvePreviousRange(query);
    const db = this.prisma.forBusiness(access.businessId);

    const [now, before] = await Promise.all([
      kpiWindow(db, current),
      previous ? kpiWindow(db, previous) : Promise.resolve(null),
    ]);
    return { current: now, previous: before };
  }

  /**
   * Twelve months of collection, sales, purchase amount and quantities for one year.
   * Purchase amount is always computed; the response DTO hides it unless the caller has
   * `product.cost.view`.
   */
  async monthlySeries(access: BusinessAccess, query: DashboardYearQueryDto) {
    const config = await this.context.config(access.businessId);
    const year = query.year ?? Number(todayIn(config.timezone).slice(0, 4));
    const db = this.prisma.forBusiness(access.businessId);
    const range = {
      gte: toDbDate(`${String(year)}-01-01`),
      lte: toDbDate(`${String(year)}-12-31`),
    };

    const [collections, deliveries, purchases] = await Promise.all([
      db.collection.groupBy({
        by: ['collectionDate'],
        where: { status: 'active', collectionDate: range },
        _sum: { amount: true },
      }),
      db.delivery.groupBy({
        by: ['deliveryDate'],
        where: { status: 'active', deliveryDate: range },
        _sum: { totalAmount: true, totalQuantity: true },
      }),
      db.purchase.groupBy({
        by: ['purchaseDate'],
        where: { status: 'active', purchaseDate: range },
        _sum: { totalAmount: true, totalQuantity: true },
      }),
    ]);

    const rows = new Map<
      string,
      {
        collection: Prisma.Decimal;
        sales: Prisma.Decimal;
        salesQuantity: Prisma.Decimal;
        purchaseAmount: Prisma.Decimal;
        purchaseQuantity: Prisma.Decimal;
      }
    >();
    for (let month = 1; month <= 12; month += 1) {
      rows.set(monthKey(year, month), {
        collection: ZERO,
        sales: ZERO,
        salesQuantity: ZERO,
        purchaseAmount: ZERO,
        purchaseQuantity: ZERO,
      });
    }
    const at = (date: Date) => rows.get(monthKeyOf(fromDbDate(date)));

    for (const row of collections) {
      const month = at(row.collectionDate);
      if (month) month.collection = month.collection.add(row._sum.amount ?? ZERO);
    }
    for (const row of deliveries) {
      const month = at(row.deliveryDate);
      if (!month) continue;
      month.sales = month.sales.add(row._sum.totalAmount ?? ZERO);
      month.salesQuantity = month.salesQuantity.add(row._sum.totalQuantity ?? ZERO);
    }
    for (const row of purchases) {
      const month = at(row.purchaseDate);
      if (!month) continue;
      month.purchaseAmount = month.purchaseAmount.add(row._sum.totalAmount ?? ZERO);
      month.purchaseQuantity = month.purchaseQuantity.add(row._sum.totalQuantity ?? ZERO);
    }

    return {
      year,
      months: [...rows.entries()].map(([month, sums]) => ({
        month,
        collection: moneyString(sums.collection),
        sales: moneyString(sums.sales),
        salesQuantity: sums.salesQuantity.toFixed(3),
        purchaseQuantity: sums.purchaseQuantity.toFixed(3),
        purchaseAmount: moneyString(sums.purchaseAmount),
      })),
    };
  }

  /**
   * The Financial Summary, every figure over one window and all from one call,
   * so the panel can never show two numbers that disagree about the period.
   *
   * Net profit = sales − cost of goods sold − expenses + commission received.
   * Purchases are deliberately *not* subtracted: bags still in the warehouse are
   * an asset, not a cost. Only what was actually delivered is taken out, at the
   * FIFO cost frozen onto each delivery line (each bag at the price of the batch
   * it came from), plus any correction booked in this period for history that was
   * edited later. Bags with no known cost are counted and flagged, never priced at
   * zero: `costComplete` is false while any were delivered in the window.
   *
   * Collection and customer due are reported but never fed into profit: money
   * coming in is not revenue, and a receivable is not an expense.
   */
  async financeSummary(access: BusinessAccess, query: DashboardCashbookQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const range = { gte: toDbDate(from), lte: toDbDate(to) };

    const dayBefore = toDbDate(addDays(from, -1));
    const [
      deliveries,
      purchases,
      ledger,
      due,
      stock,
      snapshots,
      corrections,
      deliveredLines,
      products,
      stockQuantityOpening,
      stockQuantityClosing,
      valueOpening,
      valueClosing,
    ] = await Promise.all([
      db.delivery.aggregate({
        where: { status: 'active', deliveryDate: range },
        _sum: { totalAmount: true },
      }),
      db.purchase.aggregate({
        where: { status: 'active', purchaseDate: range },
        _sum: { totalAmount: true, totalQuantity: true },
      }),
      db.businessLedgerEntry.groupBy({
        by: ['type', 'direction'],
        where: { status: 'active', entryDate: range },
        _sum: { amount: true },
      }),
      db.customer.aggregate({
        where: { isActive: true, currentBalance: { gt: 0 } },
        _sum: { currentBalance: true },
      }),
      db.product.aggregate({
        _sum: { currentStock: true, costedValue: true },
      }),
      // Cost of goods sold: the frozen snapshot on every line delivered in the
      // window. A line's delivery decides the period, not when it was costed.
      db.deliveryItem.findMany({
        where: { status: 'active', delivery: { status: 'active', deliveryDate: range } },
        select: { costAmount: true, uncostedQuantity: true },
      }),
      db.inventoryCostCorrection.aggregate({
        where: { correctionDate: range },
        _sum: { cogsDelta: true },
      }),
      // Lines whose cost is not (fully) known: no cost at all, or some bags with none.
      db.deliveryItem.count({
        where: {
          status: 'active',
          OR: [{ costAmount: null }, { uncostedQuantity: { gt: 0 } }],
          delivery: { status: 'active', deliveryDate: range },
        },
      }),
      db.product.findMany({ select: { currentStock: true, costedQuantity: true } }),
      db.stockMovement.aggregate({
        where: { movementDate: { lte: dayBefore } },
        _sum: { quantity: true },
      }),
      db.stockMovement.aggregate({
        where: { movementDate: { lte: toDbDate(to) } },
        _sum: { quantity: true },
      }),
      this.stockValueAt(db, dayBefore),
      this.stockValueAt(db, toDbDate(to)),
    ]);

    const amountOf = (type: string, direction: 'in' | 'out') =>
      ledger.find((row) => row.type === type && row.direction === direction)?._sum.amount ?? ZERO;

    const sales = deliveries._sum.totalAmount ?? ZERO;
    const expenses = amountOf('expense', 'out');
    const commissionReceived = amountOf('commission_receipt', 'in');
    const collection = amountOf('collection', 'in');
    const cogs = snapshots
      .reduce((sum, line) => sum.add(line.costAmount ?? ZERO), ZERO)
      .add(corrections._sum.cogsDelta ?? ZERO);
    const uncostedDelivered = snapshots.reduce((sum, line) => sum.add(line.uncostedQuantity), ZERO);
    // Bags on hand with no known cost: everything not held in a costed batch (found bags, and
    // stock from before batches existed).
    const onHand = products.reduce((sum, row) => sum.add(row.currentStock), ZERO);
    const costedOnHand = products.reduce((sum, row) => sum.add(row.costedQuantity), ZERO);
    const productsWithUnknownCost = products.filter((row) =>
      row.currentStock.greaterThan(row.costedQuantity),
    ).length;

    return {
      from,
      to,
      sales: moneyString(sales),
      collection: moneyString(collection),
      customerDue: moneyString(due._sum.currentBalance ?? ZERO),
      expenses: moneyString(expenses),
      commissionReceived: moneyString(commissionReceived),
      totalPurchase: moneyString(purchases._sum.totalAmount ?? ZERO),
      currentStockQuantity: (stock._sum.currentStock ?? ZERO).toFixed(3),
      currentStockValue: moneyString((stock._sum.costedValue ?? ZERO).toDecimalPlaces(2)),
      cogs: moneyString(cogs.toDecimalPlaces(2)),
      grossProfit: moneyString(sales.sub(cogs).toDecimalPlaces(2)),
      netProfit: moneyString(
        sales.sub(cogs).sub(expenses).add(commissionReceived).toDecimalPlaces(2),
      ),
      // Non-zero means cost of goods sold is understated by an unknown amount,
      // so the dashboard warns rather than presenting the profit as complete.
      uncostedQuantityDelivered: uncostedDelivered.toFixed(3),
      uncostedQuantityOnHand: onHand.sub(costedOnHand).toFixed(3),
      uncostedDeliveryLines: deliveredLines,
      productsWithUnknownCostStock: productsWithUnknownCost,
      // True only when every bag delivered in the window had a known cost; otherwise the
      // cost of goods sold, gross profit and net profit are incomplete, not verified.
      costComplete: uncostedDelivered.isZero() && deliveredLines === 0,
      purchaseQuantity: (purchases._sum.totalQuantity ?? ZERO).toFixed(3),
      openingStockQuantity: (stockQuantityOpening._sum.quantity ?? ZERO).toFixed(3),
      closingStockQuantity: (stockQuantityClosing._sum.quantity ?? ZERO).toFixed(3),
      openingStockValue: moneyString(valueOpening.toDecimalPlaces(2)),
      closingStockValue: moneyString(valueClosing.toDecimalPlaces(2)),
    };
  }

  /**
   * What the costed stock was worth at the end of `date`: everything received, edited or
   * written off up to then (batch events), less the known cost of every bag delivered up to
   * then. Deliveries count on their delivery date; adjustments made by corrected history on
   * the day they were booked, so a closed month never changes. Stock whose cost is unknown
   * has no value here.
   */
  private async stockValueAt(
    db: ReturnType<PrismaService['forBusiness']>,
    date: Date,
  ): Promise<Prisma.Decimal> {
    const [events, delivered, adjusted] = await Promise.all([
      db.inventoryBatchEvent.aggregate({
        where: { businessDate: { lte: date } },
        _sum: { valueDelta: true },
      }),
      db.deliveryItemAllocation.aggregate({
        where: {
          kind: { in: ['original', 'reversal'] },
          deliveryItem: { delivery: { deliveryDate: { lte: date } } },
        },
        _sum: { costAmount: true },
      }),
      db.deliveryItemAllocation.aggregate({
        where: { kind: 'adjustment', allocationDate: { lte: date } },
        _sum: { costAmount: true },
      }),
    ]);
    return (events._sum.valueDelta ?? ZERO)
      .sub(delivered._sum.costAmount ?? ZERO)
      .sub(adjusted._sum.costAmount ?? ZERO);
  }

  /**
   * Commission received by month (entries by `receivedDate`), plus the year and
   * lifetime totals.
   */
  async commissionSeries(access: BusinessAccess, query: DashboardYearQueryDto) {
    const config = await this.context.config(access.businessId);
    const year = query.year ?? Number(todayIn(config.timezone).slice(0, 4));
    const db = this.prisma.forBusiness(access.businessId);
    const range = {
      gte: toDbDate(`${String(year)}-01-01`),
      lte: toDbDate(`${String(year)}-12-31`),
    };

    const [receipts, lifetimeReceipts] = await Promise.all([
      db.commissionReceipt.groupBy({
        by: ['receivedDate'],
        where: { receivedDate: range },
        _sum: { amount: true },
      }),
      db.commissionReceipt.aggregate({ _sum: { amount: true } }),
    ]);

    const receivedByMonth = new Map<string, Prisma.Decimal>();
    for (let month = 1; month <= 12; month += 1) {
      receivedByMonth.set(monthKey(year, month), ZERO);
    }
    for (const row of receipts) {
      const key = monthKeyOf(fromDbDate(row.receivedDate));
      receivedByMonth.set(key, (receivedByMonth.get(key) ?? ZERO).add(row._sum.amount ?? ZERO));
    }

    return {
      year,
      months: [...receivedByMonth.keys()].map((month) => ({
        month,
        received: moneyString(receivedByMonth.get(month) ?? ZERO),
      })),
      yearReceived: moneyString(sumDecimals([...receivedByMonth.values()])),
      lifetimeReceived: moneyString(lifetimeReceipts._sum.amount ?? ZERO),
    };
  }
}

/** The comparison window of a KPI request, or `null` when none was asked for. */
function resolvePreviousRange(query: {
  prevFrom?: string | undefined;
  prevTo?: string | undefined;
}): DateRange | null {
  const { prevFrom, prevTo } = query;
  if (prevFrom === undefined && prevTo === undefined) {
    return null;
  }
  if (prevFrom === undefined) {
    throw badRequest('PREV_FROM_REQUIRED', 'prevFrom is needed together with prevTo', 'prevFrom');
  }
  if (prevTo === undefined) {
    throw badRequest('PREV_TO_REQUIRED', 'prevTo is needed together with prevFrom', 'prevTo');
  }
  if (!isCalendarDate(prevFrom)) {
    throw badRequest('PREV_FROM_INVALID', 'Not a real date', 'prevFrom');
  }
  if (!isCalendarDate(prevTo) || prevTo < prevFrom) {
    throw badRequest('PREV_TO_INVALID', 'Not a real date, or before prevFrom', 'prevTo');
  }
  return { from: prevFrom, to: prevTo };
}

async function kpiWindow(db: ReturnType<PrismaService['forBusiness']>, range: DateRange) {
  const dates = { gte: toDbDate(range.from), lte: toDbDate(range.to) };
  const [collections, deliveries, purchases] = await Promise.all([
    db.collection.aggregate({
      where: { status: 'active', collectionDate: dates },
      _sum: { amount: true },
    }),
    db.delivery.aggregate({
      where: { status: 'active', deliveryDate: dates },
      _sum: { totalAmount: true, totalQuantity: true },
    }),
    db.purchase.aggregate({
      where: { status: 'active', purchaseDate: dates },
      _sum: { totalQuantity: true },
    }),
  ]);
  return {
    from: range.from,
    to: range.to,
    collection: moneyString(collections._sum.amount ?? ZERO),
    sales: moneyString(deliveries._sum.totalAmount ?? ZERO),
    salesQuantity: (deliveries._sum.totalQuantity ?? ZERO).toFixed(3),
    purchaseQuantity: (purchases._sum.totalQuantity ?? ZERO).toFixed(3),
  };
}

function toLedgerRows(
  groups: {
    type: string;
    method: string | null;
    direction: string;
    _sum: { amount: Prisma.Decimal | null };
  }[],
): LedgerGroupRow[] {
  return groups.map((row) => ({
    type: row.type,
    method: row.method,
    direction: row.direction,
    amount: row._sum.amount ?? ZERO,
  }));
}

function view(bucket: BucketAmounts) {
  return {
    opening: moneyString(bucket.opening),
    collectionsIn: moneyString(bucket.collectionsIn),
    in: moneyString(bucket.in),
    out: moneyString(bucket.out),
    closing: moneyString(closingOf(bucket)),
  };
}

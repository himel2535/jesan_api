import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, toDbDate, todayIn } from '../../../core/common/business-time';
import { moneyString } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveDateRange } from '../business-dates';
import { DealershipContext } from '../master-data/master-data.context';
import { DashboardCashbookQueryDto, DashboardYearQueryDto } from './dto/requests';
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
   * Commission by month: calculated (entries by `fromDate`) and received (receipts by
   * `receivedDate`), kept separate. Receivable = calculated − received over all time.
   */
  async commissionSeries(access: BusinessAccess, query: DashboardYearQueryDto) {
    const config = await this.context.config(access.businessId);
    const year = query.year ?? Number(todayIn(config.timezone).slice(0, 4));
    const db = this.prisma.forBusiness(access.businessId);
    const range = {
      gte: toDbDate(`${String(year)}-01-01`),
      lte: toDbDate(`${String(year)}-12-31`),
    };

    const [entries, receipts, lifetimeEntries, lifetimeReceipts] = await Promise.all([
      db.commissionEntry.groupBy({
        by: ['fromDate'],
        where: { fromDate: range },
        _sum: { calculatedAmount: true },
      }),
      db.commissionReceipt.groupBy({
        by: ['receivedDate'],
        where: { receivedDate: range },
        _sum: { amount: true },
      }),
      db.commissionEntry.aggregate({ _sum: { calculatedAmount: true } }),
      db.commissionReceipt.aggregate({ _sum: { amount: true } }),
    ]);

    const calculatedByMonth = new Map<string, Prisma.Decimal>();
    const receivedByMonth = new Map<string, Prisma.Decimal>();
    for (let month = 1; month <= 12; month += 1) {
      calculatedByMonth.set(monthKey(year, month), ZERO);
      receivedByMonth.set(monthKey(year, month), ZERO);
    }
    for (const row of entries) {
      const key = monthKeyOf(fromDbDate(row.fromDate));
      calculatedByMonth.set(
        key,
        (calculatedByMonth.get(key) ?? ZERO).add(row._sum.calculatedAmount ?? ZERO),
      );
    }
    for (const row of receipts) {
      const key = monthKeyOf(fromDbDate(row.receivedDate));
      receivedByMonth.set(key, (receivedByMonth.get(key) ?? ZERO).add(row._sum.amount ?? ZERO));
    }

    const yearCalculated = sumDecimals([...calculatedByMonth.values()]);
    const yearReceived = sumDecimals([...receivedByMonth.values()]);
    const lifetimeCalculated = lifetimeEntries._sum.calculatedAmount ?? ZERO;
    const lifetimeReceived = lifetimeReceipts._sum.amount ?? ZERO;

    return {
      year,
      months: [...calculatedByMonth.keys()].map((month) => ({
        month,
        calculated: moneyString(calculatedByMonth.get(month) ?? ZERO),
        received: moneyString(receivedByMonth.get(month) ?? ZERO),
      })),
      yearCalculated: moneyString(yearCalculated),
      yearReceived: moneyString(yearReceived),
      lifetimeCalculated: moneyString(lifetimeCalculated),
      lifetimeReceived: moneyString(lifetimeReceived),
      receivable: moneyString(lifetimeCalculated.sub(lifetimeReceived)),
    };
  }
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

import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, toDbDate } from '../../../core/common/business-time';
import { moneyString } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { resolveDateRange } from '../business-dates';
import { PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { CashBookQueryDto } from './dto/requests';

const ZERO = new Prisma.Decimal(0);

interface MethodSum {
  date: string;
  method: string;
  amount: Prisma.Decimal;
}

/**
 * The daily cash book: nothing is a second source of truth. Every figure is a
 * sum over the real rows (collections, expenses, cash purchases); voided rows
 * never count (their `status` is not 'active'). The business's own time zone
 * decides where one day ends and the next begins (`business-dates.ts`).
 */
@Injectable()
export class CashBookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
  ) {}

  async read(access: BusinessAccess, query: CashBookQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const cashMethods = new Set(config.cashMethodKeys);

    const [collectionsBefore, expensesBefore, purchasesBefore, collections, expenses, purchases] =
      await Promise.all([
        db.collection.aggregate({
          where: { status: 'active', collectionDate: { lt: toDbDate(from) } },
          _sum: { amount: true },
        }),
        db.expense.aggregate({
          where: { status: 'active', expenseDate: { lt: toDbDate(from) } },
          _sum: { amount: true },
        }),
        db.purchase.aggregate({
          where: {
            status: 'active',
            purchaseDate: { lt: toDbDate(from) },
            paymentMethod: { in: config.cashMethodKeys },
          },
          _sum: { totalAmount: true },
        }),
        db.collection.groupBy({
          by: ['collectionDate', 'method'],
          where: { status: 'active', collectionDate: { gte: toDbDate(from), lte: toDbDate(to) } },
          _sum: { amount: true },
        }),
        db.expense.groupBy({
          by: ['expenseDate', 'method'],
          where: { status: 'active', expenseDate: { gte: toDbDate(from), lte: toDbDate(to) } },
          _sum: { amount: true },
        }),
        db.purchase.groupBy({
          by: ['purchaseDate', 'paymentMethod'],
          where: {
            status: 'active',
            purchaseDate: { gte: toDbDate(from), lte: toDbDate(to) },
            paymentMethod: { in: config.cashMethodKeys },
          },
          _sum: { totalAmount: true },
        }),
      ]);

    const openingBalance = (collectionsBefore._sum.amount ?? ZERO)
      .sub(expensesBefore._sum.amount ?? ZERO)
      .sub(purchasesBefore._sum.totalAmount ?? ZERO);

    const collectionSums: MethodSum[] = collections.map((row) => ({
      date: fromDbDate(row.collectionDate),
      method: row.method,
      amount: row._sum.amount ?? ZERO,
    }));
    const expenseSums: MethodSum[] = expenses.map((row) => ({
      date: fromDbDate(row.expenseDate),
      method: row.method,
      amount: row._sum.amount ?? ZERO,
    }));
    const purchaseSums: MethodSum[] = purchases.map((row) => ({
      date: fromDbDate(row.purchaseDate),
      method: row.paymentMethod,
      amount: row._sum.totalAmount ?? ZERO,
    }));

    // Per-day totals (one row per day in the range that had activity).
    const days = new Map<
      string,
      { collections: Prisma.Decimal; expenses: Prisma.Decimal; purchases: Prisma.Decimal }
    >();
    const dayOf = (date: string) => {
      let row = days.get(date);
      if (!row) {
        row = { collections: ZERO, expenses: ZERO, purchases: ZERO };
        days.set(date, row);
      }
      return row;
    };
    for (const row of collectionSums) {
      const day = dayOf(row.date);
      day.collections = day.collections.add(row.amount);
    }
    for (const row of expenseSums) {
      const day = dayOf(row.date);
      day.expenses = day.expenses.add(row.amount);
    }
    for (const row of purchaseSums) {
      const day = dayOf(row.date);
      day.purchases = day.purchases.add(row.amount);
    }

    // Per-method totals across the whole range.
    const methods = new Map<string, { in: Prisma.Decimal; out: Prisma.Decimal }>();
    const methodOf = (key: string) => {
      let row = methods.get(key);
      if (!row) {
        row = { in: ZERO, out: ZERO };
        methods.set(key, row);
      }
      return row;
    };
    for (const row of collectionSums)
      methodOf(row.method).in = methodOf(row.method).in.add(row.amount);
    for (const row of expenseSums)
      methodOf(row.method).out = methodOf(row.method).out.add(row.amount);
    for (const row of purchaseSums)
      methodOf(row.method).out = methodOf(row.method).out.add(row.amount);
    // Every configured method appears even with no activity, so the frontend
    // never has to guess the business's method list.
    for (const method of [...config.collectionMethods, ...config.expenseMethods]) methodOf(method);

    const sortedDates = [...days.keys()].sort();
    const total = sortedDates.length;
    const page = Math.max(1, query.page);
    const pageDates = sortedDates.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    // Running balance up to the page's first day, so each page's rows are
    // self-contained without re-reading earlier pages.
    let running = openingBalance;
    for (const date of sortedDates) {
      if (pageDates.includes(date)) break;
      const day = dayOf(date);
      running = running.add(day.collections).sub(day.expenses).sub(day.purchases);
    }
    const dayRows = pageDates.map((date) => {
      const day = dayOf(date);
      const opening = running;
      const inAmount = day.collections;
      const outAmount = day.expenses.add(day.purchases);
      running = running.add(inAmount).sub(outAmount);
      return {
        date,
        opening: moneyString(opening),
        collections: moneyString(day.collections),
        expenses: moneyString(day.expenses),
        purchases: moneyString(day.purchases),
        in: moneyString(inAmount),
        out: moneyString(outAmount),
        closing: moneyString(running),
      };
    });

    const totalIn = collectionsSum(collectionSums);
    const totalExpenses = collectionsSum(expenseSums);
    const totalPurchases = collectionsSum(purchaseSums);
    const totalOut = totalExpenses.add(totalPurchases);
    const cashIn = sumWhere(collectionSums, (row) => cashMethods.has(row.method));
    const cashExpenseOut = sumWhere(expenseSums, (row) => cashMethods.has(row.method));
    const cashOut = cashExpenseOut.add(totalPurchases); // purchases were already filtered to cash methods

    return {
      from,
      to,
      openingBalance: moneyString(openingBalance),
      closingBalance: moneyString(running),
      totals: {
        collections: moneyString(totalIn),
        expenses: moneyString(totalExpenses),
        purchases: moneyString(totalPurchases),
        in: moneyString(totalIn),
        out: moneyString(totalOut),
        net: moneyString(totalIn.sub(totalOut)),
        cashIn: moneyString(cashIn),
        cashOut: moneyString(cashOut),
        cashNet: moneyString(cashIn.sub(cashOut)),
      },
      byMethod: [...methods.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([method, sums]) => ({
          method,
          isCash: cashMethods.has(method),
          in: moneyString(sums.in),
          out: moneyString(sums.out),
          net: moneyString(sums.in.sub(sums.out)),
        })),
      days: dayRows,
      page,
      pageSize: PAGE_SIZE,
      total,
    };
  }
}

function collectionsSum(rows: MethodSum[]): Prisma.Decimal {
  return rows.reduce((total, row) => total.add(row.amount), ZERO);
}

function sumWhere(rows: MethodSum[], predicate: (row: MethodSum) => boolean): Prisma.Decimal {
  return rows.filter(predicate).reduce((total, row) => total.add(row.amount), ZERO);
}

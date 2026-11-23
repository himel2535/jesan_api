import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, periodOf, toDbDate, todayIn } from '../../../core/common/business-time';
import { moneyString, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { daysBetween, resolveDateRange } from '../business-dates';
import { PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { CashBookService } from '../cashbook/cash-book.service';
import {
  CollectionsReportQueryDto,
  DailySummaryQueryDto,
  DuesReportQueryDto,
  ExpensesReportQueryDto,
  SalesReportQueryDto,
  StockMovementsReportQueryDto,
  StockReportQueryDto,
} from './dto/requests';

const ZERO = new Prisma.Decimal(0);

function sumOf(values: (Prisma.Decimal | null)[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((total, value) => total.add(value ?? ZERO), ZERO);
}

/**
 * The read-only reports. Every one is derived from the real rows (no report
 * table of its own), scoped to active rows, and never carries a purchase
 * price, profit or commission figure — those need `product.cost.view` /
 * `commission.view`, which this module's reports do not require.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly cashBook: CashBookService,
  ) {}

  async sales(access: BusinessAccess, query: SalesReportQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const range = { gte: toDbDate(from), lte: toDbDate(to) };

    if (query.groupBy === 'date') {
      const [rows, total] = await Promise.all([
        db.delivery.groupBy({
          by: ['deliveryDate'],
          where: { status: 'active', deliveryDate: range },
          _sum: { totalQuantity: true, totalAmount: true },
          orderBy: { deliveryDate: 'desc' },
          skip: (query.page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        db.delivery.groupBy({
          by: ['deliveryDate'],
          where: { status: 'active', deliveryDate: range },
          _count: true,
        }),
      ]);
      return this.salesResult(
        from,
        to,
        query.page,
        total.length,
        rows.map((row) => ({
          key: fromDbDate(row.deliveryDate),
          label: fromDbDate(row.deliveryDate),
          quantity: row._sum.totalQuantity ?? ZERO,
          amount: row._sum.totalAmount ?? ZERO,
        })),
        await this.totalsOfDeliveries(db, range),
        'date',
      );
    }

    if (query.groupBy === 'customer') {
      // `sort=quantity` (e.g. a "top customers by bags" widget) needs line
      // items filtered to the business's own sale unit (its `defaultUnitKey`,
      // e.g. "bag") so mixed-unit deliveries never get summed as one
      // meaningless quantity. The default `sort=amount` keeps the original
      // delivery-header totals (every unit, unchanged for existing callers).
      if (query.sort === 'quantity') {
        const itemRows = await db.deliveryItem.groupBy({
          by: ['deliveryId'],
          where: {
            status: 'active',
            delivery: { status: 'active', deliveryDate: range },
            product: { unitKey: config.defaultUnitKey },
          },
          _sum: { quantity: true, lineTotal: true },
        });
        const deliveries = await db.delivery.findMany({
          where: { id: { in: itemRows.map((row) => row.deliveryId) } },
          select: { id: true, customerId: true },
        });
        const customerOfDelivery = new Map(deliveries.map((row) => [row.id, row.customerId]));
        const byCustomer = new Map<string, { quantity: Prisma.Decimal; amount: Prisma.Decimal }>();
        for (const row of itemRows) {
          const customerId = customerOfDelivery.get(row.deliveryId);
          if (!customerId) continue;
          const bucket = byCustomer.get(customerId) ?? { quantity: ZERO, amount: ZERO };
          bucket.quantity = bucket.quantity.add(row._sum.quantity ?? ZERO);
          bucket.amount = bucket.amount.add(row._sum.lineTotal ?? ZERO);
          byCustomer.set(customerId, bucket);
        }
        const customers = await db.customer.findMany({
          where: { id: { in: [...byCustomer.keys()] } },
          select: { id: true, code: true, nameEn: true },
        });
        const nameOf = new Map(customers.map((row) => [row.id, `${row.code} ${row.nameEn}`]));
        const sorted = [...byCustomer.entries()]
          .map(([customerId, sums]) => ({
            key: customerId,
            label: nameOf.get(customerId) ?? customerId,
            quantity: sums.quantity,
            amount: sums.amount,
          }))
          .sort((a, b) => b.quantity.comparedTo(a.quantity));
        const page = sorted.slice((query.page - 1) * PAGE_SIZE, query.page * PAGE_SIZE);
        const totals = sorted.reduce(
          (acc, row) => ({
            quantity: acc.quantity.add(row.quantity),
            amount: acc.amount.add(row.amount),
          }),
          { quantity: ZERO, amount: ZERO },
        );
        return this.salesResult(from, to, query.page, sorted.length, page, totals, 'customer');
      }

      const [rows, total] = await Promise.all([
        db.delivery.groupBy({
          by: ['customerId'],
          where: { status: 'active', deliveryDate: range },
          _sum: { totalQuantity: true, totalAmount: true },
          orderBy: { _sum: { totalAmount: 'desc' } },
          skip: (query.page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        db.delivery.groupBy({
          by: ['customerId'],
          where: { status: 'active', deliveryDate: range },
        }),
      ]);
      const customers = await db.customer.findMany({
        where: { id: { in: rows.map((row) => row.customerId) } },
        select: { id: true, code: true, nameEn: true },
      });
      const nameOf = new Map(customers.map((row) => [row.id, `${row.code} ${row.nameEn}`]));
      return this.salesResult(
        from,
        to,
        query.page,
        total.length,
        rows.map((row) => ({
          key: row.customerId,
          label: nameOf.get(row.customerId) ?? row.customerId,
          quantity: row._sum.totalQuantity ?? ZERO,
          amount: row._sum.totalAmount ?? ZERO,
        })),
        await this.totalsOfDeliveries(db, range),
        'customer',
      );
    }

    // product and category both start from delivery line items.
    const [rows, itemTotals] = await Promise.all([
      db.deliveryItem.groupBy({
        by: ['productId'],
        where: { status: 'active', delivery: { status: 'active', deliveryDate: range } },
        _sum: { quantity: true, lineTotal: true },
      }),
      db.deliveryItem.aggregate({
        where: { status: 'active', delivery: { status: 'active', deliveryDate: range } },
        _sum: { quantity: true, lineTotal: true },
      }),
    ]);
    const products = await db.product.findMany({
      where: { id: { in: rows.map((row) => row.productId) } },
      select: { id: true, code: true, nameEn: true, categoryId: true },
    });
    const productOf = new Map(products.map((row) => [row.id, row]));

    if (query.groupBy === 'product') {
      const sorted = rows
        .map((row) => {
          const product = productOf.get(row.productId);
          return {
            key: row.productId,
            label: product ? `${product.code} ${product.nameEn}` : row.productId,
            quantity: row._sum.quantity ?? ZERO,
            amount: row._sum.lineTotal ?? ZERO,
          };
        })
        .sort((a, b) => b.amount.comparedTo(a.amount));
      const page = sorted.slice((query.page - 1) * PAGE_SIZE, query.page * PAGE_SIZE);
      return this.salesResult(
        from,
        to,
        query.page,
        sorted.length,
        page,
        { quantity: itemTotals._sum.quantity ?? ZERO, amount: itemTotals._sum.lineTotal ?? ZERO },
        'product',
      );
    }

    // category: fold the product groups into their categories.
    const categoryIds = [...new Set(products.map((row) => row.categoryId))];
    const categories = await db.productCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, nameEn: true },
    });
    const categoryNameOf = new Map(categories.map((row) => [row.id, row.nameEn]));
    const byCategory = new Map<string, { quantity: Prisma.Decimal; amount: Prisma.Decimal }>();
    for (const row of rows) {
      const categoryId = productOf.get(row.productId)?.categoryId;
      if (!categoryId) continue;
      const bucket = byCategory.get(categoryId) ?? { quantity: ZERO, amount: ZERO };
      bucket.quantity = bucket.quantity.add(row._sum.quantity ?? ZERO);
      bucket.amount = bucket.amount.add(row._sum.lineTotal ?? ZERO);
      byCategory.set(categoryId, bucket);
    }
    const sorted = [...byCategory.entries()]
      .map(([key, sums]) => ({
        key,
        label: categoryNameOf.get(key) ?? key,
        quantity: sums.quantity,
        amount: sums.amount,
      }))
      .sort((a, b) => b.amount.comparedTo(a.amount));
    const page = sorted.slice((query.page - 1) * PAGE_SIZE, query.page * PAGE_SIZE);
    return this.salesResult(
      from,
      to,
      query.page,
      sorted.length,
      page,
      { quantity: itemTotals._sum.quantity ?? ZERO, amount: itemTotals._sum.lineTotal ?? ZERO },
      'category',
    );
  }

  async collections(access: BusinessAccess, query: CollectionsReportQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const range = { gte: toDbDate(from), lte: toDbDate(to) };
    const where = { status: 'active', collectionDate: range } as const;

    const totalAmount = await db.collection.aggregate({ where, _sum: { amount: true } });

    if (query.groupBy === 'method') {
      const [rows, total] = await Promise.all([
        db.collection.groupBy({
          by: ['method'],
          where,
          _sum: { amount: true },
          _count: true,
          orderBy: { method: 'asc' },
          skip: (query.page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        db.collection.groupBy({ by: ['method'], where }),
      ]);
      return {
        from,
        to,
        groupBy: query.groupBy,
        items: rows.map((row) => ({
          key: row.method,
          count: row._count,
          amount: moneyString(row._sum.amount ?? ZERO),
        })),
        totalAmount: moneyString(totalAmount._sum.amount ?? ZERO),
        page: query.page,
        pageSize: PAGE_SIZE,
        total: total.length,
      };
    }

    const [rows, total] = await Promise.all([
      db.collection.groupBy({
        by: ['collectionDate'],
        where,
        _sum: { amount: true },
        _count: true,
        orderBy: { collectionDate: 'desc' },
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.collection.groupBy({ by: ['collectionDate'], where }),
    ]);
    return {
      from,
      to,
      groupBy: query.groupBy,
      items: rows.map((row) => ({
        key: fromDbDate(row.collectionDate),
        count: row._count,
        amount: moneyString(row._sum.amount ?? ZERO),
      })),
      totalAmount: moneyString(totalAmount._sum.amount ?? ZERO),
      page: query.page,
      pageSize: PAGE_SIZE,
      total: total.length,
    };
  }

  async dues(access: BusinessAccess, query: DuesReportQueryDto) {
    const config = await this.context.config(access.businessId);
    const today = todayIn(config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.CustomerWhereInput = { isActive: true, currentBalance: { not: 0 } };
    const [rows, total, totals] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          code: true,
          nameEn: true,
          nameBn: true,
          currentBalance: true,
          openingBalance: true,
        },
      }),
      db.customer.count({ where }),
      db.customer.aggregate({ where, _sum: { currentBalance: true } }),
    ]);

    const buckets = await Promise.all(
      rows.map((row) => this.agingOf(db, row.id, row.openingBalance, today)),
    );
    const items = rows.map((row, index) => {
      const due = row.currentBalance.greaterThan(0) ? row.currentBalance : ZERO;
      const advance = row.currentBalance.lessThan(0) ? row.currentBalance.abs() : ZERO;
      return {
        id: row.id,
        code: row.code,
        nameEn: row.nameEn,
        nameBn: row.nameBn,
        currentBalance: moneyString(row.currentBalance),
        dueAmount: moneyString(due),
        advanceAmount: moneyString(advance),
        aging: {
          d0To7: moneyString(buckets[index]?.d0To7 ?? ZERO),
          d8To30: moneyString(buckets[index]?.d8To30 ?? ZERO),
          d30Plus: moneyString(buckets[index]?.d30Plus ?? ZERO),
        },
      };
    });
    const netDue = totals._sum.currentBalance ?? ZERO;
    return {
      items,
      totalDue: moneyString(netDue.greaterThan(0) ? netDue : ZERO),
      totalAdvance: moneyString(netDue.lessThan(0) ? netDue.abs() : ZERO),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  async stock(access: BusinessAccess, query: StockReportQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.ProductWhereInput = { isActive: true };
    const [rows, total] = await Promise.all([
      db.product.findMany({
        where,
        orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          code: true,
          nameEn: true,
          nameBn: true,
          unitKey: true,
          currentStock: true,
          isActive: true,
        },
      }),
      db.product.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        nameEn: row.nameEn,
        nameBn: row.nameBn,
        unitKey: row.unitKey,
        currentStock: row.currentStock.toString(),
        isActive: row.isActive,
      })),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  async stockMovements(access: BusinessAccess, query: StockMovementsReportQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const range = { gte: toDbDate(from), lte: toDbDate(to) };

    const [netRows, totalGroups] = await Promise.all([
      db.stockMovement.groupBy({
        by: ['productId'],
        where: { movementDate: range },
        _sum: { quantity: true },
        orderBy: { productId: 'asc' },
      }),
      db.stockMovement.groupBy({ by: ['productId'], where: { movementDate: range } }),
    ]);
    const sorted = netRows.sort((a, b) =>
      (b._sum.quantity ?? ZERO).comparedTo(a._sum.quantity ?? ZERO),
    );
    const page = sorted.slice((query.page - 1) * PAGE_SIZE, query.page * PAGE_SIZE);
    const productIds = page.map((row) => row.productId);

    const [products, byKind] = await Promise.all([
      db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, code: true, nameEn: true, nameBn: true, unitKey: true },
      }),
      productIds.length
        ? db.stockMovement.groupBy({
            by: ['productId', 'kind'],
            where: { movementDate: range, productId: { in: productIds } },
            _sum: { quantity: true },
          })
        : Promise.resolve([]),
    ]);
    const productOf = new Map(products.map((row) => [row.id, row]));
    const kindsOf = new Map<string, { kind: string; quantity: Prisma.Decimal }[]>();
    for (const row of byKind) {
      const list = kindsOf.get(row.productId) ?? [];
      list.push({ kind: row.kind, quantity: row._sum.quantity ?? ZERO });
      kindsOf.set(row.productId, list);
    }

    return {
      from,
      to,
      items: page.map((row) => {
        const product = productOf.get(row.productId);
        return {
          productId: row.productId,
          code: product?.code ?? row.productId,
          nameEn: product?.nameEn ?? '',
          nameBn: product?.nameBn ?? '',
          unitKey: product?.unitKey ?? '',
          net: (row._sum.quantity ?? ZERO).toString(),
          byKind: (kindsOf.get(row.productId) ?? []).map((item) => ({
            kind: item.kind,
            quantity: item.quantity.toString(),
          })),
        };
      }),
      page: query.page,
      pageSize: PAGE_SIZE,
      total: totalGroups.length,
    };
  }

  async expenses(access: BusinessAccess, query: ExpensesReportQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const range = { gte: toDbDate(from), lte: toDbDate(to) };

    if (query.groupBy === 'category') {
      const rows = await db.expense.groupBy({
        by: ['categoryId'],
        where: { status: 'active', expenseDate: range },
        _sum: { amount: true },
        _count: true,
      });
      const categories = await db.expenseCategory.findMany({
        where: { id: { in: rows.map((row) => row.categoryId) } },
        select: { id: true, nameEn: true },
      });
      const nameOf = new Map(categories.map((row) => [row.id, row.nameEn]));
      const items = rows
        .map((row) => ({
          key: row.categoryId,
          label: nameOf.get(row.categoryId) ?? row.categoryId,
          count: row._count,
          amount: moneyString(row._sum.amount ?? ZERO),
        }))
        .sort((a, b) => toDecimal(b.amount).comparedTo(toDecimal(a.amount)));
      return {
        from,
        to,
        groupBy: query.groupBy,
        items,
        totalAmount: moneyString(sumOf(rows.map((row) => row._sum.amount))),
      };
    }

    // month: grouped by calendar date, then folded into YYYYMM in JS (one
    // group per active day in the range, so this reduce stays small even
    // over a business's full lifetime).
    const rows = await db.expense.groupBy({
      by: ['expenseDate'],
      where: { status: 'active', expenseDate: range },
      _sum: { amount: true },
      _count: true,
    });
    const byMonth = new Map<number, { amount: Prisma.Decimal; count: number }>();
    for (const row of rows) {
      const period = periodOf(fromDbDate(row.expenseDate));
      const bucket = byMonth.get(period) ?? { amount: ZERO, count: 0 };
      bucket.amount = bucket.amount.add(row._sum.amount ?? ZERO);
      bucket.count += row._count;
      byMonth.set(period, bucket);
    }
    const items = [...byMonth.entries()]
      .sort(([a], [b]) => b - a)
      .map(([period, sums]) => ({
        key: String(period),
        label: `${String(period).slice(0, 4)}-${String(period).slice(4, 6)}`,
        count: sums.count,
        amount: moneyString(sums.amount),
      }));
    return {
      from,
      to,
      groupBy: query.groupBy,
      items,
      totalAmount: moneyString(sumOf(rows.map((row) => row._sum.amount))),
    };
  }

  async dailySummary(access: BusinessAccess, query: DailySummaryQueryDto) {
    const config = await this.context.config(access.businessId);
    const date = query.date ?? todayIn(config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const day = toDbDate(date);

    const [orders, deliveries, collections, expenses, cash] = await Promise.all([
      db.salesOrder.aggregate({
        where: { status: 'active', orderDate: day },
        _count: true,
        _sum: { totalAmount: true },
      }),
      db.delivery.aggregate({
        where: { status: 'active', deliveryDate: day },
        _count: true,
        _sum: { totalAmount: true },
      }),
      db.collection.aggregate({
        where: { status: 'active', collectionDate: day },
        _count: true,
        _sum: { amount: true },
      }),
      db.expense.aggregate({
        where: { status: 'active', expenseDate: day },
        _count: true,
        _sum: { amount: true },
      }),
      this.cashBook.read(access, { page: 1, from: date, to: date }),
    ]);

    return {
      date,
      orders: { count: orders._count, amount: moneyString(orders._sum.totalAmount ?? ZERO) },
      deliveries: {
        count: deliveries._count,
        amount: moneyString(deliveries._sum.totalAmount ?? ZERO),
      },
      collections: {
        count: collections._count,
        amount: moneyString(collections._sum.amount ?? ZERO),
      },
      expenses: { count: expenses._count, amount: moneyString(expenses._sum.amount ?? ZERO) },
      cash: {
        openingBalance: cash.openingBalance,
        closingBalance: cash.closingBalance,
        net: cash.totals.net,
      },
    };
  }

  private async totalsOfDeliveries(
    db: ReturnType<PrismaService['forBusiness']>,
    range: { gte: Date; lte: Date },
  ) {
    const totals = await db.delivery.aggregate({
      where: { status: 'active', deliveryDate: range },
      _sum: { totalQuantity: true, totalAmount: true },
    });
    return { quantity: totals._sum.totalQuantity ?? ZERO, amount: totals._sum.totalAmount ?? ZERO };
  }

  private salesResult(
    from: string,
    to: string,
    page: number,
    total: number,
    items: { key: string; label: string; quantity: Prisma.Decimal; amount: Prisma.Decimal }[],
    totals: { quantity: Prisma.Decimal; amount: Prisma.Decimal },
    groupBy: string,
  ) {
    return {
      from,
      to,
      groupBy,
      items: items.map((item) => ({
        key: item.key,
        label: item.label,
        quantity: item.quantity.toString(),
        amount: moneyString(item.amount),
      })),
      totalQuantity: totals.quantity.toString(),
      totalAmount: moneyString(totals.amount),
      page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  /** FIFO age of a customer's outstanding balance: oldest debt paid off first. */
  private async agingOf(
    db: ReturnType<PrismaService['forBusiness']>,
    customerId: string,
    openingBalance: Prisma.Decimal,
    today: string,
  ) {
    const entries = await db.customerLedgerEntry.findMany({
      where: { customerId },
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { amount: true, entryDate: true },
    });
    const queue: { date: string | null; amount: Prisma.Decimal }[] = [];
    if (!openingBalance.isZero()) {
      // Its date is unknown, so it is treated as the oldest possible debt.
      queue.push({ date: null, amount: openingBalance });
    }
    for (const entry of entries) {
      const date = fromDbDate(entry.entryDate);
      if (entry.amount.greaterThan(0)) {
        queue.push({ date, amount: entry.amount });
      } else if (entry.amount.lessThan(0)) {
        let pay = entry.amount.abs();
        while (pay.greaterThan(0) && queue.length > 0) {
          const front = queue[0];
          if (!front) break;
          if (front.amount.lessThanOrEqualTo(pay)) {
            pay = pay.sub(front.amount);
            queue.shift();
          } else {
            front.amount = front.amount.sub(pay);
            pay = ZERO;
          }
        }
      }
    }
    const buckets = { d0To7: ZERO, d8To30: ZERO, d30Plus: ZERO };
    for (const item of queue) {
      const age = item.date === null ? Number.POSITIVE_INFINITY : daysBetween(item.date, today);
      if (age <= 7) buckets.d0To7 = buckets.d0To7.add(item.amount);
      else if (age <= 30) buckets.d8To30 = buckets.d8To30.add(item.amount);
      else buckets.d30Plus = buckets.d30Plus.add(item.amount);
    }
    return buckets;
  }
}

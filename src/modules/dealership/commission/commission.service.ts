import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, isCalendarDate, todayIn, toDbDate } from '../../../core/common/business-time';
import { BusinessAccess } from '../../../core/common/request-context';
import { moneyString, toDecimal } from '../../../core/common/money';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest, notFoundError } from '../../../core/errors';
import { quantityString } from '../stock/stock-ledger';
import { PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { calculateCommission } from './commission.helpers';
import {
  CreateEntryDto,
  CreateReceiptDto,
  PatchEntryDto,
  PatchReceiptDto,
  UpsertSchemeDto,
} from './dto/requests';

const entryNotFound = () => notFoundError('COMMISSION_ENTRY_NOT_FOUND', 'Entry not found');
const receiptNotFound = () => notFoundError('COMMISSION_RECEIPT_NOT_FOUND', 'Receipt not found');
const schemeNotSet = () =>
  badRequest('COMMISSION_SCHEME_NOT_SET', 'Set the commission scheme first', 'quantity');

function schemeDto(row: {
  rateBase: Prisma.Decimal;
  targetQty: Prisma.Decimal;
  bonusRate: Prisma.Decimal;
  updatedAt: Date;
}) {
  return {
    rateBase: moneyString(row.rateBase),
    targetQty: quantityString(row.targetQty),
    bonusRate: moneyString(row.bonusRate),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function entryListItem(
  row: {
    id: string;
    fromDate: Date;
    toDate: Date;
    quantity: Prisma.Decimal;
    calculatedAmount: Prisma.Decimal;
    note: string | null;
    createdAt: Date;
  },
  receivedAmount: Prisma.Decimal,
) {
  return {
    id: row.id,
    fromDate: fromDbDate(row.fromDate),
    toDate: fromDbDate(row.toDate),
    quantity: quantityString(row.quantity),
    calculatedAmount: moneyString(row.calculatedAmount),
    receivedAmount: moneyString(receivedAmount),
    pendingAmount: moneyString(row.calculatedAmount.sub(receivedAmount)),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Akij Cement commission: a single scheme per business, owner-entered
 * entries calculated from it, and receipts recording money actually
 * received. All owner-only (`commission.view` / `commission.manage`).
 */
@Injectable()
export class CommissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
  ) {}

  async getScheme(access: BusinessAccess) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .commissionScheme.findUnique({ where: { businessId: access.businessId } });
    return row ? schemeDto(row) : null;
  }

  async upsertScheme(access: BusinessAccess, dto: UpsertSchemeDto) {
    const rateBase = toDecimal(dto.rateBase);
    const targetQty = toDecimal(dto.targetQty);
    const bonusRate = toDecimal(dto.bonusRate);
    if (!rateBase.greaterThan(0)) {
      throw badRequest('RATE_BASE_TOO_SMALL', 'rateBase must be above zero', 'rateBase');
    }
    if (!targetQty.greaterThan(0)) {
      throw badRequest('TARGET_QTY_TOO_SMALL', 'targetQty must be above zero', 'targetQty');
    }
    // bonusRate may be zero (base only); MONEY_PATTERN already refuses a negative.
    const db = this.prisma.forBusiness(access.businessId);
    const row = await db.commissionScheme.upsert({
      where: { businessId: access.businessId },
      create: { businessId: access.businessId, rateBase, targetQty, bonusRate },
      update: { rateBase, targetQty, bonusRate },
    });
    return schemeDto(row);
  }

  async listEntries(access: BusinessAccess, page: number) {
    const db = this.prisma.forBusiness(access.businessId);
    const [rows, total] = await Promise.all([
      db.commissionEntry.findMany({
        orderBy: [{ fromDate: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.commissionEntry.count(),
    ]);
    const receivedByEntry = await this.receivedAmounts(
      db,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) =>
        entryListItem(row, receivedByEntry.get(row.id) ?? new Prisma.Decimal(0)),
      ),
      page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  async getEntry(access: BusinessAccess, id: string) {
    const db = this.prisma.forBusiness(access.businessId);
    const row = await db.commissionEntry.findUnique({
      where: { id },
      include: { receipts: { orderBy: { receivedDate: 'desc' } } },
    });
    if (!row) {
      throw entryNotFound();
    }
    const receivedAmount = row.receipts.reduce(
      (sum, receipt) => sum.add(receipt.amount),
      new Prisma.Decimal(0),
    );
    return {
      ...entryListItem(row, receivedAmount),
      receipts: row.receipts.map((receipt) => ({
        id: receipt.id,
        amount: moneyString(receipt.amount),
        receivedDate: fromDbDate(receipt.receivedDate),
        reference: receipt.reference,
        note: receipt.note,
      })),
    };
  }

  async createEntry(access: BusinessAccess, dto: CreateEntryDto) {
    const { fromDate, toDate } = await this.checkDateRange(access, dto.fromDate, dto.toDate);
    const quantity = toDecimal(dto.quantity);
    const scheme = await this.requireScheme(access);
    const { totalAmount } = calculateCommission(quantity, scheme);
    const db = this.prisma.forBusiness(access.businessId);
    const row = await db.commissionEntry.create({
      data: {
        businessId: access.businessId,
        fromDate: toDbDate(fromDate),
        toDate: toDbDate(toDate),
        quantity,
        calculatedAmount: totalAmount,
        note: dto.note || null,
      },
    });
    return this.getEntry(access, row.id);
  }

  async patchEntry(access: BusinessAccess, id: string, dto: PatchEntryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const existing = await db.commissionEntry.findUnique({ where: { id } });
    if (!existing) {
      throw entryNotFound();
    }
    const fromDate = dto.fromDate ?? fromDbDate(existing.fromDate);
    const toDate = dto.toDate ?? fromDbDate(existing.toDate);
    if (dto.fromDate !== undefined || dto.toDate !== undefined) {
      await this.checkDateRange(access, fromDate, toDate);
    }
    const quantity = dto.quantity !== undefined ? toDecimal(dto.quantity) : existing.quantity;
    const scheme = await this.requireScheme(access);
    const { totalAmount } = calculateCommission(quantity, scheme);
    await db.commissionEntry.update({
      where: { id },
      data: {
        fromDate: toDbDate(fromDate),
        toDate: toDbDate(toDate),
        quantity,
        calculatedAmount: totalAmount,
        ...(dto.note !== undefined ? { note: dto.note || null } : {}),
      },
    });
    return this.getEntry(access, id);
  }

  async suggestion(access: BusinessAccess, from: string, to: string) {
    await this.checkDateRange(access, from, to);
    const db = this.prisma.forBusiness(access.businessId);
    const result = await db.purchase.aggregate({
      where: { purchaseDate: { gte: toDbDate(from), lte: toDbDate(to) }, status: 'active' },
      _sum: { totalQuantity: true },
    });
    return { from, to, quantity: quantityString(result._sum.totalQuantity ?? new Prisma.Decimal(0)) };
  }

  async createReceipt(access: BusinessAccess, entryId: string, dto: CreateReceiptDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const entry = await db.commissionEntry.findUnique({ where: { id: entryId } });
    if (!entry) {
      throw entryNotFound();
    }
    const receivedDate = await this.checkNotFuture(access, dto.receivedDate, 'receivedDate');
    const receipt = await db.commissionReceipt.create({
      data: {
        businessId: access.businessId,
        entryId,
        amount: toDecimal(dto.amount),
        receivedDate: toDbDate(receivedDate),
        reference: dto.reference || null,
        note: dto.note || null,
      },
    });
    return {
      id: receipt.id,
      amount: moneyString(receipt.amount),
      receivedDate: fromDbDate(receipt.receivedDate),
      reference: receipt.reference,
      note: receipt.note,
    };
  }

  async patchReceipt(access: BusinessAccess, entryId: string, id: string, dto: PatchReceiptDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const existing = await db.commissionReceipt.findUnique({ where: { id } });
    if (!existing || existing.entryId !== entryId) {
      throw receiptNotFound();
    }
    const receivedDate =
      dto.receivedDate !== undefined
        ? await this.checkNotFuture(access, dto.receivedDate, 'receivedDate')
        : undefined;
    const receipt = await db.commissionReceipt.update({
      where: { id },
      data: {
        ...(dto.amount !== undefined ? { amount: toDecimal(dto.amount) } : {}),
        ...(receivedDate !== undefined ? { receivedDate: toDbDate(receivedDate) } : {}),
        ...(dto.reference !== undefined ? { reference: dto.reference || null } : {}),
        ...(dto.note !== undefined ? { note: dto.note || null } : {}),
      },
    });
    return {
      id: receipt.id,
      amount: moneyString(receipt.amount),
      receivedDate: fromDbDate(receipt.receivedDate),
      reference: receipt.reference,
      note: receipt.note,
    };
  }

  async summary(access: BusinessAccess, year: number) {
    const db = this.prisma.forBusiness(access.businessId);
    const from = toDbDate(`${String(year)}-01-01`);
    const to = toDbDate(`${String(year)}-12-31`);
    const [entries, receipts] = await Promise.all([
      db.commissionEntry.aggregate({
        where: { fromDate: { gte: from, lte: to } },
        _sum: { calculatedAmount: true },
        _count: { _all: true },
      }),
      db.commissionReceipt.aggregate({
        where: { receivedDate: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);
    const totalCalculated = entries._sum.calculatedAmount ?? new Prisma.Decimal(0);
    const totalReceived = receipts._sum.amount ?? new Prisma.Decimal(0);
    return {
      year,
      totalCalculated: moneyString(totalCalculated),
      totalReceived: moneyString(totalReceived),
      totalPending: moneyString(totalCalculated.sub(totalReceived)),
      entryCount: entries._count._all,
      receiptCount: receipts._count._all,
    };
  }

  // ---------------------------------------------------------------------------

  private async requireScheme(access: BusinessAccess) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .commissionScheme.findUnique({ where: { businessId: access.businessId } });
    if (!row) {
      throw schemeNotSet();
    }
    return row;
  }

  private async receivedAmounts(
    db: ReturnType<PrismaService['forBusiness']>,
    entryIds: string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    if (entryIds.length === 0) {
      return new Map();
    }
    const groups = await db.commissionReceipt.groupBy({
      by: ['entryId'],
      where: { entryId: { in: entryIds } },
      _sum: { amount: true },
    });
    return new Map(
      groups.map((group) => [group.entryId, group._sum.amount ?? new Prisma.Decimal(0)]),
    );
  }

  private async checkDateRange(access: BusinessAccess, fromDate: string, toDate: string) {
    if (!isCalendarDate(fromDate)) {
      throw badRequest('COMMISSION_DATE_INVALID', 'Not a real date', 'fromDate');
    }
    if (!isCalendarDate(toDate)) {
      throw badRequest('COMMISSION_DATE_INVALID', 'Not a real date', 'toDate');
    }
    const config = await this.context.config(access.businessId);
    if (toDate > todayIn(config.timezone)) {
      throw badRequest('COMMISSION_DATE_IN_FUTURE', 'toDate cannot be in the future', 'toDate');
    }
    if (fromDate > toDate) {
      throw badRequest(
        'COMMISSION_DATE_RANGE_INVALID',
        'fromDate must not be after toDate',
        'fromDate',
      );
    }
    return { fromDate, toDate };
  }

  private async checkNotFuture(
    access: BusinessAccess,
    date: string,
    field: string,
  ): Promise<string> {
    if (!isCalendarDate(date)) {
      throw badRequest('COMMISSION_DATE_INVALID', 'Not a real date', field);
    }
    const config = await this.context.config(access.businessId);
    if (date > todayIn(config.timezone)) {
      throw badRequest('COMMISSION_DATE_IN_FUTURE', `${field} cannot be in the future`, field);
    }
    return date;
  }
}

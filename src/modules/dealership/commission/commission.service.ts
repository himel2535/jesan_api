import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { fromDbDate, isCalendarDate, todayIn, toDbDate } from '../../../core/common/business-time';
import { BusinessAccess } from '../../../core/common/request-context';
import { moneyString, toDecimal } from '../../../core/common/money';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest, notFoundError } from '../../../core/errors';
import { BusinessLedgerService } from '../accounts/business-ledger.service';
import { PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { CreateEntryDto, PatchEntryDto } from './dto/requests';

const entryNotFound = () => notFoundError('COMMISSION_ENTRY_NOT_FOUND', 'Entry not found');

function entryDto(row: {
  id: string;
  amount: Prisma.Decimal;
  receivedDate: Date;
  note: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    amount: moneyString(row.amount),
    receivedDate: fromDbDate(row.receivedDate),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Commission the business received: an amount, the date and a free-text
 * reason, typed by the owner. No scheme, target or calculation. Each entry
 * posts an `in` / `commission_receipt` row to the business ledger in the same
 * transaction, which is what net profit adds. Owner-only
 * (`commission.view` / `commission.manage`).
 */
@Injectable()
export class CommissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly ledger: BusinessLedgerService,
  ) {}

  async listEntries(access: BusinessAccess, page: number) {
    const db = this.prisma.forBusiness(access.businessId);
    const [rows, total] = await Promise.all([
      db.commissionReceipt.findMany({
        orderBy: [{ receivedDate: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.commissionReceipt.count(),
    ]);
    return { items: rows.map(entryDto), page, pageSize: PAGE_SIZE, total };
  }

  async getEntry(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .commissionReceipt.findUnique({ where: { id } });
    if (!row) {
      throw entryNotFound();
    }
    return entryDto(row);
  }

  async createEntry(access: BusinessAccess, dto: CreateEntryDto, actorUserId: string) {
    const receivedDate = await this.checkNotFuture(access, dto.receivedDate);
    const amount = this.checkAmount(dto.amount);
    const db = this.prisma.forBusiness(access.businessId);
    const row = await db.$transaction(async (tx) => {
      const created = await tx.commissionReceipt.create({
        data: {
          businessId: access.businessId,
          amount,
          receivedDate: toDbDate(receivedDate),
          note: dto.note,
        },
      });
      await this.ledger.append(tx, access.businessId, actorUserId, {
        type: 'commission_receipt',
        direction: 'in',
        amount,
        method: null,
        referenceType: 'commission_receipt',
        referenceId: created.id,
        entryDate: receivedDate,
        note: dto.note,
      });
      return created;
    });
    return entryDto(row);
  }

  async patchEntry(access: BusinessAccess, id: string, dto: PatchEntryDto, actorUserId: string) {
    const db = this.prisma.forBusiness(access.businessId);
    const existing = await db.commissionReceipt.findUnique({ where: { id } });
    if (!existing) {
      throw entryNotFound();
    }
    const receivedDate =
      dto.receivedDate !== undefined
        ? await this.checkNotFuture(access, dto.receivedDate)
        : undefined;
    const amount = dto.amount !== undefined ? this.checkAmount(dto.amount) : undefined;
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.commissionReceipt.update({
        where: { id },
        data: {
          ...(amount !== undefined ? { amount } : {}),
          ...(receivedDate !== undefined ? { receivedDate: toDbDate(receivedDate) } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
      });
      // The ledger row mirrors this entry, so net profit follows the correction.
      await this.ledger.restateByReference(
        tx,
        access.businessId,
        actorUserId,
        { referenceType: 'commission_receipt', referenceId: id },
        {
          type: 'commission_receipt',
          direction: 'in',
          amount: updated.amount,
          method: null,
          entryDate: fromDbDate(updated.receivedDate),
          note: updated.note,
        },
      );
      return updated;
    });
    return entryDto(row);
  }

  async summary(access: BusinessAccess, year: number) {
    const db = this.prisma.forBusiness(access.businessId);
    const result = await db.commissionReceipt.aggregate({
      where: {
        receivedDate: {
          gte: toDbDate(`${String(year)}-01-01`),
          lte: toDbDate(`${String(year)}-12-31`),
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      year,
      totalReceived: moneyString(result._sum.amount ?? new Prisma.Decimal(0)),
      entryCount: result._count._all,
    };
  }

  // ---------------------------------------------------------------------------

  private checkAmount(value: string): Prisma.Decimal {
    const amount = toDecimal(value);
    if (!amount.greaterThan(0)) {
      throw badRequest('AMOUNT_TOO_SMALL', 'amount must be above zero', 'amount');
    }
    return amount;
  }

  private async checkNotFuture(access: BusinessAccess, date: string): Promise<string> {
    if (!isCalendarDate(date)) {
      throw badRequest('COMMISSION_DATE_INVALID', 'Not a real date', 'receivedDate');
    }
    const config = await this.context.config(access.businessId);
    if (date > todayIn(config.timezone)) {
      throw badRequest(
        'COMMISSION_DATE_IN_FUTURE',
        'receivedDate cannot be in the future',
        'receivedDate',
      );
    }
    return date;
  }
}

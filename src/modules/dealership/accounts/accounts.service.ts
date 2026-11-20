import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { toDbDate } from '../../../core/common/business-time';
import { moneyString, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest } from '../../../core/errors';
import { checkBusinessDate, resolveDateRange } from '../business-dates';
import { Actor, PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { BusinessLedgerService, LedgerEntryType } from './business-ledger.service';
import { CreateLedgerEntryDto, CreateSupplierPaymentDto, LedgerListQueryDto } from './dto/requests';

const ZERO = new Prisma.Decimal(0);

const LEDGER_TYPES: LedgerEntryType[] = [
  'collection',
  'expense',
  'purchase',
  'commission_receipt',
  'manual',
  'supplier_payment',
];

/** A manual entry or supplier payment may be dated at most this many days back. */
const ENTRIES_BACKDATE_LIMIT_DAYS = 7;

function isUniqueViolation(error: unknown, hint: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (JSON.stringify(error.meta ?? {}) + error.message).includes(hint)
  );
}

const personRef = { select: { id: true, name: true } } as const;

const select = {
  id: true,
  type: true,
  direction: true,
  amount: true,
  method: true,
  referenceType: true,
  referenceId: true,
  entryDate: true,
  note: true,
  status: true,
  createdAt: true,
  creator: personRef,
} satisfies Prisma.BusinessLedgerEntrySelect;

type Row = Prisma.BusinessLedgerEntryGetPayload<{ select: typeof select }>;

function toResponse(row: Row) {
  return {
    id: row.id,
    type: row.type,
    direction: row.direction,
    amount: moneyString(row.amount),
    method: row.method,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    entryDate: row.entryDate.toISOString().slice(0, 10),
    note: row.note,
    status: row.status,
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The business-level general ledger: a KPI summary, the raw list, and the
 * only two entry points that let a person add a row directly (a manual
 * entry, or a supplier payment). Every other row is auto-entered by its own
 * module (collections, expenses, purchases, commission receipts) through
 * `BusinessLedgerService`, which this service also uses for its own writes.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly ledger: BusinessLedgerService,
    private readonly audit: AuditService,
  ) {}

  async summary(access: BusinessAccess, query: { from?: string; to?: string }) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const range = { gte: toDbDate(from), lte: toDbDate(to) };
    const activeInRange = { status: 'active', entryDate: range } as const;

    const [inRows, outRows, dueTotals, advanceTotals] = await Promise.all([
      db.businessLedgerEntry.groupBy({
        by: ['type'],
        where: { ...activeInRange, direction: 'in' },
        _sum: { amount: true },
      }),
      db.businessLedgerEntry.groupBy({
        by: ['type'],
        where: { ...activeInRange, direction: 'out' },
        _sum: { amount: true },
      }),
      db.customer.aggregate({
        where: { isActive: true, currentBalance: { gt: 0 } },
        _sum: { currentBalance: true },
      }),
      db.customer.aggregate({
        where: { isActive: true, currentBalance: { lt: 0 } },
        _sum: { currentBalance: true },
      }),
    ]);

    const inByType = new Map(inRows.map((row) => [row.type, row._sum.amount ?? ZERO]));
    const outByType = new Map(outRows.map((row) => [row.type, row._sum.amount ?? ZERO]));
    const totalIn = [...inByType.values()].reduce((sum, value) => sum.add(value), ZERO);
    const totalOut = [...outByType.values()].reduce((sum, value) => sum.add(value), ZERO);

    return {
      from,
      to,
      totalIn: moneyString(totalIn),
      totalOut: moneyString(totalOut),
      net: moneyString(totalIn.sub(totalOut)),
      totalDue: moneyString(dueTotals._sum.currentBalance ?? ZERO),
      totalAdvance: moneyString((advanceTotals._sum.currentBalance ?? ZERO).abs()),
      byType: LEDGER_TYPES.map((type) => ({
        type,
        in: moneyString(inByType.get(type) ?? ZERO),
        out: moneyString(outByType.get(type) ?? ZERO),
      })),
    };
  }

  async ledgerList(access: BusinessAccess, query: LedgerListQueryDto) {
    const config = await this.context.config(access.businessId);
    const { from, to } = resolveDateRange(query, config.timezone);
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.BusinessLedgerEntryWhereInput = {
      entryDate: { gte: toDbDate(from), lte: toDbDate(to) },
      ...(query.type ? { type: query.type } : {}),
    };
    const [rows, total] = await Promise.all([
      db.businessLedgerEntry.findMany({
        where,
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select,
      }),
      db.businessLedgerEntry.count({ where }),
    ]);
    return { items: rows.map(toResponse), page: query.page, pageSize: PAGE_SIZE, total };
  }

  async createEntry(
    access: BusinessAccess,
    dto: CreateLedgerEntryDto,
    actor: Actor,
    idempotencyKey: string,
  ) {
    const db = this.prisma.forBusiness(access.businessId);
    const existing = await this.findByKey(access, actor, idempotencyKey);
    if (existing) return { created: false, entry: existing };
    const config = await this.context.config(access.businessId);
    const amount = toDecimal(dto.amount);
    if (!amount.greaterThan(0)) {
      throw badRequest('AMOUNT_TOO_SMALL', 'The amount must be above zero', 'amount');
    }
    if (dto.method && !config.collectionMethods.includes(dto.method)) {
      throw badRequest(
        'LEDGER_ENTRY_METHOD_UNKNOWN',
        'Not one of this business’s methods',
        'method',
      );
    }
    const entryDate = checkBusinessDate(dto.entryDate, {
      timezone: config.timezone,
      backdateLimitDays: ENTRIES_BACKDATE_LIMIT_DAYS,
      mayBackdate: false,
      subject: 'ENTRY_DATE',
      field: 'entryDate',
    });

    try {
      const id = await db.$transaction(async (tx) => {
        const entryId = await this.ledger.append(tx, access.businessId, actor.userId, {
          type: 'manual',
          direction: dto.direction,
          amount,
          method: dto.method ?? null,
          entryDate,
          note: dto.note || null,
          idempotencyKey,
        });
        // amount was already checked above zero, so a row was always written.
        if (!entryId) throw new Error('unreachable: amount was checked above zero');
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'business_ledger_entry.created',
            entityType: 'business_ledger_entry',
            entityId: entryId,
            changes: { direction: dto.direction, amount: moneyString(amount), entryDate },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return entryId;
      });
      return { created: true, entry: await this.get(access, id) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByKey(access, actor, idempotencyKey);
        if (existing) return { created: false, entry: existing };
      }
      throw error;
    }
  }

  async createPayment(
    access: BusinessAccess,
    dto: CreateSupplierPaymentDto,
    actor: Actor,
    idempotencyKey: string,
  ) {
    const db = this.prisma.forBusiness(access.businessId);
    const existing = await this.findByKey(access, actor, idempotencyKey);
    if (existing) return { created: false, entry: existing };
    const config = await this.context.config(access.businessId);
    const amount = toDecimal(dto.amount);
    if (!amount.greaterThan(0)) {
      throw badRequest('AMOUNT_TOO_SMALL', 'The amount must be above zero', 'amount');
    }
    if (!config.collectionMethods.includes(dto.method)) {
      throw badRequest(
        'LEDGER_ENTRY_METHOD_UNKNOWN',
        'Not one of this business’s methods',
        'method',
      );
    }
    const paymentDate = checkBusinessDate(dto.paymentDate, {
      timezone: config.timezone,
      backdateLimitDays: ENTRIES_BACKDATE_LIMIT_DAYS,
      mayBackdate: false,
      subject: 'PAYMENT_DATE',
      field: 'paymentDate',
    });

    try {
      const id = await db.$transaction(async (tx) => {
        const entryId = await this.ledger.append(tx, access.businessId, actor.userId, {
          type: 'supplier_payment',
          direction: 'out',
          amount,
          method: dto.method,
          entryDate: paymentDate,
          note: dto.note || null,
          idempotencyKey,
        });
        // amount was already checked above zero, so a row was always written.
        if (!entryId) throw new Error('unreachable: amount was checked above zero');
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'business_ledger_entry.created',
            entityType: 'business_ledger_entry',
            entityId: entryId,
            changes: { direction: 'out', amount: moneyString(amount), paymentDate },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return entryId;
      });
      return { created: true, entry: await this.get(access, id) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByKey(access, actor, idempotencyKey);
        if (existing) return { created: false, entry: existing };
      }
      throw error;
    }
  }

  private async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .businessLedgerEntry.findUniqueOrThrow({ where: { id }, select });
    return toResponse(row);
  }

  private async findByKey(access: BusinessAccess, actor: Actor, key: string) {
    const row = await this.prisma.forBusiness(access.businessId).businessLedgerEntry.findFirst({
      where: { createdBy: actor.userId, idempotencyKey: key },
      select: { id: true },
    });
    return row ? this.get(access, row.id) : null;
  }
}

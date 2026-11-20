import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { ChangeValues } from '../../../core/approvals/change-handler';
import { ChangeRequestsService } from '../../../core/approvals/change-requests.service';
import { fromDbDate, toDbDate } from '../../../core/common/business-time';
import { moneyString, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest, notFoundError } from '../../../core/errors';
import {
  DocumentCounterService,
  formatCode,
} from '../../../core/numbering/document-counter.service';
import { BusinessLedgerService } from '../accounts/business-ledger.service';
import { checkBusinessDate } from '../business-dates';
import { Actor, PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { CreateExpenseDto, ExpenseListQueryDto, UpdateExpenseDto } from './dto/requests';

/** Expense codes are four digits wide, like the other documents (EXP-0001). */
export const CODE_WIDTH = 4;

const personRef = { select: { id: true, name: true } } as const;

const select = {
  id: true,
  code: true,
  expenseDate: true,
  method: true,
  amount: true,
  note: true,
  proofNote: true,
  status: true,
  version: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  updatedAt: true,
  category: { select: { id: true, nameEn: true, nameBn: true } },
  creator: personRef,
  voider: personRef,
} satisfies Prisma.ExpenseSelect;

type Row = Prisma.ExpenseGetPayload<{ select: typeof select }>;

function toResponse(row: Row) {
  return {
    id: row.id,
    code: row.code,
    expenseDate: fromDbDate(row.expenseDate),
    category: row.category,
    method: row.method,
    amount: moneyString(row.amount),
    note: row.note,
    proofNote: row.proofNote,
    status: row.status,
    version: row.version,
    createdBy: row.creator,
    createdAt: row.createdAt.toISOString(),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    voidedBy: row.voider,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const expenseNotFound = () => notFoundError('EXPENSE_NOT_FOUND', 'Expense not found');

function isUniqueViolation(error: unknown, hint: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (JSON.stringify(error.meta ?? {}) + error.message).includes(hint)
  );
}

/**
 * Money paid out of the business: rent, salary, fuel and the like. Staff may
 * only add one; correcting or voiding goes through the change-request workflow
 * (`ExpenseChangeHandler`), so nothing is ever deleted. The cash book counts
 * active rows only, which is why a void needs no reversing entry.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly counters: DocumentCounterService,
    private readonly ledger: BusinessLedgerService,
    private readonly audit: AuditService,
    private readonly changes: ChangeRequestsService,
  ) {}

  async methods(access: BusinessAccess) {
    const config = await this.context.config(access.businessId);
    return { items: config.expenseMethods };
  }

  async create(
    access: BusinessAccess,
    dto: CreateExpenseDto,
    actor: Actor,
    idempotencyKey: string | undefined,
  ) {
    const db = this.prisma.forBusiness(access.businessId);
    if (idempotencyKey) {
      const existing = await this.findByKey(access, actor, idempotencyKey);
      if (existing) return { created: false, expense: existing };
    }
    const config = await this.context.config(access.businessId);
    if (!config.expenseMethods.includes(dto.method)) {
      throw badRequest('EXPENSE_METHOD_UNKNOWN', 'Not one of this business’s methods', 'method');
    }
    const amount = toDecimal(dto.amount);
    if (!amount.greaterThan(0)) {
      throw badRequest('AMOUNT_TOO_SMALL', 'The amount must be above zero', 'amount');
    }
    const expenseDate = checkBusinessDate(dto.expenseDate, {
      timezone: config.timezone,
      backdateLimitDays: config.backdateLimitDays,
      mayBackdate: access.permissions.has('expense.edit'),
      subject: 'EXPENSE_DATE',
      field: 'expenseDate',
    });
    const category = await db.expenseCategory.findUnique({
      where: { id: dto.categoryId },
      select: { id: true, isActive: true },
    });
    if (!category?.isActive) {
      // Missing, inactive and another business's id all read the same.
      throw badRequest(
        'EXPENSE_CATEGORY_NOT_FOUND_OR_INACTIVE',
        'Expense kind not found or inactive',
        'categoryId',
      );
    }

    try {
      const id = await db.$transaction(async (tx) => {
        const number = await this.counters.next(tx, access.businessId, 'expense');
        const expense = await tx.expense.create({
          data: {
            businessId: access.businessId,
            code: formatCode(config.codePrefixes.expense, number, CODE_WIDTH),
            expenseDate: toDbDate(expenseDate),
            categoryId: category.id,
            method: dto.method,
            amount,
            note: dto.note || null,
            proofNote: dto.proofNote || null,
            idempotencyKey: idempotencyKey ?? null,
            createdBy: actor.userId,
          },
          select: { id: true, code: true },
        });
        await this.ledger.append(tx, access.businessId, actor.userId, {
          type: 'expense',
          direction: 'out',
          amount,
          method: dto.method,
          referenceType: 'expense',
          referenceId: expense.id,
          entryDate: expenseDate,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'expense.created',
            entityType: 'expense',
            entityId: expense.id,
            changes: {
              code: expense.code,
              expenseDate,
              categoryId: category.id,
              method: dto.method,
              amount: moneyString(amount),
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return expense.id;
      });
      return { created: true, expense: await this.get(access, id) };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error, 'idempotency')) {
        const existing = await this.findByKey(access, actor, idempotencyKey);
        if (existing) return { created: false, expense: existing };
      }
      throw error;
    }
  }

  async list(access: BusinessAccess, query: ExpenseListQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.ExpenseWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.from || query.to
        ? {
            expenseDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.expense.findMany({
        where,
        orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select,
      }),
      db.expense.count({ where }),
    ]);
    return { items: rows.map(toResponse), page: query.page, pageSize: PAGE_SIZE, total };
  }

  async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .expense.findUnique({ where: { id }, select });
    if (!row) throw expenseNotFound();
    return toResponse(row);
  }

  async voidDirect(access: BusinessAccess, id: string, reason: string, actor: Actor) {
    await this.changes.applyDirect(
      access,
      { entityType: 'expense', entityId: id, kind: 'void', reason, notFound: expenseNotFound },
      actor,
    );
    return this.get(access, id);
  }

  async updateDirect(access: BusinessAccess, id: string, dto: UpdateExpenseDto, actor: Actor) {
    const values: ChangeValues = {};
    for (const key of [
      'expenseDate',
      'categoryId',
      'method',
      'amount',
      'note',
      'proofNote',
    ] as const) {
      if (dto[key] !== undefined) values[key] = dto[key];
    }
    await this.changes.applyDirect(
      access,
      {
        entityType: 'expense',
        entityId: id,
        kind: 'edit',
        values,
        reason: dto.reason,
        notFound: expenseNotFound,
      },
      actor,
    );
    return this.get(access, id);
  }

  private async findByKey(access: BusinessAccess, actor: Actor, key: string) {
    const row = await this.prisma.forBusiness(access.businessId).expense.findFirst({
      where: { createdBy: actor.userId, idempotencyKey: key },
      select: { id: true },
    });
    return row ? this.get(access, row.id) : null;
  }
}

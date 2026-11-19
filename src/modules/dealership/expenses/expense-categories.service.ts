import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../core/audit/audit.service';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest } from '../../../core/errors';
import {
  Actor,
  activeFilter,
  diff,
  notFound,
  requireReason,
  rethrowUnique,
} from '../master-data/master-data.common';
import { CreateExpenseCategoryDto, UpdateExpenseCategoryDto } from './dto/requests';

const select = {
  id: true,
  nameEn: true,
  nameBn: true,
  sortOrder: true,
  isActive: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DUPLICATE = {
  name_en: {
    code: 'NAME_EN_DUPLICATE',
    field: 'nameEn',
    message: 'An expense kind with this name already exists',
  },
  name_bn: {
    code: 'NAME_BN_DUPLICATE',
    field: 'nameBn',
    message: 'An expense kind with this name already exists',
  },
};

type Row = {
  id: string;
  nameEn: string;
  nameBn: string;
  sortOrder: number;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function toResponse(row: Row) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * The kinds of expense a business records (salary, rent, ...). Per business, so
 * a new business needs no code change; the starting list comes from its config
 * through the seed. Never deleted, only deactivated with a reason: expenses
 * already booked against a kind must keep pointing at it.
 */
@Injectable()
export class ExpenseCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Expense kinds are few, so the list is not paged (as with product categories). */
  async list(access: BusinessAccess, active: 'true' | 'false' | 'all') {
    const rows = await this.prisma.forBusiness(access.businessId).expenseCategory.findMany({
      where: activeFilter(active),
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      select,
    });
    return { items: rows.map(toResponse) };
  }

  async create(access: BusinessAccess, dto: CreateExpenseCategoryDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    try {
      const row = await db.$transaction(async (tx) => {
        const created = await tx.expenseCategory.create({
          data: {
            businessId: access.businessId,
            nameEn: dto.nameEn,
            nameBn: dto.nameBn,
            sortOrder: dto.sortOrder ?? 0,
            createdBy: actor.userId,
          },
          select,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'expense_category.created',
            entityType: 'expense_category',
            entityId: created.id,
            changes: { nameEn: dto.nameEn, nameBn: dto.nameBn },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return created;
      });
      return toResponse(row);
    } catch (error) {
      rethrowUnique(error, DUPLICATE);
    }
  }

  async update(access: BusinessAccess, id: string, dto: UpdateExpenseCategoryDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const current = await db.expenseCategory.findUnique({ where: { id }, select });
    if (!current) {
      notFound('Expense category');
    }
    const changes = diff(current, {
      nameEn: dto.nameEn,
      nameBn: dto.nameBn,
      sortOrder: dto.sortOrder,
      isActive: dto.isActive,
    });
    if (Object.keys(changes).length === 0) {
      throw badRequest('NOTHING_TO_CHANGE', 'Nothing to change');
    }
    // Turning a kind off or on changes what staff may book against, so it is
    // always recorded with a reason.
    const reason = 'isActive' in changes ? requireReason(dto.reason) : undefined;

    try {
      const row = await db.$transaction(async (tx) => {
        const updated = await tx.expenseCategory.update({
          where: { id },
          data: {
            // Every change bumps the version, so pending change requests go stale.
            version: { increment: 1 },
            updatedBy: actor.userId,
            nameEn: dto.nameEn,
            nameBn: dto.nameBn,
            sortOrder: dto.sortOrder,
            isActive: dto.isActive,
          },
          select,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'expense_category.updated',
            entityType: 'expense_category',
            entityId: id,
            changes: { ...changes, ...(reason ? { reason } : {}) },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return updated;
      });
      return toResponse(row);
    } catch (error) {
      rethrowUnique(error, DUPLICATE);
    }
  }
}

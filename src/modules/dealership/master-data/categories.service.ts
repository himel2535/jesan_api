import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../../../core/audit/audit.service';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/requests';
import {
  Actor,
  activeFilter,
  diff,
  notFound,
  requirePermission,
  requireReason,
  rethrowUnique,
} from './master-data.common';

const select = {
  id: true,
  nameEn: true,
  nameBn: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DUPLICATE = { name_en: 'A category with this name already exists' };

type CategoryRow = {
  id: string;
  nameEn: string;
  nameBn: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toResponse(row: CategoryRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Categories are few, so the list is not paged. */
  async list(access: BusinessAccess, active: 'true' | 'false' | 'all') {
    const rows = await this.prisma.forBusiness(access.businessId).productCategory.findMany({
      where: activeFilter(active),
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      select,
    });
    return { items: rows.map(toResponse) };
  }

  async create(access: BusinessAccess, dto: CreateCategoryDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    try {
      const row = await db.$transaction(async (tx) => {
        const created = await tx.productCategory.create({
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
            action: 'product_category.created',
            entityType: 'product_category',
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

  async update(access: BusinessAccess, id: string, dto: UpdateCategoryDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const current = await db.productCategory.findUnique({ where: { id }, select });
    if (!current) {
      notFound('Category');
    }
    const changes = diff(current, {
      nameEn: dto.nameEn,
      nameBn: dto.nameBn,
      sortOrder: dto.sortOrder,
      isActive: dto.isActive,
    });
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Nothing to change');
    }
    let reason: string | undefined;
    if ('isActive' in changes) {
      requirePermission(access, 'product.deactivate');
      reason = requireReason(dto.reason);
    }

    try {
      const row = await db.$transaction(async (tx) => {
        const updated = await tx.productCategory.update({
          where: { id },
          data: {
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
            action: 'product_category.updated',
            entityType: 'product_category',
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

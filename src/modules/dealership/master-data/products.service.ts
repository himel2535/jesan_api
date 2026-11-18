import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { moneyString } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { badRequest } from '../../../core/errors';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  DocumentCounterService,
  formatCode,
} from '../../../core/numbering/document-counter.service';
import { CreateProductDto, ProductListQueryDto, UpdateProductDto } from './dto/requests';
import { DealershipContext } from './master-data.context';
import {
  Actor,
  PAGE_SIZE,
  Page,
  activeFilter,
  diff,
  notFound,
  requirePermission,
  requireReason,
  rethrowUnique,
} from './master-data.common';

const PRODUCT_CODE_WIDTH = 4;

const select = {
  id: true,
  code: true,
  nameEn: true,
  nameBn: true,
  unitKey: true,
  lastPurchasePrice: true,
  lastPurchasedAt: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  categoryId: true,
  // Same query, no N+1: the category name comes with every product.
  category: { select: { id: true, nameEn: true, nameBn: true } },
} as const;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof select }>;

const DUPLICATE = {
  name_en: {
    code: 'NAME_EN_DUPLICATE',
    field: 'nameEn',
    message: 'A product with this name already exists',
  },
};

const categoryUnavailable = () =>
  badRequest('CATEGORY_NOT_FOUND_OR_INACTIVE', 'Category not found or inactive', 'categoryId');

function toResponse(row: ProductRow) {
  return {
    id: row.id,
    code: row.code,
    category: row.category,
    nameEn: row.nameEn,
    nameBn: row.nameBn,
    unitKey: row.unitKey,
    lastPurchasePrice: row.lastPurchasePrice ? moneyString(row.lastPurchasePrice) : null,
    lastPurchasedAt: row.lastPurchasedAt?.toISOString() ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly counters: DocumentCounterService,
    private readonly context: DealershipContext,
  ) {}

  async list(access: BusinessAccess, query: ProductListQueryDto): Promise<Page<unknown>> {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.ProductWhereInput = {
      ...activeFilter(query.active),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? {
            OR: [
              { nameEn: { contains: query.search, mode: 'insensitive' } },
              { nameBn: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.product.findMany({
        where,
        orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select,
      }),
      db.product.count({ where }),
    ]);
    return { items: rows.map(toResponse), page: query.page, pageSize: PAGE_SIZE, total };
  }

  async get(access: BusinessAccess, id: string) {
    const row = await this.prisma
      .forBusiness(access.businessId)
      .product.findUnique({ where: { id }, select });
    return row ? toResponse(row) : notFound('Product');
  }

  async create(access: BusinessAccess, dto: CreateProductDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const [config, category] = await Promise.all([
      this.context.config(access.businessId),
      db.productCategory.findUnique({
        where: { id: dto.categoryId },
        select: { isActive: true },
      }),
    ]);
    if (!category?.isActive) {
      throw categoryUnavailable();
    }
    const unitKey = dto.unitKey ?? config.defaultUnitKey;
    if (!config.units.some((unit) => unit.key === unitKey)) {
      throw badRequest('UNIT_UNKNOWN', `Unknown unit: ${unitKey}`, 'unitKey');
    }

    try {
      const row = await db.$transaction(async (tx) => {
        const number = await this.counters.next(tx, access.businessId, 'product');
        const created = await tx.product.create({
          data: {
            businessId: access.businessId,
            code: formatCode(config.codePrefixes.product, number, PRODUCT_CODE_WIDTH),
            categoryId: dto.categoryId,
            nameEn: dto.nameEn,
            nameBn: dto.nameBn,
            unitKey,
            createdBy: actor.userId,
          },
          select,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'product.created',
            entityType: 'product',
            entityId: created.id,
            changes: {
              code: created.code,
              nameEn: created.nameEn,
            },
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

  /**
   * Plain fields (names, category, unit) need product.manage; (de)activation
   * needs product.deactivate and a reason (owner level by default). There is
   * no price to edit: the last purchase price is set by purchases only.
   */
  async update(access: BusinessAccess, id: string, dto: UpdateProductDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const current = await db.product.findUnique({ where: { id }, select });
    if (!current) {
      notFound('Product');
    }
    const before = toResponse(current);
    const changes = diff(
      { ...before, categoryId: current.categoryId },
      {
        categoryId: dto.categoryId,
        nameEn: dto.nameEn,
        nameBn: dto.nameBn,
        unitKey: dto.unitKey,
        isActive: dto.isActive,
      },
    );
    if (Object.keys(changes).length === 0) {
      throw badRequest('NOTHING_TO_CHANGE', 'Nothing to change');
    }

    let reason: string | undefined;
    if ('isActive' in changes) {
      requirePermission(access, 'product.deactivate');
      reason = requireReason(dto.reason);
    }
    if ('categoryId' in changes) {
      const category = await db.productCategory.findUnique({
        where: { id: dto.categoryId },
        select: { isActive: true },
      });
      if (!category?.isActive) {
        throw categoryUnavailable();
      }
    }
    if ('unitKey' in changes) {
      const config = await this.context.config(access.businessId);
      if (!config.units.some((unit) => unit.key === dto.unitKey)) {
        throw badRequest('UNIT_UNKNOWN', `Unknown unit: ${dto.unitKey ?? ''}`, 'unitKey');
      }
    }

    try {
      const row = await db.$transaction(async (tx) => {
        const updated = await tx.product.update({
          where: { id },
          data: {
            // Every change bumps the version, so pending change requests go stale.
            version: { increment: 1 },
            updatedBy: actor.userId,
            categoryId: dto.categoryId,
            nameEn: dto.nameEn,
            nameBn: dto.nameBn,
            unitKey: dto.unitKey,
            isActive: dto.isActive,
          },
          select,
        });
        await this.audit.record(
          {
            businessId: access.businessId,
            actorUserId: actor.userId,
            action: 'product.updated',
            entityType: 'product',
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

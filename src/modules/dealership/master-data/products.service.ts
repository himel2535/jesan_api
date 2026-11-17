import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { moneyString, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
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
  purchasePrice: true,
  defaultSalePrice: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  categoryId: true,
  // Same query, no N+1: the category name comes with every product.
  category: { select: { id: true, nameEn: true, nameBn: true } },
} as const;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof select }>;

const DUPLICATE = { name_en: 'A product with this name already exists' };

function toResponse(row: ProductRow) {
  return {
    id: row.id,
    code: row.code,
    category: row.category,
    nameEn: row.nameEn,
    nameBn: row.nameBn,
    unitKey: row.unitKey,
    purchasePrice: moneyString(row.purchasePrice),
    defaultSalePrice: moneyString(row.defaultSalePrice),
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
    if (dto.purchasePrice !== undefined) {
      requirePermission(access, 'product.cost.view');
    }
    const db = this.prisma.forBusiness(access.businessId);
    const [config, category] = await Promise.all([
      this.context.config(access.businessId),
      db.productCategory.findUnique({
        where: { id: dto.categoryId },
        select: { isActive: true },
      }),
    ]);
    if (!category?.isActive) {
      throw new BadRequestException('Category not found or inactive');
    }
    const unitKey = dto.unitKey ?? config.defaultUnitKey;
    if (!config.units.some((unit) => unit.key === unitKey)) {
      throw new BadRequestException(`Unknown unit: ${unitKey}`);
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
            purchasePrice: toDecimal(dto.purchasePrice ?? '0'),
            defaultSalePrice: toDecimal(dto.defaultSalePrice),
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
              purchasePrice: moneyString(created.purchasePrice),
              defaultSalePrice: moneyString(created.defaultSalePrice),
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
   * Plain fields (names, category, unit) need product.manage. Prices need
   * product.price.edit and (de)activation product.deactivate, both with a
   * reason; by default only the owner level holds them.
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
        purchasePrice: dto.purchasePrice && toDecimal(dto.purchasePrice).toFixed(2),
        defaultSalePrice: dto.defaultSalePrice && toDecimal(dto.defaultSalePrice).toFixed(2),
        isActive: dto.isActive,
      },
    );
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Nothing to change');
    }

    let reason: string | undefined;
    if ('purchasePrice' in changes) {
      requirePermission(access, 'product.cost.view');
    }
    if ('purchasePrice' in changes || 'defaultSalePrice' in changes) {
      requirePermission(access, 'product.price.edit');
      reason = requireReason(dto.reason);
    }
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
        throw new BadRequestException('Category not found or inactive');
      }
    }
    if ('unitKey' in changes) {
      const config = await this.context.config(access.businessId);
      if (!config.units.some((unit) => unit.key === dto.unitKey)) {
        throw new BadRequestException(`Unknown unit: ${dto.unitKey ?? ''}`);
      }
    }

    try {
      const row = await db.$transaction(async (tx) => {
        const updated = await tx.product.update({
          where: { id },
          data: {
            categoryId: dto.categoryId,
            nameEn: dto.nameEn,
            nameBn: dto.nameBn,
            unitKey: dto.unitKey,
            purchasePrice:
              dto.purchasePrice === undefined ? undefined : toDecimal(dto.purchasePrice),
            defaultSalePrice:
              dto.defaultSalePrice === undefined ? undefined : toDecimal(dto.defaultSalePrice),
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

import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../core/audit/audit.service';
import { fromDbDate, toDbDate, todayIn } from '../../../core/common/business-time';
import { moneyStringOrNull, toDecimal } from '../../../core/common/money';
import { BusinessAccess } from '../../../core/common/request-context';
import { PrismaService } from '../../../core/database/prisma.service';
import { badRequest, errorBody, notFoundError } from '../../../core/errors';
import { Actor, PAGE_SIZE } from '../master-data/master-data.common';
import { DealershipContext } from '../master-data/master-data.context';
import { fitsUnit } from '../purchases/purchases.service';
import { MovementQueryDto, StockAdjustmentDto, StockListQueryDto } from './dto/requests';
import { StockLedger, quantityString } from './stock-ledger';

const itemSelect = {
  id: true,
  code: true,
  nameEn: true,
  nameBn: true,
  unitKey: true,
  currentStock: true,
  isActive: true,
  lastPurchasePrice: true,
  lastPurchasedAt: true,
  // Same business by the composite foreign key; one query.
  category: { select: { id: true, nameEn: true, nameBn: true } },
} satisfies Prisma.ProductSelect;

type ItemRow = Prisma.ProductGetPayload<{ select: typeof itemSelect }>;

function stockItem(row: ItemRow) {
  return {
    id: row.id,
    code: row.code,
    nameEn: row.nameEn,
    nameBn: row.nameBn,
    unitKey: row.unitKey,
    category: row.category,
    currentStock: quantityString(row.currentStock),
    isActive: row.isActive,
    lastPurchasePrice: moneyStringOrNull(row.lastPurchasePrice),
    lastPurchasedAt: row.lastPurchasedAt?.toISOString() ?? null,
  };
}

const productNotFound = () => notFoundError('PRODUCT_NOT_FOUND', 'Product not found');

/** Stock on hand, its history, and hand adjustments (torn or found bags). */
@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: DealershipContext,
    private readonly ledger: StockLedger,
    private readonly audit: AuditService,
  ) {}

  async list(access: BusinessAccess, query: StockListQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.ProductWhereInput = {
      ...(query.active === 'all' ? {} : { isActive: query.active === 'true' }),
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
        select: itemSelect,
      }),
      db.product.count({ where }),
    ]);
    return { items: rows.map(stockItem), page: query.page, pageSize: PAGE_SIZE, total };
  }

  /** A product's stock history, newest first, with the balance after each movement. */
  async movements(access: BusinessAccess, productId: string, query: MovementQueryDto) {
    const db = this.prisma.forBusiness(access.businessId);
    const where: Prisma.StockMovementWhereInput = {
      productId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.from || query.to
        ? {
            movementDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lte: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [product, rows, total] = await Promise.all([
      db.product.findUnique({ where: { id: productId }, select: itemSelect }),
      db.stockMovement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          kind: true,
          quantity: true,
          balanceAfter: true,
          movementDate: true,
          sourceType: true,
          sourceId: true,
          reason: true,
          createdAt: true,
          creator: { select: { id: true, name: true } },
        },
      }),
      db.stockMovement.count({ where }),
    ]);
    if (!product) {
      throw productNotFound();
    }
    // Purchase numbers for this page in one query.
    const purchaseIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.sourceType === 'purchase' && row.sourceId ? [row.sourceId] : [],
        ),
      ),
    ];
    const purchases = purchaseIds.length
      ? await db.purchase.findMany({
          where: { id: { in: purchaseIds } },
          select: { id: true, code: true },
        })
      : [];
    const codeOf = new Map(purchases.map((purchase) => [purchase.id, purchase.code]));
    return {
      product: stockItem(product),
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        quantity: quantityString(row.quantity),
        balanceAfter: quantityString(row.balanceAfter),
        movementDate: fromDbDate(row.movementDate),
        source: {
          type: row.sourceType,
          id: row.sourceId,
          code: row.sourceId ? (codeOf.get(row.sourceId) ?? null) : null,
        },
        reason: row.reason,
        createdBy: row.creator,
        createdAt: row.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
    };
  }

  /**
   * A hand adjustment with a reason. Without stock.adjust.large, a person may
   * adjust one product by at most the daily limit in total (sum of the absolute
   * sizes of their adjustments today), so the limit cannot be dodged by
   * splitting; beyond it they send a change request.
   */
  async adjust(access: BusinessAccess, dto: StockAdjustmentDto, actor: Actor) {
    const db = this.prisma.forBusiness(access.businessId);
    const [config, product] = await Promise.all([
      this.context.config(access.businessId),
      db.product.findUnique({ where: { id: dto.productId }, select: { id: true, unitKey: true } }),
    ]);
    if (!product) {
      throw notFoundError('PRODUCT_NOT_FOUND', 'Product not found', 'productId');
    }
    const quantity = toDecimal(dto.quantity);
    const decimals = config.units.find((unit) => unit.key === product.unitKey)?.decimals ?? 0;
    if (!fitsUnit(quantity.abs(), decimals)) {
      throw badRequest(
        'QUANTITY_INVALID',
        'Quantity must not be zero and must fit the product’s unit',
        'quantity',
      );
    }
    const today = todayIn(config.timezone);

    await db.$transaction(async (tx) => {
      await this.ledger.lock(tx, access.businessId, [product.id]);
      if (!access.permissions.has('stock.adjust.large')) {
        const earlier = await tx.stockMovement.findMany({
          where: {
            productId: product.id,
            kind: 'adjustment',
            createdBy: actor.userId,
            movementDate: toDbDate(today),
          },
          select: { quantity: true },
        });
        const used = earlier.reduce(
          (sum, row) => sum.add(row.quantity.abs()),
          new Prisma.Decimal(0),
        );
        const limit = new Prisma.Decimal(config.stockAdjustmentLimit);
        if (used.add(quantity.abs()).greaterThan(limit)) {
          throw new ForbiddenException({
            ...errorBody(
              HttpStatus.FORBIDDEN,
              'ADJUSTMENT_APPROVAL_REQUIRED',
              'This adjustment is above your daily limit; send a change request instead',
              'quantity',
            ),
            details: { limit: quantityString(limit), usedToday: quantityString(used) },
          });
        }
      }
      const before = (
        await tx.product.findUniqueOrThrow({
          where: { id: product.id },
          select: { currentStock: true },
        })
      ).currentStock;
      await this.ledger.apply(
        tx,
        access.businessId,
        actor.userId,
        [
          {
            productId: product.id,
            quantity,
            kind: 'adjustment',
            movementDate: today,
            sourceType: 'adjustment',
            sourceId: null,
            reason: dto.reason,
          },
        ],
        () => 'quantity',
      );
      await this.audit.record(
        {
          businessId: access.businessId,
          actorUserId: actor.userId,
          action: 'stock.adjusted',
          entityType: 'product',
          entityId: product.id,
          changes: {
            quantity: quantityString(quantity),
            before: quantityString(before),
            after: quantityString(before.add(quantity)),
            reason: dto.reason,
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    const row = await db.product.findUniqueOrThrow({
      where: { id: product.id },
      select: itemSelect,
    });
    return stockItem(row);
  }
}
